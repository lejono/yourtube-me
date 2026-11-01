/**
 * Privacy-friendly aggregate stats: per-day counters, nothing per visitor.
 * Referrers are reduced to their domain; bots and scripts are skipped.
 */
import { timingSafeEqual } from 'node:crypto';

const MAX_REF_KEYS_PER_DAY = 200;
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|go-http|node-fetch|axios|headless|lighthouse|monitor|uptime/i;
const OWN_HOSTS = new Set(['yourtube.me', 'www.yourtube.me', 'yourtube-me.fly.dev']);

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function isBot(req) {
  const ua = req.headers['user-agent'] || '';
  return !ua || BOT_RE.test(ua);
}

export function bump(db, key, n = 1) {
  db.prepare(`
    INSERT INTO daily_stats (day, key, count) VALUES (?, ?, ?)
    ON CONFLICT(day, key) DO UPDATE SET count = count + excluded.count
  `).run(today(), key, n);
}

/** Referrer domain for an external referrer, or null. */
export function referrerHost(req) {
  const ref = req.headers.referer || req.headers.referrer;
  if (!ref) return null;
  let host;
  try { host = new URL(ref).hostname.toLowerCase(); } catch { return null; }
  if (!host || OWN_HOSTS.has(host) || host === 'localhost' || host === '127.0.0.1') return null;
  if (!/^[a-z0-9.-]{1,100}$/.test(host)) return null;
  return host.replace(/^www\./, '');
}

/** Count a page view (and its external referrer domain), skipping bots. */
export function recordView(db, req, page) {
  if (isBot(req)) return;
  try {
    bump(db, `view:${page}`);
    const host = referrerHost(req);
    if (!host) return;
    const day = today();
    const exists = db.prepare('SELECT 1 FROM daily_stats WHERE day = ? AND key = ?').get(day, `ref:${host}`);
    if (!exists) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM daily_stats WHERE day = ? AND key LIKE 'ref:%'").get(day).n;
      if (n >= MAX_REF_KEYS_PER_DAY) { bump(db, 'ref:other'); return; }
    }
    bump(db, `ref:${host}`);
  } catch (err) {
    console.warn('[stats] failed to record view:', err.message);
  }
}

export function recordEvent(db, key) {
  try { bump(db, key); } catch (err) { console.warn('[stats] failed to record event:', err.message); }
}

export function statsKeyOk(req, env = process.env) {
  const expected = env.YOURTUBE_STATS_KEY || '';
  const got = String(req.headers['x-stats-key'] || '');
  if (expected.length < 16 || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export function getStats(db, { days = 14 } = {}) {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = db.prepare('SELECT day, key, count FROM daily_stats WHERE day >= ? ORDER BY day, key').all(since);
  const byDay = {};
  for (const r of rows) (byDay[r.day] ??= {})[r.key] = r.count;
  // Make sure today exists even with no traffic yet
  byDay[today()] ??= {};
  const sortedDays = Object.fromEntries(Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)));

  return {
    days: sortedDays,
    families_total: db.prepare('SELECT COUNT(*) AS n FROM families').get().n,
    recent_signups: db.prepare(
      `SELECT email, created_at FROM families WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50`
    ).all(`${since} 00:00:00`),
    waitlist_total: db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n,
  };
}
