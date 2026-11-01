/**
 * Channel and video storage functions.
 * All functions take a better-sqlite3 Database as their first argument.
 */

/**
 * Add a channel for a kid.
 * Throws on duplicate (kid_id, channel_id) pair.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {{ channel_id: string, title: string, thumbnail?: string, status?: string, reason?: string, source?: string }} opts
 * @returns {{ id: number, kid_id: string, channel_id: string, title: string }}
 */
export function addChannel(db, kidId, { channel_id, title, thumbnail = null, status = 'approved', reason = null, source = 'manual' }) {
  const result = db.prepare(
    `INSERT INTO channels (kid_id, channel_id, title, thumbnail, status, reason, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(kidId, channel_id, title, thumbnail, status, reason, source);

  return { id: result.lastInsertRowid, kid_id: kidId, channel_id, title, thumbnail };
}

/**
 * List channels for a kid, optionally filtered by status.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {{ status?: string }} [opts]
 * @returns {object[]}
 */
export function listChannels(db, kidId, { status } = {}) {
  if (status != null) {
    return db.prepare('SELECT * FROM channels WHERE kid_id = ? AND status = ?').all(kidId, status);
  }
  return db.prepare('SELECT * FROM channels WHERE kid_id = ?').all(kidId);
}

/**
 * Remove a channel for a kid, also deleting its associated videos.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string} channelId
 */
export function removeChannel(db, kidId, channelId) {
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM videos WHERE kid_id = ? AND channel_id = ?').run(kidId, channelId);
    db.prepare('DELETE FROM channels WHERE kid_id = ? AND channel_id = ?').run(kidId, channelId);
  });
  remove();
}

/**
 * Add a channel for a kid with status='pending' and source='opus'.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {{ channel_id: string, title: string, reason?: string, thumbnail?: string }} opts
 * @returns {{ id: number, kid_id: string, channel_id: string, title: string }}
 */
export function addPendingChannel(db, kidId, { channel_id, title, reason = null, thumbnail = null }) {
  const result = db.prepare(
    `INSERT INTO channels (kid_id, channel_id, title, thumbnail, status, reason, source)
     VALUES (?, ?, ?, ?, 'pending', ?, 'opus')`
  ).run(kidId, channel_id, title, thumbnail, reason);

  return { id: result.lastInsertRowid, kid_id: kidId, channel_id, title, thumbnail };
}

/**
 * Set a channel's status to 'approved'.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string} channelId
 */
export function approveChannel(db, kidId, channelId) {
  db.prepare(
    `UPDATE channels SET status = 'approved' WHERE kid_id = ? AND channel_id = ?`
  ).run(kidId, channelId);
}

/**
 * Set a channel's status to 'rejected'.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string} channelId
 */
export function rejectChannel(db, kidId, channelId) {
  db.prepare(
    `UPDATE channels SET status = 'rejected' WHERE kid_id = ? AND channel_id = ?`
  ).run(kidId, channelId);
}

/**
 * Get all channels with status='pending' for a kid.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {object[]}
 */
export function getPendingChannels(db, kidId) {
  return db.prepare(
    `SELECT * FROM channels WHERE kid_id = ? AND status = 'pending' ORDER BY created_at`
  ).all(kidId);
}

/**
 * Add a feedback message for a kid.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string} message
 * @returns {{ id: number, kid_id: string, message: string, processed: number }}
 */
export function addFeedback(db, kidId, message) {
  const result = db.prepare(
    `INSERT INTO feedback (kid_id, message) VALUES (?, ?)`
  ).run(kidId, message);

  return { id: result.lastInsertRowid, kid_id: kidId, message, processed: 0 };
}

/**
 * Get all unprocessed feedback rows for a kid.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {object[]}
 */
export function getUnprocessedFeedback(db, kidId) {
  return db.prepare(
    `SELECT * FROM feedback WHERE kid_id = ? AND processed = 0 ORDER BY created_at`
  ).all(kidId);
}

/**
 * Mark a feedback row as processed.
 * @param {import('better-sqlite3').Database} db
 * @param {number} feedbackId
 */
export function markFeedbackProcessed(db, feedbackId) {
  db.prepare(
    `UPDATE feedback SET processed = 1 WHERE id = ?`
  ).run(feedbackId);
}

/**
 * Set the channels_status for a kid.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {'idle'|'generating'|'ready'|'refining'} status
 */
export function setKidChannelsStatus(db, kidId, status) {
  db.prepare(
    `UPDATE kids SET channels_status = ? WHERE id = ?`
  ).run(status, kidId);
}

/**
 * Get the current channels_status for a kid.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {string}
 */
export function getKidChannelsStatus(db, kidId) {
  const row = db.prepare(`SELECT channels_status FROM kids WHERE id = ?`).get(kidId);
  return row?.channels_status ?? 'idle';
}

/**
 * Upsert a batch of videos for a kid.
 * Inserts new rows; on conflict (kid_id, video_id) updates all fields.
 * Also updates last_pushed_at on the kid record.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {Array<{
 *   video_id: string,
 *   title: string,
 *   channel_id: string,
 *   channel_title: string,
 *   published_at: string|null,
 *   thumbnail: string|null,
 *   ai_approved: number,
 *   ai_reason: string|null
 * }>} videos
 */
export function upsertVideos(db, kidId, videos) {
  const upsert = db.transaction((vids) => {
    const stmt = db.prepare(`
      INSERT INTO videos (kid_id, video_id, title, channel_id, channel_title, published_at, thumbnail, ai_approved, ai_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kid_id, video_id) DO UPDATE SET
        title = excluded.title,
        channel_id = excluded.channel_id,
        channel_title = excluded.channel_title,
        published_at = excluded.published_at,
        thumbnail = excluded.thumbnail,
        ai_approved = CASE
          WHEN EXISTS (SELECT 1 FROM parent_ratings pr
                       WHERE pr.kid_id = videos.kid_id AND pr.video_id = videos.video_id AND pr.rating = -1)
          THEN 0 ELSE excluded.ai_approved END,
        ai_reason = excluded.ai_reason,
        filtered_at = datetime('now')
    `);

    for (const v of vids) {
      stmt.run(kidId, v.video_id, v.title, v.channel_id, v.channel_title, v.published_at ?? null, v.thumbnail ?? null, v.ai_approved ? 1 : 0, v.ai_reason ?? null);
    }

    db.prepare(`UPDATE kids SET last_pushed_at = datetime('now') WHERE id = ?`).run(kidId);
  });

  upsert(videos);
}

/**
 * Get all approved videos for a kid, sorted by published_at DESC.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {object[]}
 */
export function getApprovedVideos(db, kidId) {
  return db.prepare(
    `SELECT * FROM videos
     WHERE kid_id = ? AND ai_approved = 1
     ORDER BY published_at DESC`
  ).all(kidId);
}

/**
 * Find curated channels that match a child's interests and age.
 *
 * Queries curated_channels for rows whose age range includes the given age,
 * then filters to those whose interests JSON array overlaps with the requested
 * interests list. Results are sorted by number of overlapping interests
 * (descending — best match first), capped at 20.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} interests - Interest tags to match against (e.g. ['gaming', 'science'])
 * @param {number} age - Child's age in years
 * @returns {Array<{
 *   id: number,
 *   channel_id: string,
 *   title: string,
 *   description: string|null,
 *   interests: string[],
 *   age_min: number,
 *   age_max: number,
 *   quality: string,
 *   source: string|null,
 *   created_at: string,
 *   match_count: number
 * }>}
 */
export function getCuratedChannels(db, interests, age) {
  const candidates = db.prepare(
    `SELECT * FROM curated_channels WHERE age_min <= ? AND age_max >= ? AND channel_id NOT LIKE 'UNRESOLVED%'`
  ).all(age, age);

  const interestSet = new Set(interests);

  const scored = [];
  for (const row of candidates) {
    const rowInterests = JSON.parse(row.interests);
    const matchCount = rowInterests.filter(i => interestSet.has(i)).length;
    if (matchCount > 0) {
      scored.push({ ...row, interests: rowInterests, match_count: matchCount });
    }
  }

  // Sort by interest match count (primary), then age fit (secondary).
  // Age fit: prefer channels where the kid's age is near the middle of the range.
  // Score 0.0 (edge) to 1.0 (center) — used only as a tiebreaker.
  scored.sort((a, b) => {
    if (b.match_count !== a.match_count) return b.match_count - a.match_count;
    const fitA = ageFit(age, a.age_min, a.age_max);
    const fitB = ageFit(age, b.age_min, b.age_max);
    return fitB - fitA;
  });
  return scored.slice(0, 20);
}

/**
 * How well does the kid's age fit this channel's range?
 * Returns 0.0 (at the edge) to 1.0 (at the center).
 */
function ageFit(age, ageMin, ageMax) {
  const range = ageMax - ageMin;
  if (range === 0) return 1;
  const mid = (ageMin + ageMax) / 2;
  const dist = Math.abs(age - mid);
  return 1 - dist / (range / 2);
}

/**
 * Find curated videos that match a child's interests and age.
 *
 * Queries curated_videos for rows whose age range includes the given age,
 * then filters to those whose interests JSON array overlaps with the requested
 * interests list. Results are sorted by number of overlapping interests
 * (descending), capped at 50.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} interests - Interest tags to match against
 * @param {number} age - Child's age in years
 * @returns {Array<object>}
 */
export function getCuratedVideos(db, interests, age) {
  const candidates = db.prepare(
    `SELECT * FROM curated_videos WHERE age_min <= ? AND age_max >= ?`
  ).all(age, age);

  const interestSet = new Set(interests);

  const scored = [];
  for (const row of candidates) {
    const rowInterests = JSON.parse(row.interests);
    const matchCount = rowInterests.filter(i => interestSet.has(i)).length;
    if (matchCount > 0) {
      scored.push({ ...row, interests: rowInterests, match_count: matchCount });
    }
  }

  scored.sort((a, b) => b.match_count - a.match_count);
  return scored.slice(0, 50);
}

/**
 * Inject matching curated videos into a kid's feed as pre-approved.
 *
 * Queries curated_videos for rows matching the given interests and age,
 * then upserts them into the videos table for the given kid with
 * ai_approved=1 and ai_reason='Hand-picked'.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string[]} interests
 * @param {number} age
 * @returns {number} Number of videos injected
 */
export function injectCuratedVideos(db, kidId, interests, age) {
  const curated = getCuratedVideos(db, interests, age);
  if (curated.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT INTO videos (kid_id, video_id, title, channel_id, channel_title, published_at, thumbnail, ai_approved, ai_reason)
    VALUES (?, ?, ?, ?, ?, datetime('now'), NULL, 1, 'Hand-picked')
    ON CONFLICT(kid_id, video_id) DO UPDATE SET
      ai_approved = 1,
      ai_reason = 'Hand-picked',
      filtered_at = datetime('now')
  `);

  const inject = db.transaction((videos) => {
    for (const v of videos) {
      stmt.run(kidId, v.video_id, v.title, '', v.channel_title ?? '');
    }
  });

  inject(curated);
  return curated.length;
}

