import { timingSafeEqual } from 'node:crypto';

/**
 * Authenticate a worker using constant-time key comparison.
 * @param {string} masterKey - The server's stored master key
 * @param {string} providedKey - The key provided in the request
 * @returns {boolean}
 */
export function authenticateWorker(masterKey, providedKey) {
  if (!masterKey || !providedKey) return false;
  try {
    const a = Buffer.from(masterKey, 'utf8');
    const b = Buffer.from(providedKey, 'utf8');
    // timingSafeEqual requires equal-length buffers; pad shorter to avoid timing leak on length
    if (a.length !== b.length) {
      // Still do a constant-time compare on the full master key against itself
      // to avoid a short-circuit timing leak, then return false
      timingSafeEqual(a, a);
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Build the worker manifest: all kids with their channels grouped, interests parsed.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{
 *   kid_id: string,
 *   kid_name: string,
 *   age: number|null,
 *   interests: string[],
 *   guidelines: string|null,
 *   channels_generated: number,
 *   family_id: string,
 *   last_pushed_at: string|null,
 *   approved_video_count: number,
 *   unwatched_video_count: number,
 *   watched_video_count: number,
 *   last_watched_at: string|null,
 *   channels: Array<{ channel_id: string, title: string, thumbnail: string|null }>
 * }>}
 */
export function getWorkerManifest(db) {
  const kids = db.prepare(`
    SELECT k.id AS kid_id, k.name AS kid_name, k.age, k.interests, k.guidelines,
           k.channels_generated, k.channels_status, k.family_id, k.last_pushed_at
    FROM kids k
    JOIN families f ON f.id = k.family_id
    ORDER BY k.created_at
  `).all();

  const channelsForKid = db.prepare(`
    SELECT channel_id, title, thumbnail
    FROM channels
    WHERE kid_id = ?
      AND status = 'approved'
    ORDER BY created_at
  `);

  const feedStatsForKid = db.prepare(`
    SELECT
      COUNT(v.video_id) AS approved_video_count,
      COALESCE(SUM(CASE WHEN w.video_id IS NULL THEN 1 ELSE 0 END), 0) AS unwatched_video_count,
      COALESCE(SUM(CASE WHEN w.video_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS watched_video_count,
      MAX(w.started_at) AS last_watched_at
    FROM videos v
    LEFT JOIN watches w ON w.kid_id = v.kid_id AND w.video_id = v.video_id
    WHERE v.kid_id = ?
      AND v.ai_approved = 1
      AND (v.channel_id = '' OR v.channel_id IN (
        SELECT channel_id FROM channels WHERE kid_id = v.kid_id AND status = 'approved'
      ))
  `);

  return kids.map(kid => {
    let interests = [];
    if (kid.interests) {
      try {
        interests = JSON.parse(kid.interests);
      } catch {
        interests = [];
      }
    }

    const channels = channelsForKid.all(kid.kid_id);
    const stats = feedStatsForKid.get(kid.kid_id);

    return {
      kid_id: kid.kid_id,
      kid_name: kid.kid_name,
      age: kid.age,
      interests,
      guidelines: kid.guidelines,
      channels_generated: kid.channels_generated,
      channels_status: kid.channels_status,
      family_id: kid.family_id,
      last_pushed_at: kid.last_pushed_at,
      approved_video_count: stats?.approved_video_count ?? 0,
      unwatched_video_count: stats?.unwatched_video_count ?? 0,
      watched_video_count: stats?.watched_video_count ?? 0,
      last_watched_at: stats?.last_watched_at ?? null,
      channels,
    };
  });
}
