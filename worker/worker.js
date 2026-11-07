/**
 * YourTube worker — polls YouTube RSS, runs AI filter, pushes to server.
 *
 * Exports processKid() and _setDeps() for testing.
 * Auto-starts the main loop only when run directly.
 */

import { fetchRSS as _fetchRSSReal, resolveChannelBySearch as _resolveChannelBySearchReal } from './lib/rss.js';
import { classifyVideos as _classifyVideosReal } from './lib/filter.js';
import { fetchManifest as _fetchManifestReal, pushVideos as _pushVideosReal, pushChannels as _pushChannelsReal, markChannelsGenerated, setKidStatus as _setKidStatusReal, fetchFeedback as _fetchFeedbackReal, markFeedbackProcessed as _markFeedbackProcessedReal, fetchKidChannels as _fetchKidChannelsReal, rejectChannel as _rejectChannelReal } from './lib/server-client.js';
import { generateChannels as _generateChannelsReal, refineChannels as _refineChannelsReal, reviewChannelsAgainstGuidelines as _reviewChannelsReal } from './lib/channel-gen.js';
import { POLL_INTERVAL_MS, HEARTBEAT_DIR } from './config.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Errors are swallowed: liveness reporting must never take the worker down.
async function touchHeartbeat(name) {
  if (!HEARTBEAT_DIR) return;
  try {
    await writeFile(join(HEARTBEAT_DIR, `${name}.heartbeat`), new Date().toISOString() + '\n');
  } catch { /* ignore */ }
}

const FAST_LOOP_INTERVAL_MS = 30_000;
const SLOW_LOOP_INTERVAL_MS = 30 * 60 * 1000;
const MIN_RSS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOW_FEED_WATCHED_RATIO = 0.5;
// A feed that has not been topped up in this long is refreshed regardless of
// how much of it the kid has watched. Without this, a kid who half-abandons
// their feed is trapped: the watched-ratio trigger never fires, so the feed
// ages, and an ageing feed is exactly what stops them watching. Applies only
// to kids who have watched something — a feed nobody has ever opened is left
// alone rather than repeatedly re-filled at AI-classification cost.
const STALE_FEED_MS = 14 * 24 * 60 * 60 * 1000;

// --- Dependency injection for testing ---

let _deps = null;

/**
 * Override internal dependencies.
 * Pass null to restore real implementations.
 * @param {{ fetchRSS?: Function, classifyVideos?: Function, generateChannels?: Function,
 *           refineChannels?: Function, reviewChannelsAgainstGuidelines?: Function,
 *           fetchManifest?: Function, pushVideos?: Function,
 *           pushChannels?: Function, resolveChannelBySearch?: Function, setKidStatus?: Function,
 *           fetchFeedback?: Function, markFeedbackProcessed?: Function,
 *           fetchKidChannels?: Function, rejectChannel?: Function }|null} overrides
 */
export function _setDeps(overrides) {
  _deps = overrides;
}

function getFetchRSS() {
  return (_deps && _deps.fetchRSS) ? _deps.fetchRSS : _fetchRSSReal;
}

function getClassifyVideos() {
  return (_deps && _deps.classifyVideos) ? _deps.classifyVideos : _classifyVideosReal;
}

function getGenerateChannels() {
  return (_deps && _deps.generateChannels) ? _deps.generateChannels : _generateChannelsReal;
}

function getFetchManifest() {
  return (_deps && _deps.fetchManifest) ? _deps.fetchManifest : _fetchManifestReal;
}

function getPushVideos() {
  return (_deps && _deps.pushVideos) ? _deps.pushVideos : _pushVideosReal;
}

function getPushChannels() {
  return (_deps && _deps.pushChannels) ? _deps.pushChannels : _pushChannelsReal;
}

function getResolveChannelBySearch() {
  return (_deps && _deps.resolveChannelBySearch) ? _deps.resolveChannelBySearch : _resolveChannelBySearchReal;
}

