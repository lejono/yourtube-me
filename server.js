import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { HOST, PORT, ADMIN_PASSWORD, KID_PASSWORD, SCRAPER_ENABLED, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, VALID_USERS, CROSS_AUTH_SECRET, KIDCODE_ENABLED, KIDCODE_URL } from './config.js';
import { hashPassword, verifyPassword, createSession, validateSession, destroySession, requireAdmin, getSessionUser } from './lib/auth.js';
import { getAuthURL, validateState, exchangeCode, getValidToken } from './lib/oauth.js';
import { getVideos, setVideos, getChannels, setChannels, getHistory, setHistory, getBlocked, setBlocked, getConfig, setConfig, getTokens, setTokens, getProfile, getUserProfile, getUserChannels, setUserChannels, getUserLikes, setUserLikes, getUserHistory, setUserHistory, getUserBlocked, setUserBlocked, getUserSearchLog, setUserSearchLog } from './lib/store.js';
import { generateFeed, refreshAllChannels, getLastPollAt, startPolling } from './lib/feed.js';
import { importSubscriptions, importLikedVideos, getImportStatus } from './lib/import.js';
import { rebuildProfile } from './lib/profile.js';
import { getUpNext, vetUpNext } from './lib/upnext.js';
import { classifyWithCache } from './lib/filter.js';
import { resolveChannel, getQuotaUsed } from './lib/youtube.js';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const SERVER_START_TIME = Date.now();

const passwordHash = hashPassword(ADMIN_PASSWORD);
const kidPasswordHash = hashPassword(KID_PASSWORD);

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

