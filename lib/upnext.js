/**
 * Up Next engine — assembles safe "Up Next" video picks when a kid starts watching.
 *
 * Multi-source fallback chain:
 *   1. Cached vetted results for the current video
 *   2. Scraper results (YouTube related-video sidebar)
 *   3. YouTube API search (quota-guarded, only if candidate pool is weak)
 *   4. Same-channel videos + approved-channel backfill
 *
 * Background vetting is fire-and-forget: kick off with vetUpNext(videoId),
 * then retrieve results with getUpNext(videoId). The endpoint always returns
 * something safe — backfill from approved channels is the last resort.
 */

import {
  getUpNextCache, setUpNextCache,
  getVideos, getChannels, getBlocked,
  getConfig, getProfile, getTokens,
} from './store.js';
import { classifyWithCache } from './filter.js';
import { scrapeRelatedVideos, isAvailable as isScraperAvailable } from './scraper.js';
import { searchVideos, isQuotaAvailable } from './youtube.js';
import { generateFeed } from './feed.js';

const VET_TIMEOUT_MS = 30_000;
const MIN_PICKS_BEFORE_SEARCH = 3;
const MAX_PICKS = 8;

// --- In-memory active vetting jobs (dedup concurrent requests) ---

const _activeJobs = new Map();

// --- Testing injection points ---

let _scrapeForTesting = null;
let _searchForTesting = null;

export function _setScraperForTesting(fn) {
  _scrapeForTesting = fn;
}

export function _setSearchForTesting(fn) {
  _searchForTesting = fn;
}

export function _getActiveJobs() {
  return _activeJobs;
}

// --- Public API ---

/**
 * Get the current Up Next picks for a video.
 *
 * Returns cached vetted results if available, otherwise falls back to
 * approved-channel backfill. Never throws.
 *
 * @param {string} videoId
 * @returns {Promise<{picks: Array, complete: boolean, source: string}>}
 */
export async function getUpNext(videoId) {
  try {
    // Check cache first
    const cache = await getUpNextCache();
    const cached = cache[videoId];

    if (cached?.picks?.length > 0) {
      const filtered = await filterBlocked(cached.picks);
      if (filtered.length > 0) {
        return { picks: filtered.slice(0, MAX_PICKS), complete: true, source: 'cache' };
      }
    }

    // If vetting is in progress, return backfill as partial results
    const isVetting = _activeJobs.has(videoId);
    const backfill = await getBackfillPicks(videoId);

    return {
      picks: backfill.slice(0, MAX_PICKS),
      complete: !isVetting,
      source: isVetting ? 'backfill-pending' : 'backfill',
    };
  } catch (err) {
    console.warn('[upnext] getUpNext error:', err.message);
    return { picks: [], complete: true, source: 'error' };
  }
}

/**
 * Start background vetting for a video.
 * Deduplicates concurrent requests for the same video.
 *
 * @param {string} videoId
 */
export async function vetUpNext(videoId) {
  // Dedup: if already vetting this video, return existing promise
  if (_activeJobs.has(videoId)) {
    return _activeJobs.get(videoId).promise;
  }

  // Register the job synchronously to prevent races between
  // concurrent calls (the cache check below is async).
  const jobPromise = (async () => {
    // Check cache — skip if fresh results exist
    const cache = await getUpNextCache();
    if (cache[videoId]?.picks?.length > 0) {
      return;
    }

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('vetting timeout')), VET_TIMEOUT_MS)
    );

    try {
      await Promise.race([_runVetting(videoId), timeout]);
    } catch (err) {
      console.warn(`[upnext] vetting failed for ${videoId}:`, err.message);
    }
  })();

  _activeJobs.set(videoId, { promise: jobPromise, startedAt: Date.now() });

  try {
    await jobPromise;
  } finally {
    _activeJobs.delete(videoId);
  }
}

// --- Core vetting pipeline ---

