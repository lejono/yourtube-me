/**
 * Operator dashboard data: funnel from visit to a child liking videos.
 * Children's names are never included; only ages and counts.
 */
import { getStats } from './stats.js';
import { getSignupStatus } from './signup-cap.js';

let workerLastSeen = null;
export function markWorkerSeen() { workerLastSeen = new Date().toISOString(); }

export function markKidDeviceSetup(db, kidId) {
  db.prepare("UPDATE kids SET device_setup_at = COALESCE(device_setup_at, datetime('now')), last_seen_at = datetime('now') WHERE id = ?").run(kidId);
}

/** Update last_seen_at at most every 5 minutes per kid. */
export function markKidSeen(db, kidId) {
  db.prepare(`
    UPDATE kids SET last_seen_at = datetime('now')
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))
  `).run(kidId);
}

function kidSummary(db, k) {
  const channelRows = db.prepare('SELECT status, COUNT(*) AS n FROM channels WHERE kid_id = ? GROUP BY status').all(k.id);
  const channels = { approved: 0, pending: 0, rejected: 0 };
  for (const r of channelRows) channels[r.status] = r.n;

  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const videos_available = one(`
    SELECT COUNT(*) AS n FROM videos v
    WHERE v.kid_id = ? AND v.ai_approved = 1
      AND (v.channel_id = '' OR v.channel_id IN (SELECT channel_id FROM channels WHERE kid_id = v.kid_id AND status = 'approved'))
  `, k.id).n;
  const pendingWhere = "(COALESCE(ai_reason, '') = 'Awaiting review' OR COALESCE(ai_reason, '') LIKE 'unclassified%')";
  const videos_pending = one(`SELECT COUNT(*) AS n FROM videos WHERE kid_id = ? AND ai_approved = 0 AND ${pendingWhere}`, k.id).n;
  const videos_blocked = one(`SELECT COUNT(*) AS n FROM videos WHERE kid_id = ? AND ai_approved = 0 AND NOT ${pendingWhere}`, k.id).n;
  const w = one("SELECT COUNT(*) AS n, MAX(started_at) AS last, SUM(started_at >= datetime('now','-7 days')) AS week FROM watches WHERE kid_id = ?", k.id);
  const likes = one('SELECT COUNT(*) AS n FROM likes WHERE kid_id = ?', k.id).n;
  const ratings = one('SELECT SUM(rating = 1) AS up, SUM(rating = -1) AS down FROM parent_ratings WHERE kid_id = ?', k.id);
  const feedback = one('SELECT COUNT(*) AS n FROM feedback WHERE kid_id = ?', k.id).n;
  let interests = 0;
  try { interests = (JSON.parse(k.interests || '[]') || []).length; } catch { /* ignore */ }

  return {
    age: k.age,
    created_at: k.created_at,
    interests,
    has_guidelines: !!(k.guidelines && k.guidelines.trim()),
    channels_status: k.channels_status,
    channels,
    videos_available,
    videos_pending,
    videos_blocked,
    device_setup_at: k.device_setup_at,
    last_seen_at: k.last_seen_at,
    watched: w.n,
    watched_7d: w.week || 0,
    last_watch_at: w.last,
    likes,
    parent_up: ratings.up || 0,
    parent_down: ratings.down || 0,
    feedback,
  };
}

function funnel(families) {
  const f = { families: families.length, with_kid: 0, with_approved_channels: 0, device_set_up: 0, watched: 0, liked: 0 };
  for (const fam of families) {
    const ks = fam.kids;
    if (ks.length) f.with_kid++;
    if (ks.some(k => k.channels.approved > 0)) f.with_approved_channels++;
    if (ks.some(k => k.device_setup_at || k.watched > 0)) f.device_set_up++;
    if (ks.some(k => k.watched > 0)) f.watched++;
    if (ks.some(k => k.likes > 0)) f.liked++;
  }
  return f;
}

function warnings(families, now = Date.now()) {
  const out = [];
  const ageMin = t => (now - Date.parse(`${t.replace(' ', 'T')}Z`)) / 60000;
  for (const fam of families) {
    if (fam.kids.length === 0 && ageMin(fam.created_at) > 60) {
      out.push({ email: fam.email, issue: 'Signed up over an hour ago but has not added a child' });
    }
    fam.kids.forEach((k, i) => {
      const who = `${fam.email}, child ${i + 1} (age ${k.age ?? '?'})`;
      if (['generating', 'refining', 'reviewing'].includes(k.channels_status) && ageMin(k.created_at) > 30) {
        out.push({ email: fam.email, issue: `${who}: channel suggestions stuck in "${k.channels_status}"` });
      }
      if (k.channels.approved > 0 && k.videos_available === 0 && ageMin(k.created_at) > 60) {
        out.push({ email: fam.email, issue: `${who}: has approved channels but no videos in the feed` });
      }
      if (k.channels.approved === 0 && k.channels.pending > 0 && ageMin(k.created_at) > 120) {
        out.push({ email: fam.email, issue: `${who}: ${k.channels.pending} suggested channels waiting for the parent` });
      }
    });
  }
  return out;
}

export function getOpsData(db, { days = 14, env = process.env } = {}) {
  const stats = getStats(db, { days });
  const kidsByFamily = new Map();
  for (const k of db.prepare('SELECT * FROM kids ORDER BY created_at').all()) {
    if (!kidsByFamily.has(k.family_id)) kidsByFamily.set(k.family_id, []);
    kidsByFamily.get(k.family_id).push(kidSummary(db, k));
  }
  const sinceRaw = env.YOURTUBE_SIGNUP_SLOTS_SINCE;
  const since = sinceRaw ? new Date(sinceRaw.includes('T') ? sinceRaw : `${sinceRaw.replace(' ', 'T')}Z`).toISOString().replace('T', ' ').slice(0, 19) : null;

  const families = db.prepare('SELECT id, email, created_at FROM families ORDER BY created_at DESC').all().map(f => ({
    email: f.email,
    created_at: f.created_at,
    is_new: since ? f.created_at >= since : false,
    kids: kidsByFamily.get(f.id) || [],
  }));

  return {
    generated_at: new Date().toISOString(),
    signup_cap: getSignupStatus(db, env),
    signup_since: since,
    worker_last_seen: workerLastSeen,
    days: stats.days,
    waitlist_total: stats.waitlist_total,
    funnel: { all: funnel(families), new: funnel(families.filter(f => f.is_new)) },
    warnings: warnings(families),
    families,
  };
}