async function serveStatic(res, filepath) {
  try {
    const data = await readFile(filepath);
    const ext = extname(filepath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  // POST /auth/login — accepts parent or kid password.
  // Parent password without a username creates an admin session (used by
  // the admin dashboard). Kid login requires both a valid username and the
  // kid password.
  if (method === 'POST' && pathname === '/auth/login') {
    try {
      const body = await parseBody(req);
      const isParent = body.password && verifyPassword(body.password, passwordHash);
      const isKid = body.password && verifyPassword(body.password, kidPasswordHash);
      if (!isParent && !isKid) {
        return sendJSON(res, 401, { error: 'Invalid password' });
      }

      const username = (body.username || '').trim().toLowerCase();

      // Admin session: parent password with no username
      if (isParent && !username) {
        await createSession(res, null);
        return sendJSON(res, 200, { ok: true, username: null, isAdmin: true });
      }

      // Kid session: username must be valid
      if (!username) {
        return sendJSON(res, 401, { error: 'Username is required' });
      }
      if (!VALID_USERS.includes(username)) {
        return sendJSON(res, 401, { error: 'Invalid username or password' });
      }

      await createSession(res, username);
      return sendJSON(res, 200, {
        ok: true,
        username,
        kidcodeEnabled: KIDCODE_ENABLED,
        kidcodeUrl: KIDCODE_ENABLED ? KIDCODE_URL : '',
      });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // GET /auth/token?user=<username>&ts=<timestamp>&sig=<hmac>
  // Cross-app login: KidCode redirects kids here with a signed token.
  // Only active when YOURTUBE_KIDCODE_ENABLED=true and a secret is configured.
  if (method === 'GET' && pathname === '/auth/token') {
    if (!KIDCODE_ENABLED) {
      return sendJSON(res, 404, { error: 'KidCode integration disabled' });
    }
    const user = url.searchParams.get('user');
    const ts = url.searchParams.get('ts');
    const sig = url.searchParams.get('sig');
    if (!user || !ts || !sig) {
      return sendJSON(res, 400, { error: 'Missing parameters' });
    }
    // Token expires after 30 seconds
    if (Math.abs(Date.now() - parseInt(ts)) > 30000) {
      return sendJSON(res, 401, { error: 'Token expired' });
    }
    const expected = createHmac('sha256', CROSS_AUTH_SECRET).update(`${user}:${ts}`).digest('hex');
    if (sig !== expected) {
      return sendJSON(res, 401, { error: 'Invalid token' });
    }
    if (!VALID_USERS.includes(user)) {
      return sendJSON(res, 401, { error: 'Unknown user' });
    }
    await createSession(res, user);
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // POST /auth/logout
  if (method === 'POST' && pathname === '/auth/logout') {
    await destroySession(req, res);
    return sendJSON(res, 200, { ok: true });
  }

  // GET /api/session — kid-facing auth check
  if (method === 'GET' && pathname === '/api/session') {
    const username = await getSessionUser(req);
    const sessionId = await validateSession(req);
    return sendJSON(res, 200, {
      authenticated: !!sessionId,
      username,
      kidcodeEnabled: KIDCODE_ENABLED,
      kidcodeUrl: KIDCODE_ENABLED ? KIDCODE_URL : '',
    });
  }

  // GET /api/admin/session
  if (method === 'GET' && pathname === '/api/admin/session') {
    const sessionId = await validateSession(req);
    return sendJSON(res, 200, { authenticated: !!sessionId });
  }

  // GET /api/feed — kid-facing video feed (weighted shuffle, blocked filtering)
  if (method === 'GET' && pathname === '/api/feed') {
    const username = await getSessionUser(req);
    if (!username) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    try {
      const channel = url.searchParams.get('channel');
      const feedChannel = (channel && channel !== 'all') ? channel : undefined;

      const [userChannels, userBlocked] = await Promise.all([
        getUserChannels(username), getUserBlocked(username),
      ]);
      const videos = await generateFeed({ channel: feedChannel, userChannels, userBlocked });

      // AI content filter — remove videos that violate guidelines/profile
      const [config, profile] = await Promise.all([
        getConfig(), getUserProfile(username),
      ]);
      const context = {
        profile,
        guidelines: config.guidelines || '',
        blockedChannels: userBlocked.channels || [],
        blockedVideos: userBlocked.videos || [],
      };
      const decisions = await classifyWithCache(videos, context);
      const approvedIds = new Set(
        decisions.filter(d => d.approved).map(d => d.videoId)
      );
      const filtered = videos.filter(v => approvedIds.has(v.videoId));

      const likes = await getUserLikes(username);
      const channelIds = new Set(filtered.map(v => v.channelId));
      const relevantChannels = (userChannels || []).filter(c => channelIds.has(c.channelId));
      const likedVideoIds = (likes || []).map(l => l.videoId);

      return sendJSON(res, 200, { videos: filtered, channels: relevantChannels, likedVideoIds });
    } catch (err) {
      console.error('Feed error:', err.message);
      return sendJSON(res, 500, { error: 'Failed to generate feed' });
    }
  }

  // GET /api/video/:id — single video metadata
  if (method === 'GET' && pathname.startsWith('/api/video/')) {
    const videoId = decodeURIComponent(pathname.slice('/api/video/'.length));
    if (!videoId) {
      return sendJSON(res, 400, { error: 'Missing video ID' });
    }
    try {
      const videos = await getVideos();
      const video = videos[videoId];
      if (!video) {
        return sendJSON(res, 404, { error: 'Video not found' });
      }
      return sendJSON(res, 200, { videoId, ...video });
    } catch (err) {
      console.error('Video lookup error:', err.message);
      return sendJSON(res, 500, { error: 'Failed to fetch video' });
    }
  }

  // POST /api/likes — toggle like on a video
  if (method === 'POST' && pathname === '/api/likes') {
    const username = await getSessionUser(req);
    if (!username) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await parseBody(req);
      if (!body.videoId) {
        return sendJSON(res, 400, { error: 'videoId is required' });
      }
      const likes = await getUserLikes(username);
      const idx = likes.findIndex(l => l.videoId === body.videoId);
      if (idx !== -1) {
        likes.splice(idx, 1);
        await setUserLikes(username, likes);
        return sendJSON(res, 200, { liked: false });
      } else {
        likes.push({
          videoId: body.videoId,
          title: body.title || '',
          channelTitle: body.channelTitle || '',
          channelId: body.channelId || '',
          likedAt: new Date().toISOString(),
        });
        await setUserLikes(username, likes);
        return sendJSON(res, 200, { liked: true });
      }
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // POST /api/watch/start — record watch start in history
  if (method === 'POST' && pathname === '/api/watch/start') {
    const username = await getSessionUser(req);
    if (!username) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await parseBody(req);
      if (!body.videoId) {
        return sendJSON(res, 400, { error: 'videoId is required' });
      }
      const history = await getUserHistory(username);
      history.push({
        videoId: body.videoId,
        startedAt: body.timestamp || new Date().toISOString(),
        endedAt: null,
        duration: null,
      });
      await setUserHistory(username, history);

      // Fire-and-forget background vetting for Up Next picks
      vetUpNext(body.videoId).catch(err => {
        console.warn('[upnext] background vetting failed:', err.message);
      });

      return sendJSON(res, 200, { ok: true });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // POST /api/watch/end — record watch end in history
  if (method === 'POST' && pathname === '/api/watch/end') {
    const username = await getSessionUser(req);
    if (!username) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await parseBody(req);
      if (!body.videoId) {
        return sendJSON(res, 400, { error: 'videoId is required' });
      }
      const history = await getUserHistory(username);
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].videoId === body.videoId && !history[i].endedAt) {
          history[i].endedAt = body.timestamp || new Date().toISOString();
          history[i].duration = body.duration ?? null;
          break;
        }
      }
      await setUserHistory(username, history);
      return sendJSON(res, 200, { ok: true });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // GET /api/upnext/:videoId — vetted Up Next picks for a video
  if (method === 'GET' && pathname.startsWith('/api/upnext/')) {
    const videoId = decodeURIComponent(pathname.slice('/api/upnext/'.length));
    if (!videoId) {
      return sendJSON(res, 400, { error: 'Missing video ID' });
    }
    try {
      const result = await getUpNext(videoId);
      return sendJSON(res, 200, result);
    } catch (err) {
      console.error('Up next error:', err.message);
      return sendJSON(res, 500, { error: 'Failed to get up next picks' });
    }
  }

  // GET /auth/youtube — start OAuth flow (requires admin session)
  if (method === 'GET' && pathname === '/auth/youtube') {
    if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
      res.writeHead(302, { Location: '/admin?error=oauth_not_configured' });
      return res.end();
    }
    const sessionId = await validateSession(req);
    if (!sessionId) {
      res.writeHead(302, { Location: '/admin?error=not_authenticated' });
      return res.end();
    }
    const authURL = getAuthURL(sessionId);
    res.writeHead(302, { Location: authURL });
    return res.end();
  }

  // GET /auth/callback — OAuth callback from Google
  if (method === 'GET' && pathname === '/auth/callback') {
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(302, { Location: `/admin?error=${encodeURIComponent(error)}` });
      return res.end();
    }

    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const sessionId = await validateSession(req);

    if (!sessionId || !validateState(state, sessionId)) {
      res.writeHead(302, { Location: '/admin?error=invalid_state' });
      return res.end();
    }

    try {
      await exchangeCode(code);
      res.writeHead(302, { Location: '/admin?youtube=connected' });
      return res.end();
    } catch {
      res.writeHead(302, { Location: '/admin?error=auth_failed' });
      return res.end();
    }
  }

  // POST /api/import/subscriptions — trigger subscription import
  if (method === 'POST' && pathname === '/api/import/subscriptions') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const result = await importSubscriptions();
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // POST /api/import/liked — trigger liked video import
  if (method === 'POST' && pathname === '/api/import/liked') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const result = await importLikedVideos();
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // GET /api/import/status — return import progress
  if (method === 'GET' && pathname === '/api/import/status') {
    if (!(await requireAdmin(req, res))) return;
    return sendJSON(res, 200, getImportStatus());
  }

  // GET /api/profile — return current taste profile (admin, supports ?user=)
  if (method === 'GET' && pathname === '/api/profile') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const user = url.searchParams.get('user');
      const profile = user && VALID_USERS.includes(user)
        ? await getUserProfile(user)
        : await getProfile();
      return sendJSON(res, 200, { profile });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- Admin API routes ---

  // GET /api/channels — list channels (admin, supports ?user=)
  if (method === 'GET' && pathname === '/api/channels') {
    if (!(await requireAdmin(req, res))) return;
    const user = url.searchParams.get('user');
    const channels = user && VALID_USERS.includes(user)
      ? await getUserChannels(user)
      : await getChannels();
    return sendJSON(res, 200, { channels });
  }

  // POST /api/channels — add a manual channel (admin, supports ?user=)
  if (method === 'POST' && pathname === '/api/channels') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const body = await parseBody(req);
      if (!body.url && !body.channelId) {
        return sendJSON(res, 400, { error: 'url or channelId is required' });
      }

      const user = url.searchParams.get('user');

      let channelId;
      let title = body.title || '';

      if (body.channelId && /^UC[\w-]+$/.test(body.channelId)) {
        channelId = body.channelId;
      } else {
        const token = await getValidToken();
        channelId = await resolveChannel(body.url || body.channelId, token);
      }

      const channels = user && VALID_USERS.includes(user)
        ? await getUserChannels(user)
        : await getChannels();
      if (channels.some(ch => ch.channelId === channelId)) {
        return sendJSON(res, 409, { error: 'Channel already exists', channelId });
      }

      const channel = {
        channelId,
        title: title || `Channel ${channelId}`,
        source: 'manual',
        approved: true,
        blocked: false,
      };
      channels.push(channel);
      if (user && VALID_USERS.includes(user)) {
        await setUserChannels(user, channels);
      } else {
        await setChannels(channels);
      }
      return sendJSON(res, 201, { channel });
    } catch (err) {
      console.error('Add channel error:', err.message);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // PATCH /api/channels/:id — update channel (toggle approved, update notes)
  if (method === 'PATCH' && pathname.startsWith('/api/channels/')) {
    if (!(await requireAdmin(req, res))) return;
    const channelId = decodeURIComponent(pathname.slice('/api/channels/'.length));
    if (!channelId) {
      return sendJSON(res, 400, { error: 'Missing channel ID' });
    }
    try {
      const body = await parseBody(req);
      const user = url.searchParams.get('user');
      const channels = user && VALID_USERS.includes(user)
        ? await getUserChannels(user)
        : await getChannels();
      const idx = channels.findIndex(ch => ch.channelId === channelId);
      if (idx === -1) {
        return sendJSON(res, 404, { error: 'Channel not found' });
      }

      if (body.approved !== undefined) channels[idx].approved = !!body.approved;
      if (body.notes !== undefined) channels[idx].notes = body.notes;
      if (body.title !== undefined) channels[idx].title = body.title;

      if (user && VALID_USERS.includes(user)) {
        await setUserChannels(user, channels);
      } else {
        await setChannels(channels);
      }
      return sendJSON(res, 200, { channel: channels[idx] });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // DELETE /api/channels/:id — remove channel and optionally its videos
  if (method === 'DELETE' && pathname.startsWith('/api/channels/')) {
    if (!(await requireAdmin(req, res))) return;
    const channelId = decodeURIComponent(pathname.slice('/api/channels/'.length));
    if (!channelId) {
      return sendJSON(res, 400, { error: 'Missing channel ID' });
    }
    try {
      const user = url.searchParams.get('user');
      const channels = user && VALID_USERS.includes(user)
        ? await getUserChannels(user)
        : await getChannels();
      const idx = channels.findIndex(ch => ch.channelId === channelId);
      if (idx === -1) {
        return sendJSON(res, 404, { error: 'Channel not found' });
      }

      channels.splice(idx, 1);
      if (user && VALID_USERS.includes(user)) {
        await setUserChannels(user, channels);
      } else {
        await setChannels(channels);
      }

      // Optionally delete associated videos
      const deleteVideos = url.searchParams.get('deleteVideos') === 'true';
      let videosRemoved = 0;
      if (deleteVideos) {
        const videos = await getVideos();
        for (const [videoId, video] of Object.entries(videos)) {
          if (video.channelId === channelId) {
            delete videos[videoId];
            videosRemoved++;
          }
        }
        await setVideos(videos);
      }

      return sendJSON(res, 200, { ok: true, videosRemoved });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // GET /api/blocked — list all blocked items (admin, supports ?user=)
  if (method === 'GET' && pathname === '/api/blocked') {
    if (!(await requireAdmin(req, res))) return;
    const user = url.searchParams.get('user');
    const blocked = user && VALID_USERS.includes(user)
      ? await getUserBlocked(user)
      : await getBlocked();
    return sendJSON(res, 200, { blocked });
  }

  // POST /api/block — block a channel or video (admin, supports ?user=)
  if (method === 'POST' && pathname === '/api/block') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const body = await parseBody(req);
      if (!body.type || !body.id) {
        return sendJSON(res, 400, { error: 'type and id are required' });
      }
      if (body.type !== 'channel' && body.type !== 'video') {
        return sendJSON(res, 400, { error: 'type must be "channel" or "video"' });
      }

      const user = url.searchParams.get('user');
      const blocked = user && VALID_USERS.includes(user)
        ? await getUserBlocked(user)
        : await getBlocked();
      const list = body.type === 'channel' ? blocked.channels : blocked.videos;

      if (!list.includes(body.id)) {
        list.push(body.id);
      }
      if (user && VALID_USERS.includes(user)) {
        await setUserBlocked(user, blocked);
      } else {
        await setBlocked(blocked);
      }

      return sendJSON(res, 200, { ok: true });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // DELETE /api/block/:type/:id — unblock a channel or video
  if (method === 'DELETE' && pathname.startsWith('/api/block/')) {
    if (!(await requireAdmin(req, res))) return;
    const rest = pathname.slice('/api/block/'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return sendJSON(res, 400, { error: 'Expected /api/block/:type/:id' });
    }
    const type = rest.slice(0, slashIdx);
    const id = decodeURIComponent(rest.slice(slashIdx + 1));

    if (type !== 'channel' && type !== 'video') {
      return sendJSON(res, 400, { error: 'type must be "channel" or "video"' });
    }
    if (!id) {
      return sendJSON(res, 400, { error: 'Missing id' });
    }

    const blocked = await getBlocked();
    const list = type === 'channel' ? blocked.channels : blocked.videos;
    const idx = list.indexOf(id);
    if (idx === -1) {
      return sendJSON(res, 404, { error: 'Not found in blocked list' });
    }
    list.splice(idx, 1);
    await setBlocked(blocked);

    return sendJSON(res, 200, { ok: true });
  }

  // GET /api/config — return current config
  if (method === 'GET' && pathname === '/api/config') {
    if (!(await requireAdmin(req, res))) return;
    const config = await getConfig();
    return sendJSON(res, 200, { config });
  }

  // POST /api/config — update config fields
  if (method === 'POST' && pathname === '/api/config') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const body = await parseBody(req);
      const config = await getConfig();

      // Only allow updating known fields
      if (body.guidelines !== undefined) config.guidelines = String(body.guidelines);
      if (body.searchBudgetPerDay !== undefined) config.searchBudgetPerDay = Number(body.searchBudgetPerDay);
      if (body.scraperEnabled !== undefined) config.scraperEnabled = !!body.scraperEnabled;
      if (body.parentNotes !== undefined) config.parentNotes = String(body.parentNotes);

      await setConfig(config);
      return sendJSON(res, 200, { config });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // POST /api/refresh — trigger manual RSS refresh
  if (method === 'POST' && pathname === '/api/refresh') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const results = await refreshAllChannels();
      return sendJSON(res, 200, { results });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // POST /api/profile/rebuild — regenerate taste profile from current data
  if (method === 'POST' && pathname === '/api/profile/rebuild') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const profile = await rebuildProfile();
      return sendJSON(res, 200, { profile });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // GET /api/youtube/status — OAuth connection status
  if (method === 'GET' && pathname === '/api/youtube/status') {
    if (!(await requireAdmin(req, res))) return;
    const oauthConfigured = !!(YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET);
    try {
      const tokens = await getTokens();
      const connected = !!(tokens && tokens.access_token);
      return sendJSON(res, 200, {
        connected,
        oauthConfigured,
        expiryTime: tokens?.expiry_time || null,
        hasRefreshToken: !!(tokens?.refresh_token),
      });
    } catch {
      return sendJSON(res, 200, { connected: false, oauthConfigured, expiryTime: null, hasRefreshToken: false });
    }
  }

  // DELETE /api/youtube — disconnect YouTube (clear tokens)
  if (method === 'DELETE' && pathname === '/api/youtube') {
    if (!(await requireAdmin(req, res))) return;
    try {
      await setTokens(null);
      return sendJSON(res, 200, { ok: true });
    } catch {
      return sendJSON(res, 500, { error: 'Failed to disconnect' });
    }
  }

  // GET /api/status — system status
  if (method === 'GET' && pathname === '/api/status') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const [channels, videos, tokens, history] = await Promise.all([
        getChannels(),
        getVideos(),
        getTokens(),
        getHistory(),
      ]);

      const approvedCount = channels.filter(ch => ch.approved).length;
      const videoCount = Object.keys(videos).length;

      let oauthStatus = 'none';
      if (tokens && tokens.access_token) {
        oauthStatus = (tokens.expiry_time && Date.now() < tokens.expiry_time) ? 'connected' : 'expired';
      }

      return sendJSON(res, 200, {
        uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
        channels: { approved: approvedCount, total: channels.length },
        channelCount: channels.length,
        videosCached: videoCount,
        videoCount: videoCount,
        watchCount: (history || []).length,
        quotaUsedToday: getQuotaUsed(),
        lastPollAt: getLastPollAt(),
        scraperEnabled: SCRAPER_ENABLED,
        oauthStatus,
        youtubeConnected: oauthStatus === 'connected',
      });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // GET /api/history — watch history (paginated, newest first, enriched)
  if (method === 'GET' && pathname === '/api/history') {
    if (!(await requireAdmin(req, res))) return;
    try {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const [history, videos] = await Promise.all([getHistory(), getVideos()]);

      // Newest first, enriched with video metadata
      const reversed = [...history].reverse();
      const page = reversed.slice(offset, offset + limit).map(entry => {
        const video = videos[entry.videoId];
        return {
          ...entry,
          title: video?.title || entry.videoId,
          channelTitle: video?.channelTitle || '',
        };
      });
      return sendJSON(res, 200, { history: page, total: history.length });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // GET /admin — serves the admin page (has its own login form)
  if (method === 'GET' && pathname === '/admin') {
    return serveStatic(res, join('public', 'admin.html'));
  }

  // GET / — kid-facing
  if (method === 'GET' && pathname === '/') {
    return serveStatic(res, join('public', 'index.html'));
  }

  // Static files from public/
  if (method === 'GET' && pathname.startsWith('/')) {
    const publicDir = resolve('public');
    const resolved = resolve('public', pathname.slice(1));
    if (!resolved.startsWith(publicDir)) {
      return sendJSON(res, 403, { error: 'Forbidden' });
    }
    return serveStatic(res, resolved);
  }

  sendJSON(res, 404, { error: 'Not found' });
}

export function createApp() {
  return createServer(handleRequest);
}

// Auto-start when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  const server = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`YourTube server listening on ${HOST}:${PORT}`);
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  http://${net.address}:${PORT}`);
        }
      }
    }
    // Start background RSS polling (every 30 minutes)
    startPolling();
  });
}
