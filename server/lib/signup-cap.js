/**
 * Signup cap: allow only YOURTUBE_SIGNUP_SLOTS new families created at or
 * after YOURTUBE_SIGNUP_SLOTS_SINCE (UTC; ISO or "YYYY-MM-DD HH:MM:SS").
 * With SLOTS unset, signup is unlimited. With SINCE unset, every family counts.
 * When full, the email goes on a waitlist instead of creating an account.
 */

function toSqliteTime(value) {
  const v = String(value).trim();
  const iso = /[TZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export function getSignupStatus(db, env = process.env) {
  const raw = env.YOURTUBE_SIGNUP_SLOTS;
  if (raw === undefined || raw === '') return { open: true, limited: false };
  const slots = Math.max(0, Number.parseInt(raw, 10) || 0);
  const since = env.YOURTUBE_SIGNUP_SLOTS_SINCE ? toSqliteTime(env.YOURTUBE_SIGNUP_SLOTS_SINCE) : null;
  const used = since
    ? db.prepare('SELECT COUNT(*) AS n FROM families WHERE created_at >= ?').get(since).n
    : db.prepare('SELECT COUNT(*) AS n FROM families').get().n;
  return { open: used < slots, limited: true, slots, used };
}

export function addToWaitlist(db, email) {
  const clean = String(email).trim().toLowerCase().slice(0, 254);
  if (!clean.includes('@')) return false;
  if (/[\x00-\x1f\x7f-\x9f]/.test(clean)) return false; // no control characters
  db.prepare('INSERT OR IGNORE INTO waitlist (email) VALUES (?)').run(clean);
  return true;
}
