import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Isolated data dir
const testDataName = `test-data-admin-${randomBytes(4).toString('hex')}`;
process.env.YOURTUBE_DATA_DIR = testDataName;

const { setChannels, setVideos, setBlocked, setConfig, setHistory, setTokens,
        getChannels, getVideos, getBlocked, getConfig, getHistory } =
  await import('../lib/store.js');
const { _setFetchForTesting } = await import('../lib/youtube.js');
const { DATA_DIR } = await import('../config.js');

// Stub youtube fetch so resolveChannel doesn't hit real API
_setFetchForTesting(async (url) => {
  // Handle RSS fetch requests
  if (url.includes('feeds/videos.xml')) {
    return { ok: true, status: 200, text: async () => '<feed></feed>' };
  }
  // Handle channel resolve by handle
  if (url.includes('googleapis.com/youtube/v3/channels')) {
    return {
      ok: true,
      json: async () => ({
        items: [{ id: 'UCresolved123', snippet: { title: 'Resolved Channel' } }],
      }),
    };
  }
  return { ok: true, json: async () => ({}), text: async () => '' };
});

// --- Helpers ---

async function seedDefaults() {
  await setChannels([
    { channelId: 'UC_alpha', title: 'Alpha', source: 'oauth', approved: true, blocked: false },
    { channelId: 'UC_beta', title: 'Beta', source: 'manual', approved: false, blocked: false },
  ]);
  await setVideos({
    vid1: { title: 'Video One', channelId: 'UC_alpha', channelTitle: 'Alpha', publishedAt: '2024-06-01T00:00:00Z', thumbnails: {} },
    vid2: { title: 'Video Two', channelId: 'UC_alpha', channelTitle: 'Alpha', publishedAt: '2024-06-02T00:00:00Z', thumbnails: {} },
    vid3: { title: 'Video Three', channelId: 'UC_beta', channelTitle: 'Beta', publishedAt: '2024-06-03T00:00:00Z', thumbnails: {} },
  });
  await setBlocked({ channels: [], videos: [] });
  await setConfig({ guidelines: 'Be safe', searchBudgetPerDay: 10, scraperEnabled: true, parentNotes: '' });
  await setHistory([
    { videoId: 'vid1', startedAt: '2024-06-01T10:00:00Z', endedAt: '2024-06-01T10:05:00Z', duration: 300 },
    { videoId: 'vid2', startedAt: '2024-06-02T10:00:00Z', endedAt: null, duration: null },
  ]);
}

// --- Server setup ---

let server;
let baseURL;
let sessionCookie;

async function httpFetch(path, opts = {}) {
  const url = new URL(path, baseURL);
  const headers = { ...(opts.headers || {}) };
  if (sessionCookie) {
    headers.Cookie = `session=${sessionCookie}`;
  }
  return globalThis.fetch(url, { ...opts, headers, redirect: 'manual' });
}

async function httpJSON(method, path, body) {
  return httpFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  await seedDefaults();

  const { createApp } = await import('../server.js');
  server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseURL = `http://127.0.0.1:${addr.port}`;

  // Login to get admin session
  const loginRes = await globalThis.fetch(new URL('/auth/login', baseURL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'changeme' }),
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const match = setCookie.match(/session=([^;]+)/);
  sessionCookie = match ? match[1] : null;
  assert.ok(sessionCookie, 'Should have session cookie');
});

after(async () => {
  _setFetchForTesting(globalThis.fetch);
  await new Promise(resolve => server.close(resolve));
  await rm(DATA_DIR, { recursive: true, force: true });
});

// === Unauthenticated access ===