function getSetKidStatus() {
  return (_deps && _deps.setKidStatus) ? _deps.setKidStatus : _setKidStatusReal;
}

function getRefineChannels() {
  return (_deps && _deps.refineChannels) ? _deps.refineChannels : _refineChannelsReal;
}

function getFetchFeedback() {
  return (_deps && _deps.fetchFeedback) ? _deps.fetchFeedback : _fetchFeedbackReal;
}

function getMarkFeedbackProcessed() {
  return (_deps && _deps.markFeedbackProcessed) ? _deps.markFeedbackProcessed : _markFeedbackProcessedReal;
}

function getFetchKidChannels() {
  return (_deps && _deps.fetchKidChannels) ? _deps.fetchKidChannels : _fetchKidChannelsReal;
}

function getReviewChannelsAgainstGuidelines() {
  return (_deps && _deps.reviewChannelsAgainstGuidelines) ? _deps.reviewChannelsAgainstGuidelines : _reviewChannelsReal;
}

function getRejectChannel() {
  return (_deps && _deps.rejectChannel) ? _deps.rejectChannel : _rejectChannelReal;
}

// --- Core logic ---

function parseManifestTime(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether a kid needs RSS polling and classification.
 * Initial fill is allowed; otherwise refresh at most daily, and then only if
 * the kid has watched at least half of their approved feed or the feed has
 * gone stale (see STALE_FEED_MS). Feeds nobody has ever watched are skipped.
 *
 * @param {object} kid
 * @param {number} nowMs
 * @returns {{ refresh: boolean, reason: string }}
 */
// Empty feeds whose refresh found nothing: retry after this long (in memory).
const EMPTY_FEED_RETRY_MS = 2 * 60 * 60 * 1000;
const emptyFeedRetryAt = new Map();

export function shouldRefreshKidFeed(kid, nowMs = Date.now()) {
  if (!kid.channels || kid.channels.length === 0) {
    return { refresh: false, reason: 'no approved channels' };
  }

  if (
    kid.approved_video_count == null ||
    kid.watched_video_count == null ||
    kid.unwatched_video_count == null
  ) {
    return { refresh: false, reason: 'manifest missing feed stats' };
  }

  const approvedCount = Number(kid.approved_video_count ?? 0);
  const watchedCount = Number(kid.watched_video_count ?? 0);
  const unwatchedCount = Number(kid.unwatched_video_count ?? Math.max(0, approvedCount - watchedCount));

  const lastPushedMs = parseManifestTime(kid.last_pushed_at);
  if (lastPushedMs != null && nowMs - lastPushedMs < MIN_RSS_REFRESH_INTERVAL_MS) {
    return { refresh: false, reason: 'refreshed less than 24h ago' };
  }

  if (approvedCount === 0) {
    return { refresh: true, reason: 'initial feed fill' };
  }

  if (watchedCount === 0 && !kid.last_watched_at) {
    return { refresh: false, reason: 'feed has not been used yet' };
  }

  if (lastPushedMs == null) {
    return { refresh: true, reason: 'feed in use but never topped up' };
  }

  const feedAgeMs = nowMs - lastPushedMs;
  if (feedAgeMs >= STALE_FEED_MS) {
    return {
      refresh: true,
      reason: `feed stale (last topped up ${Math.floor(feedAgeMs / 86400000)} days ago)`,
    };
  }

  const watchedRatio = watchedCount / approvedCount;
  if (watchedRatio >= LOW_FEED_WATCHED_RATIO) {
    return {
      refresh: true,
      reason: `feed low (${unwatchedCount}/${approvedCount} approved videos unwatched)`,
    };
  }

  return {
    refresh: false,
    reason: `feed healthy (${unwatchedCount}/${approvedCount} approved videos unwatched)`,
  };
}

/**
 * Process a single kid: fetch RSS for all channels, classify with AI, return
 * push-ready video array.
 *
 * @param {{ kid_id, kid_name, age, guidelines, channels }} kid
 * @returns {Promise<Array<{
 *   video_id, title, channel_id, channel_title, published_at,
 *   thumbnail, ai_approved, ai_reason
 * }>>}
 */
export async function processKid(kid, { rssCache } = {}) {
  const { channels = [], age, guidelines } = kid;

  if (channels.length === 0) return [];

  const fetchRSS = getFetchRSS();
  const classifyVideos = getClassifyVideos();

  function fetchChannel(ch) {
    if (!rssCache) {
      return fetchRSS(ch.channel_id).then(entries => ({ channel: ch, entries }));
    }

    if (!rssCache.has(ch.channel_id)) {
      rssCache.set(ch.channel_id, fetchRSS(ch.channel_id));
    }

    return rssCache.get(ch.channel_id).then(entries => ({ channel: ch, entries }));
  }

  // Fetch RSS for all channels in parallel; tolerate individual failures
  const settledResults = await Promise.allSettled(channels.map(fetchChannel));

  // Collect successful RSS entries, preserving which channel each came from
  const allEntries = [];
  for (const result of settledResults) {
    if (result.status === 'rejected') {
      console.warn('[worker] RSS fetch failed for a channel:', result.reason?.message);
      continue;
    }
    const { channel, entries } = result.value;
    for (const entry of entries) {
      allEntries.push({ ...entry, _channelId: channel.channel_id, _channelTitle: channel.title });
    }
  }

  if (allEntries.length === 0) return [];

  // Run AI filter
  const context = { age, guidelines };
  const decisions = await classifyVideos(allEntries, context);

  // Build decision map by videoId
  const decisionMap = new Map(decisions.map(d => [d.videoId, d]));

  // Map to push-ready format
  return allEntries.map(entry => {
    const decision = decisionMap.get(entry.videoId) || {
      approved: true,
      reason: 'unclassified — AI filter unavailable',
    };
    return {
      video_id: entry.videoId,
      title: entry.title,
      channel_id: entry._channelId,
      channel_title: entry.channelTitle || entry._channelTitle,
      published_at: entry.publishedAt,
      thumbnail: entry.thumbnail,
      ai_approved: decision.approved,
      ai_reason: decision.reason || '',
    };
  });
}

/**
 * Generate channels for a kid that has interests but no channels yet.
 * Sets status to 'generating', runs Opus, pushes pending channels, sets status to 'ready'.
 *
 * @param {{ kid_id, kid_name, age, interests, guidelines, channels_status }} kid
 * @returns {Promise<Array<{ channel_id, title }>>} resolved channels (for in-memory update)
 */
async function maybeGenerateChannels(kid) {
  const { kid_id, kid_name, interests = [], channels_generated, channels = [], channels_status } = kid;

  // Only generate if: has interests, not yet generated, and status is idle or generating.
  // 'generating' means the server already set this because custom interests need Opus.
  // channels.length may be > 0 from curated DB suggestions — that's fine,
  // Opus fills gaps for interests the curated DB doesn't cover.
  if (!interests.length || channels_generated || (channels_status !== 'idle' && channels_status !== 'generating')) {
    return [];
  }

  const setKidStatus = getSetKidStatus();
  const generateChannels = getGenerateChannels();
  const resolveChannelBySearch = getResolveChannelBySearch();
  const pushChannels = getPushChannels();

  // Signal that generation is starting (may already be 'generating' from server)
  if (channels_status !== 'generating') {
    try {
      await setKidStatus(kid_id, 'generating');
    } catch (err) {
      console.warn(`[worker] Failed to set status=generating for ${kid_name}:`, err.message);
    }
  }

  console.log(`[worker] Generating channels for ${kid_name} via Sonnet...`);

  let suggestions;
  try {
    suggestions = await generateChannels(kid);
  } catch (err) {
    console.warn(`[worker] Channel generation failed for ${kid_name}:`, err.message);
    suggestions = [];
  }

  if (!suggestions.length) {
    console.log(`[worker] No channel suggestions returned for ${kid_name}`);
  } else {
    console.log(`[worker] Got ${suggestions.length} channel suggestions for ${kid_name}`);
  }

  const resolved = [];
  for (const suggestion of suggestions) {
    try {
      const channelId = await resolveChannelBySearch(suggestion.searchQuery);
      if (!channelId) {
        console.warn(`[worker] Could not resolve channel: ${suggestion.name}`);
        continue;
      }
      // Build combined reason from description + reason fields
      const combinedReason = [suggestion.description, suggestion.reason]
        .filter(Boolean)
        .join(' | ') || null;
      await pushChannels(kid_id, {
        channel_id: channelId,
        title: suggestion.name,
        status: 'pending',
        reason: combinedReason,
      });
      resolved.push({ channel_id: channelId, title: suggestion.name });
      console.log(`[worker] Added pending channel: ${suggestion.name} (${channelId})`);
    } catch (err) {
      console.warn(`[worker] Failed to push channel ${suggestion.name}:`, err.message);
    }
  }

  // Signal that generation is complete
  try {
    await setKidStatus(kid_id, 'ready');
  } catch (err) {
    console.warn(`[worker] Failed to set status=ready for ${kid_name}:`, err.message);
  }

  return resolved;
}

/**
 * Process parent feedback for a kid with channels_status='refining'.
 * Fetches unprocessed feedback, calls Opus for refined suggestions,
 * pushes new pending channels, marks feedback processed, sets status='ready'.
 *
 * @param {{ kid_id, kid_name, age, interests, guidelines }} kid
 */
async function processFeedback(kid) {
  const { kid_id, kid_name } = kid;

  const fetchFeedback = getFetchFeedback();
  const markProcessed = getMarkFeedbackProcessed();
  const fetchKidChannels = getFetchKidChannels();
  const refineChannels = getRefineChannels();
  const resolveChannelBySearch = getResolveChannelBySearch();
  const pushChannels = getPushChannels();
  const setKidStatus = getSetKidStatus();

  let feedbackItems;
  try {
    feedbackItems = await fetchFeedback(kid_id);
  } catch (err) {
    console.warn(`[worker] Failed to fetch feedback for ${kid_name}:`, err.message);
    return;
  }

  if (!feedbackItems || feedbackItems.length === 0) {
    // Nothing to process — flip back to ready
    try { await setKidStatus(kid_id, 'ready'); } catch { /* ignore */ }
    return;
  }

  let currentChannels;
  try {
    currentChannels = await fetchKidChannels(kid_id);
  } catch (err) {
    console.warn(`[worker] Failed to fetch channels for ${kid_name}:`, err.message);
    currentChannels = [];
  }

  const feedbackMessages = feedbackItems.map(f => f.message);
  console.log(`[worker] Refining channels for ${kid_name} with ${feedbackMessages.length} feedback message(s)...`);

  let suggestions;
  try {
    suggestions = await refineChannels(kid, currentChannels, feedbackMessages);
  } catch (err) {
    console.warn(`[worker] refineChannels failed for ${kid_name}:`, err.message);
    suggestions = [];
  }

  if (suggestions.length === 0) {
    console.log(`[worker] No refined channel suggestions for ${kid_name}`);
  } else {
    console.log(`[worker] Got ${suggestions.length} refined channel suggestions for ${kid_name}`);
  }

  for (const suggestion of suggestions) {
    try {
      const channelId = await resolveChannelBySearch(suggestion.searchQuery);
      if (!channelId) {
        console.warn(`[worker] Could not resolve refined channel: ${suggestion.name}`);
        continue;
      }
      const combinedReason = [suggestion.description, suggestion.reason]
        .filter(Boolean)
        .join(' | ') || null;
      await pushChannels(kid_id, {
        channel_id: channelId,
        title: suggestion.name,
        status: 'pending',
        reason: combinedReason,
      });
      console.log(`[worker] Added refined pending channel: ${suggestion.name} (${channelId})`);
    } catch (err) {
      console.warn(`[worker] Failed to push refined channel ${suggestion.name}:`, err.message);
    }
  }

  // Mark all feedback items processed
  for (const item of feedbackItems) {
    try {
      await markProcessed(item.id);
    } catch (err) {
      console.warn(`[worker] Failed to mark feedback ${item.id} processed:`, err.message);
    }
  }

  // Signal ready
  try {
    await setKidStatus(kid_id, 'ready');
  } catch (err) {
    console.warn(`[worker] Failed to set status=ready after refining for ${kid_name}:`, err.message);
  }
}

/**
 * Review pending channels against parent guidelines with Opus.
 * Rejects channels deemed incompatible, then sets status to 'ready'.
 *
 * @param {{ kid_id, kid_name, age, interests, guidelines }} kid
 */
async function maybeReviewGuidelines(kid) {
  const { kid_id, kid_name, guidelines } = kid;

  const setKidStatus = getSetKidStatus();
  const fetchKidChannels = getFetchKidChannels();
  const reviewChannels = getReviewChannelsAgainstGuidelines();
  const rejectCh = getRejectChannel();

  // If no guidelines, just flip to ready
  if (!guidelines || !guidelines.trim()) {
    try { await setKidStatus(kid_id, 'ready'); } catch { /* ignore */ }
    return;
  }

  let channels;
  try {
    channels = await fetchKidChannels(kid_id);
  } catch (err) {
    console.warn(`[worker] Failed to fetch channels for guidelines review (${kid_name}):`, err.message);
    try { await setKidStatus(kid_id, 'ready'); } catch { /* ignore */ }
    return;
  }

  const pending = channels.filter(c => c.status === 'pending');
  if (pending.length === 0) {
    try { await setKidStatus(kid_id, 'ready'); } catch { /* ignore */ }
    return;
  }

  console.log(`[worker] Reviewing ${pending.length} channels against guidelines for ${kid_name}...`);

  let reviews;
  try {
    reviews = await reviewChannels(kid, pending);
  } catch (err) {
    console.warn(`[worker] Guidelines review failed for ${kid_name}:`, err.message);
    reviews = [];
  }

  // Build a map of title → review decision
  const reviewMap = new Map(reviews.map(r => [r.title, r]));

  for (const ch of pending) {
    const review = reviewMap.get(ch.title);
    if (review && !review.compatible) {
      try {
        await rejectCh(kid_id, ch.channel_id);
        console.log(`[worker] Rejected channel "${ch.title}" — ${review.reason}`);
      } catch (err) {
        console.warn(`[worker] Failed to reject channel ${ch.title}:`, err.message);
      }
    }
  }

  try {
    await setKidStatus(kid_id, 'ready');
  } catch (err) {
    console.warn(`[worker] Failed to set status=ready after guidelines review for ${kid_name}:`, err.message);
  }
}

/**
 * Fast loop: check for kids needing channel generation or feedback processing.
 * Runs every 30s.
 */
export async function runFastLoop() {
  let manifest;
  try {
    manifest = await getFetchManifest()();
  } catch (err) {
    console.error('[worker] Fast loop: failed to fetch manifest:', err.message);
    return;
  }
  // Written here, not at end-of-loop: a successful manifest fetch is exactly
  // the signal that network + worker key + server are all healthy, which is
  // what the 401-forever failure mode defeats.
  await touchHeartbeat('fast');

  for (const kid of manifest) {
    try {
      // Channel generation: needs interests, not yet generated, status idle or generating.
      // 'generating' means the server flagged custom interests that need Opus.
      // channels.length may be > 0 from curated DB — Opus fills the gaps.
      const needsGeneration =
        kid.interests?.length > 0 &&
        !kid.channels_generated &&
        (kid.channels_status === 'idle' || kid.channels_status === 'generating');

      if (needsGeneration) {
        await maybeGenerateChannels(kid);
      }

      // Guidelines review: curated channels need Opus review against guidelines
      if (kid.channels_status === 'reviewing') {
        await maybeReviewGuidelines(kid);
      }

      // Feedback refinement: parent has submitted feedback
      if (kid.channels_status === 'refining') {
        await processFeedback(kid);
      }
    } catch (err) {
      console.error(`[worker] Fast loop failed for ${kid.kid_name}:`, err.message);
    }
  }
}

/**
 * Slow loop: full RSS poll + AI filter for all kids with approved channels.
 * Runs every 30min.
 */
export async function runSlowLoop() {
  let manifest;
  try {
    manifest = await getFetchManifest()();
  } catch (err) {
    console.error('[worker] Slow loop: failed to fetch manifest:', err.message);
    return;
  }

  console.log(`[worker] Slow loop: processing ${manifest.length} kid(s)`);
  const rssCache = new Map();

  for (const kid of manifest) {
    const decision = shouldRefreshKidFeed(kid);
    if (!decision.refresh) {
      console.log(`[worker] Skipping ${kid.kid_name}: ${decision.reason}`);
      continue;
    }
    const retryAt = emptyFeedRetryAt.get(kid.kid_id);
    if (retryAt && Date.now() < retryAt) {
      console.log(`[worker] Skipping ${kid.kid_name}: empty feed, last attempt found nothing; retrying after ${new Date(retryAt).toISOString()}`);
      continue;
    }

    try {
      console.log(`[worker] Refreshing ${kid.kid_name}: ${decision.reason}`);
      const videos = await processKid(kid, { rssCache });
      const feedIsEmpty = Number(kid.approved_video_count ?? 0) === 0;
      if (videos.length === 0 && feedIsEmpty) {
        // Don't record this as a refresh (that would block retries for 24h
        // and leave the child with an empty feed). Retry in 2h instead;
        // a retry only re-reads public RSS, no Claude calls.
        emptyFeedRetryAt.set(kid.kid_id, Date.now() + EMPTY_FEED_RETRY_MS);
        console.log(`[worker] No videos found for ${kid.kid_name} (feed empty); will retry in 2h`);
        continue;
      }
      emptyFeedRetryAt.delete(kid.kid_id);
      await getPushVideos()(kid.kid_id, videos);
      if (videos.length > 0) {
        console.log(`[worker] Pushed ${videos.length} videos for ${kid.kid_name}`);
      } else {
        console.log(`[worker] Recorded empty refresh for ${kid.kid_name}`);
      }
    } catch (err) {
      console.error(`[worker] Slow loop failed for ${kid.kid_name}:`, err.message);
    }
  }
  // End of a completed pass (per-kid failures are caught above and don't
  // block it; a hung RSS fetch does — which is the point).
  await touchHeartbeat('slow');
}

/**
 * Run one full poll cycle (legacy): fetch manifest, process all kids, push results.
 * Kept for backwards compatibility.
 */
export async function runCycle() {
  await runFastLoop();
  await runSlowLoop();
}

// --- Main loop (only when run directly) ---

const isMain = process.argv[1] &&
  (process.argv[1] === new URL(import.meta.url).pathname);

if (isMain) {
  console.log('[worker] Starting YourTube worker');
  console.log(`[worker] Fast loop: every ${FAST_LOOP_INTERVAL_MS / 1000}s`);
  console.log(`[worker] Slow loop: every ${SLOW_LOOP_INTERVAL_MS / 1000}s`);

  // Run sequentially on startup: fast loop first (generates channels),
  // then slow loop (polls RSS for those channels)
  runFastLoop()
    .catch(err => console.error('[worker] Initial fast loop failed:', err.message))
    .then(() => runSlowLoop())
    .catch(err => console.error('[worker] Initial slow loop failed:', err.message));

  const fastTimer = setInterval(() => {
    runFastLoop().catch(err => console.error('[worker] Fast loop failed:', err.message));
  }, FAST_LOOP_INTERVAL_MS);

  const slowTimer = setInterval(() => {
    runSlowLoop().catch(err => console.error('[worker] Slow loop failed:', err.message));
  }, SLOW_LOOP_INTERVAL_MS);

  // Keep the process alive — systemd manages the lifecycle
}
