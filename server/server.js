import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, runMigrations, closeDb } from './lib/db.js';
import {
  createFamily,
  authenticateFamily,
  createSession,
  validateSession,
  destroySession,
  getSessionFromCookie,
  setSessionCookie,
  clearSessionCookie,
} from './lib/auth.js';
import {
  createKid,
  getKidBySetupToken,
  listKids,
  updateKid,
  deleteKid,
  setKidCookie,
  getKidFromCookie,
  regenerateSetupToken,
  revokeKidCookies,
} from './lib/kid-token.js';
import {
  addChannel,
  addPendingChannel,
  approveChannel,
  rejectChannel,
  getPendingChannels,
  listChannels,
  removeChannel,
  upsertVideos,
  setKidChannelsStatus,
  addFeedback,
  getUnprocessedFeedback,
  markFeedbackProcessed,
  getCuratedChannels,
  injectCuratedVideos,
  rateVideo,
  getParentRatings,
} from './lib/family-api.js';
import { getKidFeed } from './lib/feed-api.js';
import {
  recordWatch,
  toggleLike,
  getLikedVideoIds,
  searchVideos,
} from './lib/kid-activity.js';
import { authenticateWorker, getWorkerManifest } from './lib/worker-api.js';
import { fetchAndInsertVideos } from './lib/rss-fetch.js';
import { resolveChannel } from './lib/resolve-channel.js';
import { getSignupStatus, addToWaitlist } from './lib/signup-cap.js';
import { hit, isLimited, clientIp, LIMITS } from './lib/rate-limit.js';
import { recordView, recordEvent, statsKeyOk, getStats, isBot } from './lib/stats.js';
import { getOpsData, markKidDeviceSetup, markKidSeen, markWorkerSeen } from './lib/ops.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT = process.env.PORT ?? 3458;

// --- Helpers ---

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        data = '';
        const err = new Error('Request body too large');
        err.status = 413;
        reject(err);
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveFile(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime });
  res.end(content);
}

// Serve a static file from PUBLIC_DIR with path traversal protection.
function serveStatic(res, urlPath) {
  const safePath = resolve(PUBLIC_DIR, '.' + urlPath);
  // Ensure resolved path stays inside PUBLIC_DIR
  if (!safePath.startsWith(PUBLIC_DIR + '/') && safePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, safePath);
}

// --- Auth middleware ---

function requireParentAuth(req, db) {
  const sessionId = getSessionFromCookie(req);
  if (!sessionId) return null;
  const session = validateSession(db, sessionId);
  return session ?? null;
}

function requireWorkerAuth(req) {
  const masterKey = process.env.YOURTUBE_WORKER_MASTER_KEY ?? '';
  const key = req.headers['x-worker-key'] ?? '';
  const ok = authenticateWorker(masterKey, key);
  if (ok) markWorkerSeen();
  return ok;
}

// --- Request handler ---

