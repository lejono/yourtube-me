/**
 * Kid activity functions: watches, likes, and search.
 * All functions take a better-sqlite3 Database as their first argument.
 */

const DEFAULT_SEARCH_LIMIT = 30;

/**
 * Record that a kid started watching a video.
 * Upserts: if the kid already has a watch record for this video,
 * updates the started_at timestamp.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string} videoId
 */
export function recordWatch(db, kidId, videoId) {
  db.prepare(`
    INSERT INTO watches (kid_id, video_id)
    VALUES (?, ?)
    ON CONFLICT(kid_id, video_id) DO UPDATE SET
      started_at = datetime('now')
  `).run(kidId, videoId);
}

/**
 * Get all video IDs this kid has watched.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {string[]}
 */
export function getWatchedVideoIds(db, kidId) {
  const rows = db.prepare(
    'SELECT video_id FROM watches WHERE kid_id = ?'
  ).all(kidId);
  return rows.map(r => r.video_id);
}

/**
 * Toggle a like for a video. If already liked, deletes it; otherwise inserts.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {{ video_id: string, title: string, channel_title: string }} opts
 * @returns {{ liked: boolean }}
 */
export function toggleLike(db, kidId, { video_id, title, channel_title }) {
  const existing = db.prepare(
    'SELECT id FROM likes WHERE kid_id = ? AND video_id = ?'
  ).get(kidId, video_id);

  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    return { liked: false };
  }

  db.prepare(`
    INSERT INTO likes (kid_id, video_id, title, channel_title)
    VALUES (?, ?, ?, ?)
  `).run(kidId, video_id, title, channel_title);
  return { liked: true };
}

/**
 * Get all video IDs this kid has liked.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {string[]}
 */
export function getLikedVideoIds(db, kidId) {
  const rows = db.prepare(
    'SELECT video_id FROM likes WHERE kid_id = ?'
  ).all(kidId);
  return rows.map(r => r.video_id);
}

/**
 * Search approved videos for a kid by title (case-insensitive LIKE).
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string} query
 * @param {number} [limit]
 * @returns {object[]}
 */
export function searchVideos(db, kidId, query, limit) {
  const maxRows = limit != null ? Number(limit) : DEFAULT_SEARCH_LIMIT;
  return db.prepare(`
    SELECT v.* FROM videos v
    WHERE v.kid_id = ? AND v.ai_approved = 1 AND v.title LIKE ?
      AND (v.channel_id = '' OR v.channel_id IN (
        SELECT channel_id FROM channels WHERE kid_id = v.kid_id AND status = 'approved'
      ))
    ORDER BY v.published_at DESC
    LIMIT ?
  `).all(kidId, `%${query}%`, maxRows);
}
