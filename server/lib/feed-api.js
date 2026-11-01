/**
 * Kid feed API — serves pre-filtered approved videos with channel list and kid name.
 */

import { getWatchedVideoIds, getLikedVideoIds } from './kid-activity.js';

const DEFAULT_LIMIT = 200;

/**
 * Round-robin interleave videos from different channels.
 * Groups by channel_id, then picks one from each channel in turn,
 * ordered by each channel's newest video first.
 */
function interleave(videos) {
  if (videos.length === 0) return videos;

  // Group by channel, preserving per-channel order (already sorted by published_at DESC)
  const buckets = new Map();
  for (const v of videos) {
    const key = v.channel_id || v.video_id; // curated videos have empty channel_id
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }

  // Sort channels by their newest video's published_at DESC
  const sorted = [...buckets.values()].sort((a, b) =>
    (b[0].published_at ?? '').localeCompare(a[0].published_at ?? '')
  );

  // Round-robin pick
  const result = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const bucket of sorted) {
      if (bucket.length > 0) {
        result.push(bucket.shift());
        remaining = true;
      }
    }
  }
  return result;
}

/**
 * Get the feed for a kid: approved videos, channel list, kid name,
 * watched video IDs, and liked video IDs.
 *
 * Videos are sorted: unwatched first (interleaved across channels by published_at DESC),
 * then watched (interleaved across channels by published_at DESC).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {{ channel?: string, limit?: number }} opts
 * @returns {{ videos: object[], channels: object[], kid_name: string, watched_video_ids: string[], liked_video_ids: string[] }}
 */
export function getKidFeed(db, kidId, { channel, limit } = {}) {
  const kidRow = db.prepare('SELECT name FROM kids WHERE id = ?').get(kidId);
  const kid_name = kidRow?.name ?? null;

  const channels = db.prepare(
    `SELECT * FROM channels WHERE kid_id = ? AND status = 'approved' ORDER BY created_at`
  ).all(kidId);

  const maxRows = limit != null ? Number(limit) : DEFAULT_LIMIT;

  // Only show videos from approved channels (or curated videos with empty channel_id)
  const approvedChannelFilter = `AND (v.channel_id = '' OR v.channel_id IN (
    SELECT channel_id FROM channels WHERE kid_id = v.kid_id AND status = 'approved'
  ))`;

  // Fetch unwatched videos first (up to limit), then all watched videos after
  const channelFilter = channel ? 'AND v.channel_id = ?' : '';
  const params = channel ? [kidId, channel, maxRows] : [kidId, maxRows];

  const unwatched = db.prepare(`
    SELECT v.*, 0 AS watched
    FROM videos v
    LEFT JOIN watches w ON w.kid_id = v.kid_id AND w.video_id = v.video_id
    WHERE v.kid_id = ? AND v.ai_approved = 1 ${channelFilter}
      ${approvedChannelFilter}
      AND w.video_id IS NULL
    ORDER BY v.published_at DESC
    LIMIT ?
  `).all(...params);

  const watchedParams = channel ? [kidId, channel] : [kidId];
  const watchedVids = db.prepare(`
    SELECT v.*, 1 AS watched
    FROM videos v
    INNER JOIN watches w ON w.kid_id = v.kid_id AND w.video_id = v.video_id
    WHERE v.kid_id = ? AND v.ai_approved = 1 ${channelFilter}
      ${approvedChannelFilter}
    ORDER BY v.published_at DESC
  `).all(...watchedParams);

  const videos = [...interleave(unwatched), ...interleave(watchedVids)];

  const watched_video_ids = getWatchedVideoIds(db, kidId);
  const liked_video_ids = getLikedVideoIds(db, kidId);

  return { videos, channels, kid_name, watched_video_ids, liked_video_ids };
}