async function handleRequest(req, res) {
  const db = getDb(process.env.YOURTUBE_DB_PATH);
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const method = req.method;

  // Request log (visible via: flyctl logs --app yourtube-me)
  const ip = clientIp(req);
  const loggedPath = pathname.replace(/^\/setup\/[^/]+/, '/setup/[code]');
  console.log(`${method} ${loggedPath} — ${ip} — ${req.headers['user-agent'] || '-'}`);

  // Security headers on every response
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  const tooMany = () => json(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });

  try {
    // --- Static / SPA routes ---

    if (method === 'GET' && pathname === '/') {
      const kid = await getKidFromCookie(req, db);
      if (kid) {
        return serveFile(res, join(PUBLIC_DIR, 'index.html'));
      }
      recordView(db, req, 'landing');
      return serveFile(res, join(PUBLIC_DIR, 'landing.html'));
    }

    if (method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
      recordView(db, req, 'admin');
      return serveFile(res, join(PUBLIC_DIR, 'admin', 'index.html'));
    }

    // --- Setup: GET /setup/:token (legacy URL) ---

    const setupMatch = pathname.match(/^\/setup\/([^/]+)$/);
    if (method === 'GET' && setupMatch) {
      if (!hit(`setup:${ip}`, LIMITS.setup.max, LIMITS.setup.windowMs) || !hit('setup:all', LIMITS.setupGlobal.max, LIMITS.setupGlobal.windowMs)) return tooMany();
      const token = setupMatch[1];
      const kid = getKidBySetupToken(db, token);
      if (!kid) {
        res.writeHead(404);
        res.end('Setup link not found or already used');
        return;
      }
      setKidCookie(res, kid.id, kid.cookie_generation);
      markKidDeviceSetup(db, kid.id);
      recordEvent(db, 'kid_setup');
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // --- Setup: POST /setup (3-word code) ---

    if (method === 'POST' && pathname === '/setup') {
      if (!hit(`setup:${ip}`, LIMITS.setup.max, LIMITS.setup.windowMs) || !hit('setup:all', LIMITS.setupGlobal.max, LIMITS.setupGlobal.windowMs)) return tooMany();
      let body;
      try { body = await readBody(req); } catch (err) {
        return json(res, err.status || 400, { error: 'Invalid request' });
      }
      const code = (body.code || '').trim().toLowerCase();
      if (!code) return json(res, 400, { error: 'code required' });
      const kid = getKidBySetupToken(db, code);
      if (!kid) return json(res, 404, { error: 'invalid code' });
      setKidCookie(res, kid.id, kid.cookie_generation);
      markKidDeviceSetup(db, kid.id);
      recordEvent(db, 'kid_setup');
      return json(res, 200, { ok: true });
    }

    // --- API: health ---

    if (method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true });
    }

    // --- API: auth ---

    // Donate link goes through here so clicks can be counted.
    if (method === 'GET' && pathname === '/go/donate') {
      const donate = process.env.YOURTUBE_DONATE_URL || '';
      if (!/^https:\/\/[^\s"'<>]+$/.test(donate)) { res.writeHead(404); res.end('Not found'); return; }
      if (!isBot(req)) recordEvent(db, 'click:donate');
      res.writeHead(302, { Location: donate });
      res.end();
      return;
    }

    // Operator dashboard page (static; data comes from /api/ops with the key)
    if (method === 'GET' && (pathname === '/ops' || pathname === '/ops/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Cache-Control', 'no-store');
      return serveFile(res, join(PUBLIC_DIR, 'ops.html'));
    }

    if (method === 'GET' && pathname === '/api/ops') {
      if (!statsKeyOk(req)) return json(res, 404, { error: 'Not found' });
      res.setHeader('Cache-Control', 'no-store');
      const days = Math.min(90, Math.max(1, Number.parseInt(url.searchParams.get('days') || '14', 10) || 14));
      return json(res, 200, getOpsData(db, { days }));
    }

    // Operator stats (aggregate counts + recent signups). Hidden without the key.
    if (method === 'GET' && pathname === '/api/stats') {
      if (!statsKeyOk(req)) return json(res, 404, { error: 'Not found' });
      const days = Math.min(90, Math.max(1, Number.parseInt(url.searchParams.get('days') || '14', 10) || 14));
      return json(res, 200, getStats(db, { days }));
    }

    if (method === 'GET' && pathname === '/api/public-config') {
      const donate = process.env.YOURTUBE_DONATE_URL || '';
      return json(res, 200, { donate_url: /^https:\/\/[^\s"'<>]+$/.test(donate) ? donate : null });
    }

    if (method === 'POST' && pathname === '/api/waitlist') {
      if (!hit(`waitlist:${ip}`, LIMITS.signup.max, LIMITS.signup.windowMs)) return tooMany();
      let body;
      try { body = await readBody(req); } catch (err) {
        return json(res, err.status || 400, { error: 'Invalid request' });
      }
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (email.length > 254 || !/^[^\s@\x00-\x1f\x7f-\x9f]+@[^\s@\x00-\x1f\x7f-\x9f]+\.[^\s@\x00-\x1f\x7f-\x9f]+$/.test(email)) {
        return json(res, 400, { error: 'Please enter a valid email address.' });
      }
      addToWaitlist(db, email);
      recordEvent(db, 'waitlist');
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/auth/signup-status') {
      return json(res, 200, { open: getSignupStatus(db).open });
    }

    if (method === 'POST' && pathname === '/api/auth/signup') {
      if (!hit(`signup:${ip}`, LIMITS.signup.max, LIMITS.signup.windowMs)) return tooMany();
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { email, password } = body;
      if (!email || !password) {
        return json(res, 400, { error: 'email and password required' });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return json(res, 400, { error: 'Please use a password of at least 8 characters.' });
      }
      if (!getSignupStatus(db).open) {
        addToWaitlist(db, email);
        recordEvent(db, 'waitlist');
        return json(res, 403, {
          error: "YourTube is full for now. We've saved your email and will let you know when there's room.",
          waitlisted: true,
        });
      }
      try {
        const family = createFamily(db, email, password);
        const sessionId = createSession(db, family.id);
        setSessionCookie(res, sessionId);
        recordEvent(db, 'signup');
        return json(res, 201, { family_id: family.id });
      } catch (err) {
        if (err.message?.includes('UNIQUE constraint failed')) {
          return json(res, 409, { error: 'Email already registered' });
        }
        throw err;
      }
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      if (!hit(`login:${ip}`, LIMITS.login.max, LIMITS.login.windowMs)) return tooMany();
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { email, password } = body;
      if (!email || !password) {
        return json(res, 400, { error: 'email and password required' });
      }
      // Per-account limit counts failed attempts only, so successful
      // logins never use up the allowance.
      const emailKey = `login-email:${String(email).trim().toLowerCase()}`;
      if (isLimited(emailKey, LIMITS.loginEmail.max)) return tooMany();
      const family = authenticateFamily(db, email, password);
      if (!family) {
        hit(emailKey, LIMITS.loginEmail.max, LIMITS.loginEmail.windowMs);
        return json(res, 401, { error: 'Invalid credentials' });
      }
      const sessionId = createSession(db, family.id);
      setSessionCookie(res, sessionId);
      return json(res, 200, { family_id: family.id });
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      const sessionId = getSessionFromCookie(req);
      if (sessionId) {
        destroySession(db, sessionId);
      }
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/auth/session') {
      const sessionId = getSessionFromCookie(req);
      if (!sessionId) {
        return json(res, 200, { authenticated: false });
      }
      const session = validateSession(db, sessionId);
      if (!session) {
        return json(res, 200, { authenticated: false });
      }
      return json(res, 200, { authenticated: true, family_id: session.family_id });
    }

    // --- API: feed (kid-facing) ---

    if (method === 'GET' && pathname === '/api/feed') {
      const kid = await getKidFromCookie(req, db);
      if (!kid) {
        return json(res, 404, { error: 'No valid kid session' });
      }
      markKidSeen(db, kid.id);
      const channel = url.searchParams.get('channel') ?? undefined;
      const limit = url.searchParams.get('limit') ?? undefined;
      const feed = getKidFeed(db, kid.id, { channel, limit });
      return json(res, 200, feed);
    }

    // --- API: watch (kid-facing) ---

    if (method === 'POST' && pathname === '/api/watch') {
      const kid = await getKidFromCookie(req, db);
      if (!kid) return json(res, 404, { error: 'No valid kid session' });
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { video_id } = body;
      if (!video_id) return json(res, 400, { error: 'video_id required' });
      recordWatch(db, kid.id, video_id);
      return json(res, 200, { ok: true });
    }

    // --- API: likes (kid-facing) ---

    if (method === 'POST' && pathname === '/api/likes') {
      const kid = await getKidFromCookie(req, db);
      if (!kid) return json(res, 404, { error: 'No valid kid session' });
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { video_id, title, channel_title } = body;
      if (!video_id) return json(res, 400, { error: 'video_id required' });
      const result = toggleLike(db, kid.id, { video_id, title: title ?? '', channel_title: channel_title ?? '' });
      return json(res, 200, result);
    }

    // --- API: search (kid-facing) ---

    if (method === 'GET' && pathname === '/api/search') {
      const kid = await getKidFromCookie(req, db);
      if (!kid) return json(res, 404, { error: 'No valid kid session' });
      const q = url.searchParams.get('q');
      if (!q) return json(res, 400, { error: 'q query parameter required' });
      const videos = searchVideos(db, kid.id, q);
      const liked_video_ids = getLikedVideoIds(db, kid.id);
      return json(res, 200, { videos, liked_video_ids });
    }

    // --- API: kids (parent-facing) ---

    if ((method === 'GET' || method === 'POST') && pathname === '/api/kids') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });

      if (method === 'GET') {
        const watchedStmt = db.prepare('SELECT 1 FROM watches WHERE kid_id = ? LIMIT 1');
        const kids = listKids(db, session.family_id).map(k => ({
          ...k,
          device_setup: !!k.device_setup_at || !!watchedStmt.get(k.id),
        }));
        return json(res, 200, kids);
      }

      // POST /api/kids
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { name, age, guidelines, interests } = body;
      if (!name) return json(res, 400, { error: 'name required' });
      const kid = createKid(db, session.family_id, { name, age, guidelines, interests });
      recordEvent(db, 'kid_created');

      // Auto-suggest from curated DB when interests are provided
      if (Array.isArray(interests) && interests.length > 0 && age) {
        const curated = getCuratedChannels(db, interests, age);
        const toAdd = curated.slice(0, 15);
        for (const ch of toAdd) {
          try {
            addPendingChannel(db, kid.id, {
              channel_id: ch.channel_id,
              title: ch.title,
              reason: ch.description,
              thumbnail: null,
            });
          } catch { /* ignore duplicates */ }
        }

        // Check which interests have no curated channel matches
        const coveredInterests = new Set();
        for (const ch of curated) {
          const chInterests = Array.isArray(ch.interests) ? ch.interests : JSON.parse(ch.interests);
          for (const i of chInterests) coveredInterests.add(i);
        }
        const uncoveredInterests = interests.filter(i => !coveredInterests.has(i));

        if (uncoveredInterests.length > 0) {
          // Some interests (e.g. custom free-text like "taylor swift") have
          // no curated matches — signal the worker to run Opus for these.
          // Set 'generating' immediately so the parent sees a spinner.
          setKidChannelsStatus(db, kid.id, 'generating');
          kid.channels_status = 'generating';
          console.log(`[kid] ${kid.name}: ${uncoveredInterests.length} interest(s) not in curated DB, worker will run Opus: ${uncoveredInterests.join(', ')}`);
        } else if (toAdd.length > 0) {
          // All interests covered by curated DB — set ready (or reviewing)
          const hasGuidelines = guidelines && guidelines.trim().length > 0;
          const status = hasGuidelines ? 'reviewing' : 'ready';
          setKidChannelsStatus(db, kid.id, status);
          kid.channels_status = status;
        }

        if (toAdd.length > 0) {
          // Fire-and-forget: fetch RSS for suggested channels so the feed
          // has videos immediately without waiting for the next worker poll.
          fetchAndInsertVideos(db, kid.id, toAdd).catch(err => {
            console.warn('[rss] Background RSS fetch failed:', err.message);
          });
        }

        // Also inject curated videos that match the kid's interests/age
        injectCuratedVideos(db, kid.id, interests, age);
      }

      return json(res, 201, kid);
    }

    // Ownership guard: every /api/kids/:id/... route is parent-only, and the
    // kid must belong to the logged-in family. 404 (not 403) so kid IDs from
    // other families can't be probed.
    const kidScopeMatch = pathname.match(/^\/api\/kids\/([^/]+)(?:\/|$)/);
    if (kidScopeMatch) {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const owner = db.prepare('SELECT family_id FROM kids WHERE id = ?').get(kidScopeMatch[1]);
      if (!owner || owner.family_id !== session.family_id) {
        return json(res, 404, { error: 'Not found' });
      }
    }

    // PATCH /api/kids/:id
    const kidMatch = pathname.match(/^\/api\/kids\/([^/]+)$/);
    if (kidMatch) {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = kidMatch[1];

      if (method === 'PATCH') {
        let body;
        try { body = await readBody(req); } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        const updated = updateKid(db, kidId, body);
        return json(res, 200, updated);
      }

      if (method === 'DELETE') {
        deleteKid(db, kidId);
        return json(res, 200, { ok: true });
      }
    }

    // POST /api/kids/:id/rate
    const rateMatch = pathname.match(/^\/api\/kids\/([^/]+)\/rate$/);
    if (rateMatch && method === 'POST') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = rateMatch[1];
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { video_id, rating } = body;
      if (!video_id) return json(res, 400, { error: 'video_id required' });
      if (rating !== 1 && rating !== -1) return json(res, 400, { error: 'rating must be 1 or -1' });
      rateVideo(db, kidId, video_id, rating);
      return json(res, 200, { ok: true });
    }

    // GET /api/kids/:id/feed-preview
    const feedPreviewMatch = pathname.match(/^\/api\/kids\/([^/]+)\/feed-preview$/);
    if (feedPreviewMatch && method === 'GET') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = feedPreviewMatch[1];
      const feed = getKidFeed(db, kidId, {});
      const ratings = getParentRatings(db, kidId);
      const ratingsObj = Object.fromEntries(ratings);
      return json(res, 200, { ...feed, parent_ratings: ratingsObj });
    }

    // --- API: channels ---

    const channelsMatch = pathname.match(/^\/api\/kids\/([^/]+)\/channels$/);
    if (channelsMatch) {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = channelsMatch[1];

      if (method === 'GET') {
        const channels = listChannels(db, kidId);
        return json(res, 200, channels);
      }

      if (method === 'POST') {
        let body;
        try { body = await readBody(req); } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        let { channel_id, title, thumbnail } = body;
        if (!channel_id) return json(res, 400, { error: 'channel_id required' });

        // Resolve bare names, URLs, and @handles to a real UC* channel ID
        const resolved = await resolveChannel(channel_id);
        if (!resolved) {
          return json(res, 400, { error: `Could not find a YouTube channel for "${channel_id}"` });
        }
        channel_id = resolved.channel_id;
        // Use the resolved title if the parent just typed a name (title === original input)
        if (resolved.title && (!title || title === body.channel_id)) {
          title = resolved.title;
        }
        if (!title) title = channel_id; // last resort

        const channel = addChannel(db, kidId, { channel_id, title, thumbnail });
        // Start filling the feed now rather than waiting for the worker.
        fetchAndInsertVideos(db, kidId, [{ channel_id, title }]).catch(err => {
          console.warn('[rss] Fetch on channel add failed:', err.message);
        });
        return json(res, 201, channel);
      }
    }

    // DELETE /api/kids/:id/channels/:channelId
    // POST /api/kids/:id/channels/:channelId/approve
    // POST /api/kids/:id/channels/:channelId/reject
    // POST /api/kids/:id/channels/:channelId/unapprove
    const channelActionMatch = pathname.match(/^\/api\/kids\/([^/]+)\/channels\/([^/]+)(\/approve|\/reject|\/unapprove)?$/);
    if (channelActionMatch) {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = channelActionMatch[1];
      const channelId = channelActionMatch[2];
      const action = channelActionMatch[3];

      if (method === 'DELETE' && !action) {
        removeChannel(db, kidId, channelId);
        return json(res, 200, { ok: true });
      }

      if (method === 'POST' && action === '/approve') {
        approveChannel(db, kidId, channelId);
        const ch = db.prepare('SELECT channel_id, title FROM channels WHERE kid_id = ? AND channel_id = ?').get(kidId, channelId);
        if (ch) {
          fetchAndInsertVideos(db, kidId, [ch]).catch(err => {
            console.warn('[rss] Fetch on channel approve failed:', err.message);
          });
        }
        return json(res, 200, { ok: true });
      }

      if (method === 'POST' && action === '/reject') {
        rejectChannel(db, kidId, channelId);
        return json(res, 200, { ok: true });
      }

      if (method === 'POST' && action === '/unapprove') {
        db.prepare('DELETE FROM videos WHERE kid_id = ? AND channel_id = ?').run(kidId, channelId);
        rejectChannel(db, kidId, channelId);
        return json(res, 200, { ok: true });
      }
    }

    // GET /api/kids/:id/suggestions
    const suggestionsMatch = pathname.match(/^\/api\/kids\/([^/]+)\/suggestions$/);
    if (suggestionsMatch && method === 'GET') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = suggestionsMatch[1];
      const suggestions = getPendingChannels(db, kidId);
      return json(res, 200, { suggestions });
    }

    // POST /api/kids/:id/feedback
    const feedbackMatch = pathname.match(/^\/api\/kids\/([^/]+)\/feedback$/);
    if (feedbackMatch && method === 'POST') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = feedbackMatch[1];
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { message } = body;
      if (!message) return json(res, 400, { error: 'message required' });
      const feedback = addFeedback(db, kidId, message);
      setKidChannelsStatus(db, kidId, 'refining');
      return json(res, 201, feedback);
    }

    // GET /api/kids/:id/recent-videos
    const recentVideosMatch = pathname.match(/^\/api\/kids\/([^/]+)\/recent-videos$/);
    if (recentVideosMatch && method === 'GET') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = recentVideosMatch[1];
      const videos = db.prepare(
        'SELECT * FROM videos WHERE kid_id = ? ORDER BY filtered_at DESC LIMIT 10'
      ).all(kidId);
      return json(res, 200, { videos });
    }

    // POST /api/kids/:id/regenerate-token
    const regenTokenMatch = pathname.match(/^\/api\/kids\/([^/]+)\/regenerate-token$/);
    if (regenTokenMatch && method === 'POST') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = regenTokenMatch[1];
      const newToken = regenerateSetupToken(db, kidId);
      return json(res, 200, { setup_token: newToken });
    }

    // POST /api/kids/:id/revoke
    const revokeMatch = pathname.match(/^\/api\/kids\/([^/]+)\/revoke$/);
    if (revokeMatch && method === 'POST') {
      const session = requireParentAuth(req, db);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
      const kidId = revokeMatch[1];
      revokeKidCookies(db, kidId);
      return json(res, 200, { ok: true });
    }

    // --- API: worker ---

    if (method === 'GET' && pathname === '/api/worker/manifest') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const manifest = getWorkerManifest(db);
      return json(res, 200, manifest);
    }

    if (method === 'POST' && pathname === '/api/worker/push') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { kid_id, videos } = body;
      if (!kid_id || !Array.isArray(videos)) {
        return json(res, 400, { error: 'kid_id and videos array required' });
      }
      upsertVideos(db, kid_id, videos);
      return json(res, 200, { ok: true, count: videos.length });
    }

    if (method === 'POST' && pathname === '/api/worker/channels') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { kid_id, channel_id, title, thumbnail, status, reason } = body;
      if (!kid_id || !channel_id || !title) {
        return json(res, 400, { error: 'kid_id, channel_id, and title required' });
      }
      try {
        let channel;
        if (status === 'pending') {
          channel = addPendingChannel(db, kid_id, { channel_id, title, thumbnail, reason });
        } else {
          channel = addChannel(db, kid_id, { channel_id, title, thumbnail });
        }
        return json(res, 201, channel);
      } catch (err) {
        if (err.message?.includes('UNIQUE constraint failed')) {
          return json(res, 200, { ok: true, existing: true });
        }
        throw err;
      }
    }

    // POST /api/worker/kid/:id/channels/:channelId/reject
    const workerRejectMatch = pathname.match(/^\/api\/worker\/kid\/([^/]+)\/channels\/([^/]+)\/reject$/);
    if (workerRejectMatch && method === 'POST') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const kidId = workerRejectMatch[1];
      const channelId = workerRejectMatch[2];
      rejectChannel(db, kidId, channelId);
      return json(res, 200, { ok: true });
    }

    // GET /api/worker/kid/:id/feedback
    const workerFeedbackMatch = pathname.match(/^\/api\/worker\/kid\/([^/]+)\/feedback$/);
    if (workerFeedbackMatch && method === 'GET') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const kidId = workerFeedbackMatch[1];
      const feedback = getUnprocessedFeedback(db, kidId);
      return json(res, 200, { feedback });
    }

    // POST /api/worker/feedback/:id/processed
    const workerFeedbackProcessedMatch = pathname.match(/^\/api\/worker\/feedback\/([^/]+)\/processed$/);
    if (workerFeedbackProcessedMatch && method === 'POST') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const feedbackId = parseInt(workerFeedbackProcessedMatch[1], 10);
      if (isNaN(feedbackId)) return json(res, 400, { error: 'Invalid feedback id' });
      markFeedbackProcessed(db, feedbackId);
      return json(res, 200, { ok: true });
    }

    // GET /api/worker/kid/:id/channels
    const workerKidChannelsMatch = pathname.match(/^\/api\/worker\/kid\/([^/]+)\/channels$/);
    if (workerKidChannelsMatch && method === 'GET') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const kidId = workerKidChannelsMatch[1];
      const channels = listChannels(db, kidId);
      return json(res, 200, { channels });
    }

    // POST /api/worker/kid/:id/channels-generated
    const channelsGenMatch = pathname.match(/^\/api\/worker\/kid\/([^/]+)\/channels-generated$/);
    if (channelsGenMatch && method === 'POST') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const kidId = channelsGenMatch[1];
      db.prepare('UPDATE kids SET channels_generated = 1 WHERE id = ?').run(kidId);
      return json(res, 200, { ok: true });
    }

    // POST /api/worker/kid/:id/status
    const kidStatusMatch = pathname.match(/^\/api\/worker\/kid\/([^/]+)\/status$/);
    if (kidStatusMatch && method === 'POST') {
      if (!requireWorkerAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      let body;
      try { body = await readBody(req); } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const { status } = body;
      const VALID_STATUSES = ['idle', 'generating', 'ready', 'refining', 'reviewing'];
      if (!VALID_STATUSES.includes(status)) {
        return json(res, 400, { error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      const kidId = kidStatusMatch[1];
      setKidChannelsStatus(db, kidId, status);
      return json(res, 200, { ok: true });
    }

    // --- Static files from public/ ---

    if (method === 'GET') {
      // Try to serve as a static file
      const safePath = resolve(PUBLIC_DIR + pathname);
      if (safePath.startsWith(PUBLIC_DIR) && existsSync(safePath)) {
        return serveStatic(res, pathname);
      }
    }

    // 404 fallthrough
    res.writeHead(404);
    res.end('Not found');

  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) {
      json(res, 500, { error: 'Internal server error' });
    }
  }
}

// --- Curated channel seeding ---

/**
 * Seed the curated_channels table from migrations/seed-channels.json if it is empty.
 * Idempotent: does nothing when rows already exist.
 * @param {import('better-sqlite3').Database} db
 */
function seedCuratedChannels(db) {
  const seedPath = join(__dirname, 'migrations', 'seed-channels.json');
  if (!existsSync(seedPath)) return;

  const channels = JSON.parse(readFileSync(seedPath, 'utf8'));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO curated_channels
      (channel_id, title, description, interests, age_min, age_max, quality, source)
    VALUES
      (@channel_id, @title, @description, @interests, @age_min, @age_max, @quality, @source)
  `);

  const seedAll = db.transaction((rows) => {
    let added = 0;
    for (const row of rows) {
      const result = insert.run({ ...row, interests: JSON.stringify(row.interests) });
      if (result.changes > 0) added++;
    }
    return added;
  });

  const added = seedAll(channels);
  if (added > 0) console.log(`Seeded ${added} new curated channels (${channels.length} total in file).`);

  const unresolved = db.prepare(
    `SELECT title FROM curated_channels WHERE channel_id LIKE 'UNRESOLVED%'`
  ).all();
  if (unresolved.length > 0) {
    console.warn(`[seed] WARNING: ${unresolved.length} curated channels have UNRESOLVED IDs and will be skipped:`);
    for (const ch of unresolved) console.warn(`  - ${ch.title}`);
  }
}

// --- Curated video seeding ---

/**
 * Seed the curated_videos table from migrations/seed-videos.json if it is empty.
 * Idempotent: does nothing when rows already exist.
 * @param {import('better-sqlite3').Database} db
 */
function seedCuratedVideos(db) {
  const seedPath = join(__dirname, 'migrations', 'seed-videos.json');
  if (!existsSync(seedPath)) return;

  const videos = JSON.parse(readFileSync(seedPath, 'utf8'));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO curated_videos
      (video_id, title, channel_title, description, interests, age_min, age_max, source)
    VALUES
      (@video_id, @title, @channel_title, @description, @interests, @age_min, @age_max, @source)
  `);

  const seedAll = db.transaction((rows) => {
    let added = 0;
    for (const row of rows) {
      const result = insert.run({
        ...row,
        interests: JSON.stringify(row.interests),
        source: row.source ?? 'curated',
      });
      if (result.changes > 0) added++;
    }
    return added;
  });

  const added = seedAll(videos);
  if (added > 0) console.log(`Seeded ${added} new curated videos (${videos.length} total in file).`);
}

// --- Server lifecycle ---

/**
 * Start the HTTP server. Returns the server instance.
 * Runs migrations and seeds curated channels on startup.
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer() {
  const db = getDb(process.env.YOURTUBE_DB_PATH);
  runMigrations(db);
  seedCuratedChannels(db);
  seedCuratedVideos(db);

  const server = createServer(handleRequest);
  const port = Number(process.env.PORT ?? PORT);

  return new Promise((resolve, reject) => {
    const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
    server.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Stop the HTTP server and close the database.
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
export function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close(err => {
      closeDb();
      if (err) reject(err);
      else resolve();
    });
  });
}

// If this file is run directly (not imported), start the server.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then(server => {
    const addr = server.address();
    console.log(`YourTube server listening on port ${addr.port}`);
  });
}
