/**
 * Kid feed generation with weighted shuffle and background RSS polling.
 */

import { getChannels, getVideos, setVideos, getBlocked, getUserChannels } from './store.js';
import { VALID_USERS } from '../config.js';
import { fetchRSS } from './youtube.js';

let _pollTimer = null;
let _lastPollAt = null;

/**
 * Return the timestamp of the last successful RSS poll, or null if none.
 */
export function getLastPollAt() {
  return _lastPollAt;
}

/**
 * Compute recency weight for a video.
 * Half-life of 14 days: a 2-week-old video has half the weight of a brand new one.
 */
export function _computeWeight(publishedAt, now = Date.now()) {
  if (!publishedAt) return 0.01;
  const ageMs = now - new Date(publishedAt).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  return Math.pow(0.5, ageDays / 14);
}

/**
 * Weighted shuffle: items with higher weight appear earlier (on average).
 * Uses the standard key = random()^(1/weight) algorithm.
 */
function weightedShuffle(items, weights) {
  const paired = items.map((item, i) => ({
    item,
    key: Math.random() ** (1 / Math.max(weights[i], 1e-10)),
  }));
  paired.sort((a, b) => b.key - a.key);
  return paired.map(p => p.item);
}

/**
 * Generate the kid's video feed.
 * @param {Object} options
 * @param {string} [options.channel] - Filter to a single channel ID
 * @param {number} [options.limit=50] - Max videos to return
 * @param {Array} [options.userChannels] - Per-user channel list (if omitted, reads global channels.json)
 * @param {Object} [options.userBlocked] - Per-user blocked list (if omitted, reads global blocked.json)
 * @returns {Promise<Array>} Video objects with videoId, title, channelId, etc.
 */
export async function generateFeed(options = {}) {
  const { channel, limit = 50, userChannels, userBlocked } = options;

  const [channels, videos, blocked] = await Promise.all([
    userChannels !== undefined ? userChannels : getChannels(),
    getVideos(),
    userBlocked !== undefined ? userBlocked : getBlocked(),
  ]);

  // Approved channel IDs from channels.json
  const approvedIds = new Set(
    channels
      .filter(ch => ch.approved && !ch.blocked)
      .map(ch => ch.channelId)
  );

  // Blocked sets from blocked.json
  const blockedChannelIds = new Set(blocked.channels || []);
  const blockedVideoIds = new Set(blocked.videos || []);

  const now = Date.now();
  const eligible = [];

  for (const [videoId, video] of Object.entries(videos)) {
    if (!approvedIds.has(video.channelId)) continue;
    if (blockedChannelIds.has(video.channelId)) continue;
    if (blockedVideoIds.has(videoId)) continue;
    if (channel && video.channelId !== channel) continue;

    const thumbnail = video.thumbnail || video.thumbnails?.default?.url
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    eligible.push({ videoId, ...video, thumbnail });
  }

  if (eligible.length === 0) return [];

  const weights = eligible.map(v => _computeWeight(v.publishedAt, now));
  const shuffled = weightedShuffle(eligible, weights);

  return shuffled.slice(0, limit);
}

/**
 * Fetch latest videos from a channel's RSS feed and merge into videos.json.
 */
export async function refreshChannelVideos(channelId) {
  const entries = await fetchRSS(channelId);

  if (entries.length === 0) return { total: 0, added: 0 };

  const channels = await getChannels();
  const ch = channels.find(c => c.channelId === channelId);
  const channelTitle = ch?.title || '';

  const videos = await getVideos();

  let added = 0;
  for (const entry of entries) {
    const existing = videos[entry.videoId] || {};
    if (!videos[entry.videoId]) added++;

    videos[entry.videoId] = {
      ...existing,
      title: entry.title,
      channelId,
      channelTitle: channelTitle || existing.channelTitle || '',
      publishedAt: entry.published,
      thumbnails: {
        ...(existing.thumbnails || {}),
        default: { url: entry.thumbnail || existing.thumbnails?.default?.url || '' },
      },
    };
  }

  await setVideos(videos);
  return { total: entries.length, added };
}

/**
 * Refresh all approved channels via RSS (across all users).
 */
export async function refreshAllChannels() {
  // Collect approved channels from all users
  const allUserChannels = await Promise.all(
    VALID_USERS.map(u => getUserChannels(u))
  );
  const seen = new Set();
  const approved = [];
  for (const userChs of allUserChannels) {
    for (const ch of (userChs || [])) {
      if (ch.approved && !ch.blocked && !seen.has(ch.channelId)) {
        seen.add(ch.channelId);
        approved.push(ch);
      }
    }
  }

  const results = [];
  for (const ch of approved) {
    try {
      const result = await refreshChannelVideos(ch.channelId);
      results.push({ channelId: ch.channelId, ...result });
    } catch (err) {
      console.error(`RSS refresh failed for ${ch.channelId}: ${err.message}`);
      results.push({ channelId: ch.channelId, error: err.message });
    }
  }

  return results;
}

/**
 * Start background RSS polling.
 * @param {number} [intervalMs=1800000] - Poll interval (default 30 min)
 */
export function startPolling(intervalMs = 30 * 60 * 1000) {
  stopPolling();
  console.log(`Feed polling started (every ${Math.round(intervalMs / 1000)}s)`);

  // Initial refresh
  refreshAllChannels().then(() => {
    _lastPollAt = new Date().toISOString();
  }).catch(err => {
    console.error('Initial feed refresh failed:', err.message);
  });

  _pollTimer = setInterval(async () => {
    console.log('Polling approved channels...');
    try {
      const results = await refreshAllChannels();
      _lastPollAt = new Date().toISOString();
      const total = results.reduce((sum, r) => sum + (r.added || 0), 0);
      console.log(`Poll complete: ${results.length} channels, ${total} new videos`);
    } catch (err) {
      console.error('Feed poll error:', err.message);
    }
  }, intervalMs);

  // Don't let the timer keep the process alive
  if (_pollTimer.unref) _pollTimer.unref();
}

/**
 * Stop background RSS polling.
 */
export function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