/**
 * Upsert a parent rating for a video on a kid's feed.
 * If rating is -1 (thumbs down), also sets ai_approved=0 on the video
 * for this kid, removing it from the feed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {string} videoId
 * @param {1|-1} rating
 */
export function rateVideo(db, kidId, videoId, rating) {
  const upsert = db.transaction(() => {
    db.prepare(`
      INSERT INTO parent_ratings (kid_id, video_id, rating)
      VALUES (?, ?, ?)
      ON CONFLICT(kid_id, video_id) DO UPDATE SET
        rating = excluded.rating,
        created_at = datetime('now')
    `).run(kidId, videoId, rating);

    if (rating === -1) {
      db.prepare(
        `UPDATE videos SET ai_approved = 0 WHERE kid_id = ? AND video_id = ?`
      ).run(kidId, videoId);
    }
  });

  upsert();
}

/**
 * Get all parent ratings for a kid as a Map of video_id -> rating.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {Map<string, number>}
 */
export function getParentRatings(db, kidId) {
  const rows = db.prepare(
    'SELECT video_id, rating FROM parent_ratings WHERE kid_id = ?'
  ).all(kidId);

  const map = new Map();
  for (const row of rows) {
    map.set(row.video_id, row.rating);
  }
  return map;
}

/**
 * Get all channels joined with kid and family info, for the worker manifest.
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
export function getAllChannelsWithKidInfo(db) {
  return db.prepare(`
    SELECT
      ch.id,
      ch.kid_id,
      ch.channel_id,
      ch.title,
      ch.thumbnail,
      ch.approved,
      k.name AS kid_name,
      k.age AS kid_age,
      k.interests,
      k.guidelines,
      k.channels_generated,
      k.family_id
    FROM channels ch
    JOIN kids k ON k.id = ch.kid_id
    JOIN families f ON f.id = k.family_id
  `).all();
}