describe('admin routes require auth', () => {
  async function unauthFetch(path, method = 'GET') {
    const url = new URL(path, baseURL);
    return globalThis.fetch(url, { method });
  }

  test('GET /api/channels returns 401 without session', async () => {
    const res = await unauthFetch('/api/channels');
    assert.equal(res.status, 401);
  });

  test('POST /api/block returns 401 without session', async () => {
    const res = await unauthFetch('/api/block', 'POST');
    assert.equal(res.status, 401);
  });

  test('GET /api/config returns 401 without session', async () => {
    const res = await unauthFetch('/api/config');
    assert.equal(res.status, 401);
  });

  test('GET /api/status returns 401 without session', async () => {
    const res = await unauthFetch('/api/status');
    assert.equal(res.status, 401);
  });

  test('GET /api/history returns 401 without session', async () => {
    const res = await unauthFetch('/api/history');
    assert.equal(res.status, 401);
  });

  test('POST /api/refresh returns 401 without session', async () => {
    const res = await unauthFetch('/api/refresh', 'POST');
    assert.equal(res.status, 401);
  });
});

// === Channels CRUD ===

describe('GET /api/channels', () => {
  beforeEach(() => seedDefaults());

  test('returns all channels', async () => {
    const res = await httpFetch('/api/channels');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.channels));
    assert.equal(body.channels.length, 2);
  });

  test('includes approval status', async () => {
    const res = await httpFetch('/api/channels');
    const body = await res.json();
    const alpha = body.channels.find(ch => ch.channelId === 'UC_alpha');
    const beta = body.channels.find(ch => ch.channelId === 'UC_beta');
    assert.equal(alpha.approved, true);
    assert.equal(beta.approved, false);
  });
});

describe('POST /api/channels', () => {
  beforeEach(() => seedDefaults());

  test('adds a channel by channelId', async () => {
    const res = await httpJSON('POST', '/api/channels', { channelId: 'UCnewChannel123' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.channel.channelId, 'UCnewChannel123');
    assert.equal(body.channel.source, 'manual');
    assert.equal(body.channel.approved, true);
  });

  test('rejects duplicate channel', async () => {
    const res = await httpJSON('POST', '/api/channels', { channelId: 'UC_alpha' });
    assert.equal(res.status, 409);
  });

  test('rejects empty request', async () => {
    const res = await httpJSON('POST', '/api/channels', {});
    assert.equal(res.status, 400);
  });

  test('resolves URL via youtube API', async () => {
    // Need a stored token for resolveChannel to work
    await setTokens({
      access_token: 'fake-token',
      refresh_token: 'fake-refresh',
      expiry_time: Date.now() + 3600000,
    });
    const res = await httpJSON('POST', '/api/channels', { url: 'https://www.youtube.com/@testhandle' });
    // Our mock resolves everything to UCresolved123
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.channel.channelId, 'UCresolved123');
  });
});

