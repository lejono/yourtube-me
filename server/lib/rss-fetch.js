/**
 * RSS fetching for immediate feed population when channels are created.
 *
 * Used by POST /api/kids when auto-suggesting channels from the curated DB.
 * Runs fire-and-forget -- errors are logged but never bubble up.
 */

import { upsertVideos } from './family-api.js';

// Allow tests to inject a fake fetch implementation
let _fetch = globalThis.fetch;

export function _setFetchForTesting(fn) {
  _fetch = fn ?? globalThis.fetch;
}

// --- XML helpers (regex-based, no parser dependency) ---

function decodeXMLEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<' + escaped + '>([^<]*)</' + escaped + '>');
  const m = xml.match(re);
  return m ? decodeXMLEntities(m[1]) : null;
}

function extractAttr(xml, tagName, attrName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<' + escaped + '[^>]*?\\s' + attrName + '="([^"]*)"', 'i');
  const m = xml.match(re);
  return m ? decodeXMLEntities(m[1]) : null;
}

/**
 * Parse YouTube RSS XML into an array of video entries.
 * @param {string} xml
 * @returns {Array<{videoId, title, channelTitle, publishedAt, thumbnail}>}
 */
export function parseRSSEntries(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const videoId = extractTag(block, 'yt:videoId');
    if (!videoId) continue;

    // channelTitle lives in <author><name>...</name></author>
    const authorBlock = block.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? '';
    const channelTitle = extractTag(authorBlock, 'name') || '';

    // Thumbnail from media:thumbnail url attribute; fallback to ytimg URL
    const thumbnail =
      extractAttr(block, 'media:thumbnail', 'url') ||
      'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';

    entries.push({
      videoId,
      title: extractTag(block, 'title') || '',
      channelTitle,
      publishedAt: extractTag(block, 'published') || '',
      thumbnail,
    });
  }

  return entries;
}

/**
 * Get video IDs that have been approved for any kid.
 * Returns a Map of video_id -> ai_reason from the approving kid.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} videoIds
 * @returns {Map<string, string>}
 */
function getExistingApprovals(db, videoIds, kidId) {
  if (videoIds.length === 0) return new Map();
  // Reuse only approvals made for a kid of the same age or younger, and only
  // when this kid has no parent guidelines (which may be stricter). Never
  // reuse fallback "unclassified" approvals.
  const kid = db.prepare('SELECT age, guidelines FROM kids WHERE id = ?').get(kidId);
  if (!kid || kid.age == null || (kid.guidelines && kid.guidelines.trim())) return new Map();
  const placeholders = videoIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT v.video_id, v.ai_reason
    FROM videos v
    JOIN kids k ON k.id = v.kid_id
    WHERE v.video_id IN (${placeholders}) AND v.ai_approved = 1
      AND v.ai_reason != 'Awaiting review'
      AND v.ai_reason NOT LIKE '%unclassified%'
      AND v.ai_reason NOT LIKE 'Previously reviewed:%'
      AND (k.guidelines IS NULL OR TRIM(k.guidelines) = '')
      AND k.age IS NOT NULL AND k.age <= ?
      AND v.kid_id != ?
      AND k.family_id = (SELECT family_id FROM kids WHERE id = ?)
  `).all(...videoIds, kid.age, kidId, kidId);
  return new Map(rows.map(r => [r.video_id, r.ai_reason]));
}

/**
 * Fetch YouTube RSS for a list of channels and insert videos for a kid.
 * Used for instant feed population when channels are auto-suggested from curated DB.
 * Runs fire-and-forget -- errors are logged but don't block.
 *
 * Videos already approved for a same-age-or-younger kid are approved for this
 * kid too (see getExistingApprovals for the exact rules).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {Array<{channel_id: string, title: string}>} channels
 */
export async function fetchAndInsertVideos(db, kidId, channels) {
  // Collect all entries across channels first, then batch-check approvals
  const allEntries = [];
  const entryChannelMap = new Map(); // videoId -> channel

  for (const ch of channels) {
    try {
      const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.channel_id;
      const res = await _fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const entries = parseRSSEntries(xml);
      for (const e of entries) {
        allEntries.push(e);
        entryChannelMap.set(e.videoId, ch);
      }
    } catch (err) {
      console.warn('[rss] Failed to fetch RSS for ' + ch.title + ':', err.message);
    }
  }

  if (allEntries.length === 0) return;

  // Check if any fetched video IDs are already approved for another kid
  const allVideoIds = allEntries.map(e => e.videoId);
  const approvals = getExistingApprovals(db, allVideoIds, kidId);

  const videos = allEntries.map(e => {
    const ch = entryChannelMap.get(e.videoId);
    const priorReason = approvals.get(e.videoId);
    return {
      video_id: e.videoId,
      title: e.title,
      channel_id: ch.channel_id,
      channel_title: ch.title,
      published_at: e.publishedAt,
      thumbnail: e.thumbnail,
      ai_approved: priorReason !== undefined,
      ai_reason: priorReason !== undefined
        ? 'Previously reviewed: ' + priorReason
        : 'Awaiting review',
    };
  });

  upsertVideos(db, kidId, videos);
}
