/**
 * Small in-memory fixed-window rate limiter (single fly machine).
 *
 * On by default in production; YOURTUBE_RATE_LIMIT=off disables it,
 * YOURTUBE_RATE_LIMIT=on forces it on (tests).
 */

const MAX_KEYS = 20_000;
const buckets = new Map(); // key -> { count, resetAt }; insertion-ordered

export function rateLimitEnabled(env = process.env) {
  if (env.YOURTUBE_RATE_LIMIT === 'off') return false;
  if (env.YOURTUBE_RATE_LIMIT === 'on') return true;
  return env.NODE_ENV === 'production';
}

/**
 * Group IPv6 addresses by /64, since one client usually controls a whole /64.
 */
export function ipKey(ip) {
  const s = String(ip || 'unknown').replace(/^::ffff:/, '');
  if (!s.includes(':')) return s;
  const [head] = s.split('::');
  const parts = s.includes('::')
    ? [...head.split(':').filter(Boolean), '0', '0', '0', '0'].slice(0, 4)
    : s.split(':').slice(0, 4);
  return `${parts.map(p => p || '0').join(':')}::/64`;
}

/**
 * Client IP. On fly.io the edge proxy sets Fly-Client-IP (it overwrites any
 * client-supplied value); the app is only reachable through that proxy.
 * X-Forwarded-For's first entry is client-controlled, so it is not used.
 */
export function clientIp(req) {
  return ipKey(req.headers['fly-client-ip'] || req.socket.remoteAddress);
}

/**
 * Count one hit for `key`. Returns true if allowed, false if over `max`
 * within `windowMs`.
 */
function liveBucket(key, windowMs, now) {
  let b = buckets.get(key);
  if (b && b.resetAt > now) return b;
  if (b) buckets.delete(key);
  if (buckets.size >= MAX_KEYS) {
    // Drop expired entries only (oldest first); never drop a live counter.
    for (const [k, v] of buckets) {
      if (buckets.size < MAX_KEYS) break;
      if (v.resetAt <= now) buckets.delete(k);
    }
    if (buckets.size >= MAX_KEYS) return null; // full of live counters: fail closed
  }
  b = { count: 0, resetAt: now + windowMs };
  buckets.set(key, b);
  return b;
}

export function hit(key, max, windowMs, now = Date.now()) {
  if (!rateLimitEnabled()) return true;
  const b = liveBucket(key, windowMs, now);
  if (!b) return false;
  b.count += 1;
  return b.count <= max;
}

/** True if `key` is already at or over `max` (does not count a hit). */
export function isLimited(key, max, now = Date.now()) {
  if (!rateLimitEnabled()) return false;
  const b = buckets.get(key);
  return !!b && b.resetAt > now && b.count >= max;
}

export const LIMITS = {
  setup: { max: 10, windowMs: 10 * 60_000 },          // per IP
  setupGlobal: { max: 300, windowMs: 10 * 60_000 },   // all IPs together
  login: { max: 10, windowMs: 10 * 60_000 },          // per IP
  loginEmail: { max: 10, windowMs: 10 * 60_000 },     // per target account
  signup: { max: 5, windowMs: 60 * 60_000 },          // per IP
};