describe('PATCH /api/channels/:id', () => {
  beforeEach(() => seedDefaults());

  test('toggles approval', async () => {
    const res = await httpJSON('PATCH', '/api/channels/UC_beta', { approved: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.channel.approved, true);

    // Verify persisted
    const channels = await getChannels();
    const beta = channels.find(ch => ch.channelId === 'UC_beta');
    assert.equal(beta.approved, true);
  });

  test('updates notes', async () => {
    const res = await httpJSON('PATCH', '/api/channels/UC_alpha', { notes: 'Safe for kids' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.channel.notes, 'Safe for kids');
  });

  test('returns 404 for unknown channel', async () => {
    const res = await httpJSON('PATCH', '/api/channels/UC_nonexistent', { approved: true });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/channels/:id', () => {
  beforeEach(() => seedDefaults());

  test('removes a channel', async () => {
    const res = await httpFetch('/api/channels/UC_beta', { method: 'DELETE' });
    assert.equal(res.status, 200);

    const channels = await getChannels();
    assert.ok(!channels.some(ch => ch.channelId === 'UC_beta'));
  });

  test('deletes associated videos when requested', async () => {
    const res = await httpFetch('/api/channels/UC_alpha?deleteVideos=true', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.videosRemoved, 2); // vid1 and vid2 belong to UC_alpha

    const videos = await getVideos();
    assert.ok(!videos['vid1']);
    assert.ok(!videos['vid2']);
    assert.ok(videos['vid3']); // UC_beta video preserved
  });

  test('preserves videos by default', async () => {
    await httpFetch('/api/channels/UC_alpha', { method: 'DELETE' });
    const videos = await getVideos();
    assert.ok(videos['vid1']); // still there
  });

  test('returns 404 for unknown channel', async () => {
    const res = await httpFetch('/api/channels/UC_nonexistent', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

// === Blocking ===

describe('POST /api/block', () => {
  beforeEach(() => seedDefaults());

  test('blocks a channel', async () => {
    const res = await httpJSON('POST', '/api/block', { type: 'channel', id: 'UC_alpha' });
    assert.equal(res.status, 200);

    const blocked = await getBlocked();
    assert.ok(blocked.channels.includes('UC_alpha'));
  });

  test('blocks a video', async () => {
    const res = await httpJSON('POST', '/api/block', { type: 'video', id: 'vid1' });
    assert.equal(res.status, 200);

    const blocked = await getBlocked();
    assert.ok(blocked.videos.includes('vid1'));
  });

  test('idempotent — does not duplicate', async () => {
    await httpJSON('POST', '/api/block', { type: 'video', id: 'vid1' });
    await httpJSON('POST', '/api/block', { type: 'video', id: 'vid1' });

    const blocked = await getBlocked();
    assert.equal(blocked.videos.filter(v => v === 'vid1').length, 1);
  });

  test('rejects invalid type', async () => {
    const res = await httpJSON('POST', '/api/block', { type: 'playlist', id: 'abc' });
    assert.equal(res.status, 400);
  });

  test('rejects missing fields', async () => {
    const res = await httpJSON('POST', '/api/block', { type: 'channel' });
    assert.equal(res.status, 400);
  });
});

describe('blocked channel removes from feed', () => {
  beforeEach(() => seedDefaults());

  test('blocking a channel excludes its videos from feed', async () => {
    // First verify vid1 appears in feed
    let res = await httpFetch('/api/feed');
    let body = await res.json();
    assert.ok(body.videos.some(v => v.videoId === 'vid1'));

    // Block the channel
    await httpJSON('POST', '/api/block', { type: 'channel', id: 'UC_alpha' });

    // Now feed should exclude UC_alpha videos
    res = await httpFetch('/api/feed');
    body = await res.json();
    assert.ok(!body.videos.some(v => v.channelId === 'UC_alpha'));
  });

  test('blocking a video excludes it from feed', async () => {
    // Block vid1
    await httpJSON('POST', '/api/block', { type: 'video', id: 'vid1' });

    const res = await httpFetch('/api/feed');
    const body = await res.json();
    assert.ok(!body.videos.some(v => v.videoId === 'vid1'));
    // vid2 from same channel should still be there
    assert.ok(body.videos.some(v => v.videoId === 'vid2'));
  });
});

describe('DELETE /api/block/:type/:id', () => {
  beforeEach(async () => {
    await seedDefaults();
    await setBlocked({ channels: ['UC_blocked1'], videos: ['vid_blocked1'] });
  });

  test('unblocks a channel', async () => {
    const res = await httpFetch('/api/block/channel/UC_blocked1', { method: 'DELETE' });
    assert.equal(res.status, 200);

    const blocked = await getBlocked();
    assert.ok(!blocked.channels.includes('UC_blocked1'));
  });

  test('unblocks a video', async () => {
    const res = await httpFetch('/api/block/video/vid_blocked1', { method: 'DELETE' });
    assert.equal(res.status, 200);

    const blocked = await getBlocked();
    assert.ok(!blocked.videos.includes('vid_blocked1'));
  });

  test('unblock restores to feed', async () => {
    // Set up: block UC_alpha, verify excluded, then unblock
    await setBlocked({ channels: ['UC_alpha'], videos: [] });
    let res = await httpFetch('/api/feed');
    let body = await res.json();
    assert.ok(!body.videos.some(v => v.channelId === 'UC_alpha'));

    // Unblock
    await httpFetch('/api/block/channel/UC_alpha', { method: 'DELETE' });
    res = await httpFetch('/api/feed');
    body = await res.json();
    assert.ok(body.videos.some(v => v.channelId === 'UC_alpha'));
  });

  test('returns 404 if item not blocked', async () => {
    const res = await httpFetch('/api/block/channel/UC_not_blocked', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  test('rejects invalid type', async () => {
    const res = await httpFetch('/api/block/playlist/abc', { method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/blocked', () => {
  beforeEach(async () => {
    await setBlocked({ channels: ['UC_x'], videos: ['vid_y'] });
  });

  test('returns blocked lists', async () => {
    const res = await httpFetch('/api/blocked');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.blocked.channels, ['UC_x']);
    assert.deepEqual(body.blocked.videos, ['vid_y']);
  });
});

// === Configuration ===

describe('GET /api/config', () => {
  beforeEach(() => seedDefaults());

  test('returns current config', async () => {
    const res = await httpFetch('/api/config');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.guidelines, 'Be safe');
    assert.equal(body.config.searchBudgetPerDay, 10);
  });
});

describe('POST /api/config', () => {
  beforeEach(() => seedDefaults());

  test('updates config fields', async () => {
    const res = await httpJSON('POST', '/api/config', {
      guidelines: 'No violence',
      searchBudgetPerDay: 5,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.guidelines, 'No violence');
    assert.equal(body.config.searchBudgetPerDay, 5);

    // Verify persisted
    const config = await getConfig();
    assert.equal(config.guidelines, 'No violence');
    assert.equal(config.searchBudgetPerDay, 5);
    // Unchanged fields preserved
    assert.equal(config.scraperEnabled, true);
  });

  test('partial update preserves other fields', async () => {
    await httpJSON('POST', '/api/config', { parentNotes: 'My notes' });
    const config = await getConfig();
    assert.equal(config.parentNotes, 'My notes');
    assert.equal(config.guidelines, 'Be safe'); // unchanged
  });
});

// === Content Refresh ===

describe('POST /api/refresh', () => {
  beforeEach(() => seedDefaults());

  test('triggers RSS refresh and returns results', async () => {
    const res = await httpJSON('POST', '/api/refresh');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.results));
  });
});

// === Status ===

describe('GET /api/status', () => {
  beforeEach(() => seedDefaults());

  test('returns status object with expected fields', async () => {
    const res = await httpFetch('/api/status');
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.uptime >= 0);
    assert.equal(typeof body.channels, 'object');
    assert.equal(typeof body.channels.approved, 'number');
    assert.equal(typeof body.channels.total, 'number');
    assert.equal(typeof body.videosCached, 'number');
    assert.equal(typeof body.quotaUsedToday, 'number');
    assert.equal(typeof body.scraperEnabled, 'boolean');
    assert.ok(['none', 'connected', 'expired'].includes(body.oauthStatus));
  });

  test('reports correct channel counts', async () => {
    const res = await httpFetch('/api/status');
    const body = await res.json();
    assert.equal(body.channels.total, 2);
    assert.equal(body.channels.approved, 1); // only UC_alpha is approved
  });

  test('reports correct video count', async () => {
    const res = await httpFetch('/api/status');
    const body = await res.json();
    assert.equal(body.videosCached, 3);
  });
});

// === History ===

describe('GET /api/history', () => {
  beforeEach(() => seedDefaults());

  test('returns history newest first', async () => {
    const res = await httpFetch('/api/history');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.history));
    assert.equal(body.history.length, 2);
    // Newest first: vid2 entry was added second
    assert.equal(body.history[0].videoId, 'vid2');
    assert.equal(body.history[1].videoId, 'vid1');
  });

  test('respects limit parameter', async () => {
    const res = await httpFetch('/api/history?limit=1');
    const body = await res.json();
    assert.equal(body.history.length, 1);
  });

  test('respects offset parameter', async () => {
    const res = await httpFetch('/api/history?offset=1&limit=10');
    const body = await res.json();
    assert.equal(body.history.length, 1);
    assert.equal(body.history[0].videoId, 'vid1');
  });

  test('returns total count', async () => {
    const res = await httpFetch('/api/history');
    const body = await res.json();
    assert.equal(body.total, 2);
  });
});