async function _runVetting(videoId) {
  const [videos, blocked, config, profile] = await Promise.all([
    getVideos(),
    getBlocked(),
    getConfig(),
    getProfile(),
  ]);

  const currentVideo = videos[videoId] || null;
  const blockedChannelIds = new Set(blocked.channels || []);
  const blockedVideoIds = new Set(blocked.videos || []);

  // Gather candidates from all sources
  const candidates = await gatherCandidates(videoId, currentVideo, {
    blockedChannelIds,
    blockedVideoIds,
  });

  if (candidates.length === 0) {
    return; // Nothing to vet — rely on backfill
  }

  // AI filter pass
  const context = {
    profile,
    guidelines: config.guidelines || '',
    blockedChannels: blocked.channels || [],
    blockedVideos: blocked.videos || [],
  };

  const decisions = await classifyWithCache(candidates, context);

  // Keep only approved, non-blocked picks
  const approved = [];
  for (const decision of decisions) {
    if (!decision.approved) continue;
    if (blockedVideoIds.has(decision.videoId)) continue;

    const video = candidates.find(c => c.videoId === decision.videoId);
    if (!video) continue;
    if (blockedChannelIds.has(video.channelId)) continue;
    if (decision.videoId === videoId) continue; // exclude current video

    approved.push({
      videoId: decision.videoId,
      title: video.title,
      channelId: video.channelId,
      channelTitle: video.channelTitle || '',
      thumbnails: video.thumbnails || {},
      publishedAt: video.publishedAt || '',
      source: video._source || 'unknown',
    });
  }

  // Save to cache
  const cache = await getUpNextCache();
  cache[videoId] = {
    picks: approved.slice(0, MAX_PICKS),
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
  };
  await setUpNextCache(cache);
}

// --- Candidate gathering ---

/**
 * Gather candidate videos from multiple sources.
 * Each source is best-effort — failures don't break the chain.
 */
export async function gatherCandidates(videoId, currentVideo, { blockedChannelIds, blockedVideoIds }) {
  const candidateMap = new Map();

  function addCandidate(video, source) {
    if (!video.videoId || video.videoId === videoId) return;
    if (blockedVideoIds.has(video.videoId)) return;
    if (video.channelId && blockedChannelIds.has(video.channelId)) return;
    if (!candidateMap.has(video.videoId)) {
      candidateMap.set(video.videoId, { ...video, _source: source });
    }
  }

  // Source 1: Scraper (related videos sidebar)
  try {
    let scraped;
    if (_scrapeForTesting) {
      scraped = await _scrapeForTesting(videoId);
    } else if (await isScraperAvailable()) {
      scraped = await scrapeRelatedVideos(videoId);
    }
    if (scraped) {
      for (const item of scraped) {
        addCandidate({
          videoId: item.id,
          title: item.title,
          channelId: '',
          channelTitle: item.channel || '',
          thumbnails: item.thumbnail ? { default: { url: item.thumbnail } } : {},
        }, 'scraper');
      }
    }
  } catch (err) {
    console.warn('[upnext] scraper failed:', err.message);
  }

  // Source 2: YouTube API search (quota-guarded, only if pool is weak)
  if (candidateMap.size < MIN_PICKS_BEFORE_SEARCH && currentVideo?.title) {
    try {
      let searchResults;
      if (_searchForTesting) {
        searchResults = await _searchForTesting(currentVideo.title);
      } else {
        const tokens = await getTokens();
        if (tokens?.access_token && isQuotaAvailable(100)) {
          searchResults = await searchVideos(
            currentVideo.title,
            tokens.access_token,
            { maxResults: 10, safeSearch: 'strict' },
          );
        }
      }
      if (searchResults) {
        for (const item of searchResults) {
          addCandidate({
            videoId: item.videoId,
            title: item.title,
            channelId: item.channelId || '',
            channelTitle: item.channelTitle || '',
            thumbnails: item.thumbnails || (item.thumbnail ? { default: { url: item.thumbnail } } : {}),
            publishedAt: item.publishedAt || '',
          }, 'search');
        }
      }
    } catch (err) {
      console.warn('[upnext] search failed:', err.message);
    }
  }

  // Source 3: Same-channel videos (always available if we have the channel)
  if (currentVideo?.channelId) {
    try {
      const allVideos = await getVideos();
      for (const [vid, meta] of Object.entries(allVideos)) {
        addCandidate({ videoId: vid, ...meta }, 'same-channel');
      }
    } catch (err) {
      console.warn('[upnext] same-channel lookup failed:', err.message);
    }
  }

  return Array.from(candidateMap.values());
}

// --- Helpers ---

/**
 * Get backfill picks from the approved-channel feed.
 * This is the guaranteed-safe fallback that always returns something
 * (as long as there are any approved channels with videos).
 */
async function getBackfillPicks(videoId) {
  try {
    const feed = await generateFeed({ limit: MAX_PICKS + 1 });
    return feed
      .filter(v => v.videoId !== videoId)
      .slice(0, MAX_PICKS);
  } catch (err) {
    console.warn('[upnext] backfill failed:', err.message);
    return [];
  }
}

/**
 * Filter out blocked content from a picks list.
 */
async function filterBlocked(picks) {
  const blocked = await getBlocked();
  const blockedChannelIds = new Set(blocked.channels || []);
  const blockedVideoIds = new Set(blocked.videos || []);

  return picks.filter(p =>
    !blockedVideoIds.has(p.videoId) &&
    !(p.channelId && blockedChannelIds.has(p.channelId))
  );
}
