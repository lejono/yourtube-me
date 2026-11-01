/**
 * AI content filter — Claude-powered metadata-only video classification.
 *
 * Uses the Claude CLI (`claude -p --model haiku`) to classify videos based on
 * title, description, tags, channel name, and category. Decisions are cached
 * in ai-cache.json so each video is only classified once.
 *
 * Graceful degradation: every public function returns usable results (never
 * throws). If the Claude CLI is missing, times out, or returns garbage, videos
 * are marked "unclassified" and the feed is not blocked.
 */

import { execFile } from 'node:child_process';
import { getAICache, setAICache } from './store.js';
import { AI_FILTER_ENABLED } from '../config.js';
import { withClaudeUsageLog } from './ai-usage.js';

const CLASSIFY_TIMEOUT_MS = 60_000;
const BATCH_SIZE = 10;
const CLAUDE_MODEL = 'haiku';

// Allow tests to inject a fake executor. When a test executor is set, the
// AI_FILTER_ENABLED flag is ignored so tests can run without env var setup.
let _execForTesting = null;

/**
 * Replace the CLI executor used by classifyVideos.
 * Pass null to restore the real implementation.
 * @param {Function|null} fn - (prompt) => Promise<string>
 */
export function _setExecForTesting(fn) {
  _execForTesting = fn;
}

/**
 * Execute the Claude CLI and return stdout/stderr.
 * @param {string} prompt
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function executeClaude(prompt) {
  if (_execForTesting) {
    return Promise.resolve(_execForTesting(prompt)).then(stdout => ({ stdout, stderr: '' }));
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = execFile(
      'claude',
      ['-p', '--model', CLAUDE_MODEL, '--output-format', 'json'],
      { timeout: CLASSIFY_TIMEOUT_MS, maxBuffer: 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Execute Claude, log usage, and return result text.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callClaude(prompt) {
  const { stdout } = await withClaudeUsageLog({
    component: 'server',
    operation: 'filter.classify',
    model: CLAUDE_MODEL,
    prompt,
  }, () => executeClaude(prompt));

  // --output-format json wraps the result in {"result":"..."}
  try {
    const envelope = JSON.parse(stdout);
    return envelope.result ?? stdout;
  } catch {
    return stdout;
  }
}

/**
 * Build the classification prompt for a batch of videos.
 */
function buildPrompt(videos, context) {
  const { profile, guidelines, blockedChannels = [], blockedVideos = [] } = context;

  const guidelinesBlock = guidelines
    ? `## Parent Guidelines\n${guidelines}\n`
    : '';

  const profileBlock = profile
    ? `## Taste Profile\n${JSON.stringify(profile, null, 2)}\n`
    : '';

  const blockedBlock =
    blockedChannels.length || blockedVideos.length
      ? `## Blocked\nChannels: ${blockedChannels.join(', ') || 'none'}\nVideos: ${blockedVideos.join(', ') || 'none'}\n`
      : '';

  const videoList = videos.map(v => ({
    videoId: v.videoId,
    title: v.title,
    channelTitle: v.channelTitle || v.channel || '',
    description: (v.description || '').slice(0, 300),
    tags: (v.tags || []).slice(0, 10),
    categoryId: v.categoryId || '',
  }));

  const age = profile?.childAge;
  const ageLine = age ? `The viewer is ${age} years old. ` : '';

  return `You are a content filter for a child's YouTube feed. ${ageLine}Your job is to decide whether each video is appropriate for this child based ONLY on its metadata (title, description, tags, channel, category).

${guidelinesBlock}${profileBlock}${blockedBlock}
## Videos to classify
${JSON.stringify(videoList, null, 2)}

## Instructions
For each video, decide: approved (true/false) and give a short reason.
If a video's channel is in the blocked list, reject it.
${age ? `Reject videos clearly intended for older teens or adults (e.g. drug references, sexual content, graphic violence). Content should be suitable for a ${age}-year-old.\n` : ''}When in doubt, approve — false positives are worse than false negatives for a kid's feed.

Respond with ONLY a JSON array, no other text:
[{"videoId":"...","approved":true,"reason":"..."},...]`;
}

/**
 * Parse Claude's response into an array of decisions.
 * Returns null if unparseable.
 */
function parseResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;
    // Validate shape
    for (const item of parsed) {
      if (!item.videoId || typeof item.approved !== 'boolean') return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Mark all videos as unclassified — used as fallback on errors.
 */
function unclassifiedFallback(videos) {
  return videos.map(v => ({
    videoId: v.videoId,
    approved: true,
    reason: 'unclassified — AI filter unavailable',
  }));
}

/**
 * Batch classify videos via Claude CLI.
 *
 * @param {Array} videos - Video metadata objects (must have videoId)
 * @param {Object} context - { profile, guidelines, blockedChannels, blockedVideos }
 * @returns {Promise<Array<{videoId:string, approved:boolean, reason:string}>>}
 */
async function classifyBatch(videos, context) {
  const prompt = buildPrompt(videos, context);

  let raw;
  try {
    raw = await callClaude(prompt);
  } catch (err) {
    console.warn('[filter] Claude CLI call failed:', err.code || '', err.signal || '', err.message);
    return unclassifiedFallback(videos);
  }

  let decisions = parseResponse(raw);
  if (!decisions) {
    // Retry once
    console.warn('[filter] Failed to parse Claude response, retrying...');
    try {
      raw = await callClaude(prompt);
      decisions = parseResponse(raw);
    } catch (err) {
      console.warn('[filter] Retry failed:', err.message);
    }
  }

  if (!decisions) {
    console.warn('[filter] Giving up parsing — returning unclassified');
    return unclassifiedFallback(videos);
  }

  // Ensure every input video has a decision (Claude might skip some)
  const decisionMap = new Map(decisions.map(d => [d.videoId, d]));
  return videos.map(v =>
    decisionMap.get(v.videoId) || {
      videoId: v.videoId,
      approved: true,
      reason: 'unclassified — not in AI response',
    },
  );
}

export async function classifyVideos(videos, context) {
  if (!videos || videos.length === 0) return [];

  // Short-circuit when AI filtering is disabled and no test mock is active.
  // This avoids spamming the console with Claude CLI errors when the filter
  // is intentionally off (the default for fresh installs).
  if (!AI_FILTER_ENABLED && !_execForTesting) {
    return unclassifiedFallback(videos);
  }

  // Process in batches to avoid timeouts with large video sets
  const results = [];
  for (let i = 0; i < videos.length; i += BATCH_SIZE) {
    const batch = videos.slice(i, i + BATCH_SIZE);
    console.log(`[filter] Classifying batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(videos.length / BATCH_SIZE)} (${batch.length} videos)`);
    const batchResults = await classifyBatch(batch, context);
    results.push(...batchResults);
  }
  return results;
}

/**
 * Classify a single video. Convenience wrapper around classifyVideos.
 */
export async function classifyVideo(video, context) {
  const results = await classifyVideos([video], context);
  return results[0];
}

/**
 * Look up a cached decision for a video.
 * @returns {Promise<{approved:boolean, reason:string, timestamp:string}|null>}
 */
export async function getCachedDecision(videoId) {
  const cache = await getAICache();
  return cache[videoId] || null;
}

/**
 * Save a decision to the cache.
 */
export async function cacheDecision(videoId, decision) {
  const cache = await getAICache();
  cache[videoId] = {
    approved: decision.approved,
    reason: decision.reason || '',
    timestamp: new Date().toISOString(),
  };
  await setAICache(cache);
}

/**
 * Classify videos with caching: return cached decisions where available,
 * call Claude only for uncached videos, then cache the new results.
 *
 * @returns {Promise<Array<{videoId:string, approved:boolean, reason:string}>>}
 */
export async function classifyWithCache(videos, context) {
  if (!videos || videos.length === 0) return [];

  const cache = await getAICache();
  const cached = [];
  const uncached = [];

  for (const video of videos) {
    // Auto-reject YouTube age-restricted videos
    if (video.ageRestricted) {
      cached.push({ videoId: video.videoId, approved: false, reason: 'YouTube age-restricted content' });
      continue;
    }
    const hit = cache[video.videoId];
    if (hit) {
      cached.push({ videoId: video.videoId, approved: hit.approved, reason: hit.reason });
    } else {
      uncached.push(video);
    }
  }

  if (uncached.length === 0) return cached;

  const fresh = await classifyVideos(uncached, context);

  // Cache the new decisions
  const updatedCache = await getAICache();
  for (const decision of fresh) {
    updatedCache[decision.videoId] = {
      approved: decision.approved,
      reason: decision.reason || '',
      timestamp: new Date().toISOString(),
    };
  }
  await setAICache(updatedCache);

  // Return all decisions in original order
  const allDecisions = new Map([
    ...cached.map(d => [d.videoId, d]),
    ...fresh.map(d => [d.videoId, d]),
  ]);
  return videos.map(v => allDecisions.get(v.videoId));
}
