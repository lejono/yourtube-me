import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// config.js computes DATA_DIR = join(__dirname, YOURTUBE_DATA_DIR),
// so we must compute the actual store path consistently.
const __testdir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__testdir, '..');
const testDataDir = await mkdtemp(join(projectDir, '.test-admin-'));
// Make it relative so join(__dirname, relPath) == testDataDir
const relDataDir = testDataDir.slice(projectDir.length + 1);
process.env.YOURTUBE_DATA_DIR = relDataDir;

const { createApp } = await import('../server.js');

let server;
let baseURL;

async function fetch(path, opts = {}) {
  const url = new URL(path, baseURL);
  return globalThis.fetch(url, { redirect: 'manual', ...opts });
}

async function login(password = 'changeme') {
  return fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function getSessionCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

async function authedFetch(cookie, path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { ...opts.headers, Cookie: `session=${cookie}` },
  });
}

let cookie;

before(async () => {
  await mkdir(testDataDir, { recursive: true });
  server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  // Login once to get a session cookie
  const loginRes = await login();
  cookie = getSessionCookie(loginRes);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(testDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset data files to defaults before each test
  await writeFile(join(testDataDir, 'channels.json'), '[]');
  await writeFile(join(testDataDir, 'blocked.json'), JSON.stringify({ channels: [], videos: [] }));
  await writeFile(join(testDataDir, 'config.json'), JSON.stringify({
    guidelines: '',
    searchBudgetPerDay: 10,
    scraperEnabled: true,
    parentNotes: '',
  }));
  await writeFile(join(testDataDir, 'history.json'), '[]');
  await writeFile(join(testDataDir, 'videos.json'), '{}');
  await writeFile(join(testDataDir, 'tokens.json'), 'null');
});

// -- Channels API --

describe('Channels API', () => {
  it('GET /api/channels returns empty list initially', async () => {
    const res = await authedFetch(cookie, '/api/channels');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.channels, []);
  });

  it('GET /api/channels requires auth', async () => {
    const res = await fetch('/api/channels');
    assert.equal(res.status, 401);
  });

  it('POST /api/channels adds a channel', async () => {
    const res = await authedFetch(cookie, '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 'UC123', title: 'Test Channel' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.channel.channelId, 'UC123');
    assert.equal(body.channel.source, 'manual');
    assert.equal(body.channel.approved, true);

    const listRes = await authedFetch(cookie, '/api/channels');
    const data = await listRes.json();
    assert.equal(data.channels.length, 1);
    assert.equal(data.channels[0].channelId, 'UC123');
    assert.equal(data.channels[0].title, 'Test Channel');
    assert.equal(data.channels[0].source, 'manual');
    assert.equal(data.channels[0].approved, true);
  });

  it('POST /api/channels rejects duplicates', async () => {
    await authedFetch(cookie, '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 'UC123', title: 'Test' }),
    });

    const res = await authedFetch(cookie, '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 'UC123', title: 'Test Again' }),
    });
    assert.equal(res.status, 409);
  });

  it('POST /api/channels requires url or channelId', async () => {
    const res = await authedFetch(cookie, '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/channels/:id toggles approval', async () => {
    await authedFetch(cookie, '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 'UC456', title: 'Toggle Test' }),
    });

    const patchRes = await authedFetch(cookie, '/api/channels/UC456', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.channel.approved, false);

    // Verify it persisted
    const listRes = await authedFetch(cookie, '/api/channels');
    const data = await listRes.json();
    assert.equal(data.channels[0].approved, false);
  });

  it('PATCH /api/channels/:id returns 404 for missing channel', async () => {
    const res = await authedFetch(cookie, '/api/channels/UCnope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/channels/:id removes a channel', async () => {
    await authedFetch(cookie, '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 'UCdel', title: 'Delete Me' }),
    });

    const delRes = await authedFetch(cookie, '/api/channels/UCdel', {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);

    const listRes = await authedFetch(cookie, '/api/channels');
    const data = await listRes.json();
    assert.equal(data.channels.length, 0);
  });

  it('DELETE /api/channels/:id returns 404 for missing channel', async () => {
    const res = await authedFetch(cookie, '/api/channels/UCnope', {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
  });
});

// -- Config API --

describe('Config API', () => {
  it('GET /api/config returns defaults', async () => {
    const res = await authedFetch(cookie, '/api/config');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.config.guidelines, '');
    assert.equal(data.config.searchBudgetPerDay, 10);
  });

  it('GET /api/config requires auth', async () => {
    const res = await fetch('/api/config');
    assert.equal(res.status, 401);
  });

  it('POST /api/config saves guidelines', async () => {
    const res = await authedFetch(cookie, '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidelines: 'No scary content' }),
    });
    assert.equal(res.status, 200);

    const getRes = await authedFetch(cookie, '/api/config');
    const data = await getRes.json();
    assert.equal(data.config.guidelines, 'No scary content');
    // Other fields should be unchanged
    assert.equal(data.config.searchBudgetPerDay, 10);
  });

  it('POST /api/config only updates known fields', async () => {
    const res = await authedFetch(cookie, '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidelines: 'Updated', unknownField: 'bad' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.config.guidelines, 'Updated');
    assert.equal(data.config.unknownField, undefined);
  });
});

// -- History API --

describe('History API', () => {
  it('GET /api/history returns empty initially', async () => {
    const res = await authedFetch(cookie, '/api/history');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.history, []);
  });

  it('GET /api/history returns enriched history', async () => {
    // Write some history and video data
    await writeFile(join(testDataDir, 'history.json'), JSON.stringify([
      { videoId: 'v1', startedAt: '2026-03-20T10:00:00Z', endedAt: '2026-03-20T10:05:00Z', duration: 300 },
      { videoId: 'v2', startedAt: '2026-03-21T12:00:00Z', endedAt: null, duration: null },
    ]));
    await writeFile(join(testDataDir, 'videos.json'), JSON.stringify({
      v1: { title: 'First Video', channelTitle: 'Channel A' },
      v2: { title: 'Second Video', channelTitle: 'Channel B' },
    }));

    const res = await authedFetch(cookie, '/api/history');
    const data = await res.json();
    assert.equal(data.history.length, 2);
    // Newest first
    assert.equal(data.history[0].videoId, 'v2');
    assert.equal(data.history[0].title, 'Second Video');
    assert.equal(data.history[1].title, 'First Video');
  });

  it('GET /api/history requires auth', async () => {
    const res = await fetch('/api/history');
    assert.equal(res.status, 401);
  });
});

// -- Blocked API --

describe('Blocked API', () => {
  it('GET /api/blocked returns empty initially', async () => {
    const res = await authedFetch(cookie, '/api/blocked');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.blocked.channels, []);
    assert.deepEqual(data.blocked.videos, []);
  });

  it('POST /api/block adds a blocked channel', async () => {
    const res = await authedFetch(cookie, '/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'channel', id: 'UCbad' }),
    });
    assert.equal(res.status, 200);

    const getRes = await authedFetch(cookie, '/api/blocked');
    const data = await getRes.json();
    assert.deepEqual(data.blocked.channels, ['UCbad']);
    assert.deepEqual(data.blocked.videos, []);
  });

  it('POST /api/block adds a blocked video', async () => {
    const res = await authedFetch(cookie, '/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'video', id: 'vid123' }),
    });
    assert.equal(res.status, 200);

    const getRes = await authedFetch(cookie, '/api/blocked');
    const data = await getRes.json();
    assert.deepEqual(data.blocked.videos, ['vid123']);
  });

  it('POST /api/block does not add duplicates', async () => {
    await authedFetch(cookie, '/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'channel', id: 'UCdup' }),
    });
    await authedFetch(cookie, '/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'channel', id: 'UCdup' }),
    });

    const getRes = await authedFetch(cookie, '/api/blocked');
    const data = await getRes.json();
    assert.equal(data.blocked.channels.filter(c => c === 'UCdup').length, 1);
  });

  it('POST /api/block rejects invalid type', async () => {
    const res = await authedFetch(cookie, '/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'invalid', id: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('DELETE /api/block/:type/:id unblocks', async () => {
    await authedFetch(cookie, '/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'channel', id: 'UCunblock' }),
    });

    const delRes = await authedFetch(cookie, '/api/block/channel/UCunblock', {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);

    const getRes = await authedFetch(cookie, '/api/blocked');
    const data = await getRes.json();
    assert.equal(data.blocked.channels.includes('UCunblock'), false);
  });

  it('DELETE /api/block/:type/:id validates type', async () => {
    const res = await authedFetch(cookie, '/api/block/invalid/x', {
      method: 'DELETE',
    });
    assert.equal(res.status, 400);
  });
});

// -- YouTube Status API --

describe('YouTube Status API', () => {
  it('GET /api/youtube/status shows not connected when no tokens', async () => {
    const res = await authedFetch(cookie, '/api/youtube/status');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.connected, false);
  });

  it('GET /api/youtube/status shows connected when tokens exist', async () => {
    await writeFile(join(testDataDir, 'tokens.json'), JSON.stringify({
      access_token: 'ya29.test',
      refresh_token: 'rt.test',
      expiry_time: Date.now() + 3600000,
    }));

    const res = await authedFetch(cookie, '/api/youtube/status');
    const data = await res.json();
    assert.equal(data.connected, true);
    assert.equal(data.hasRefreshToken, true);
    assert.ok(data.expiryTime);
  });

  it('DELETE /api/youtube clears tokens', async () => {
    await writeFile(join(testDataDir, 'tokens.json'), JSON.stringify({
      access_token: 'ya29.test',
      refresh_token: 'rt.test',
    }));

    const delRes = await authedFetch(cookie, '/api/youtube', { method: 'DELETE' });
    assert.equal(delRes.status, 200);

    const statusRes = await authedFetch(cookie, '/api/youtube/status');
    const data = await statusRes.json();
    assert.equal(data.connected, false);
  });
});

// -- Status API --

describe('Status API', () => {
  it('GET /api/status returns server status', async () => {
    const res = await authedFetch(cookie, '/api/status');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.uptime, 'number');
    assert.ok(data.uptime >= 0);
    assert.equal(data.channelCount, 0);
    assert.equal(data.videoCount, 0);
    assert.equal(data.watchCount, 0);
    assert.equal(data.youtubeConnected, false);
  });

  it('GET /api/status requires auth', async () => {
    const res = await fetch('/api/status');
    assert.equal(res.status, 401);
  });

  it('GET /api/status reflects actual data counts', async () => {
    await writeFile(join(testDataDir, 'channels.json'), JSON.stringify([
      { channelId: 'UC1', title: 'Ch1' },
      { channelId: 'UC2', title: 'Ch2' },
    ]));
    await writeFile(join(testDataDir, 'videos.json'), JSON.stringify({
      v1: { title: 'V1' },
      v2: { title: 'V2' },
      v3: { title: 'V3' },
    }));
    await writeFile(join(testDataDir, 'history.json'), JSON.stringify([
      { videoId: 'v1' },
    ]));

    const res = await authedFetch(cookie, '/api/status');
    const data = await res.json();
    assert.equal(data.channelCount, 2);
    assert.equal(data.videoCount, 3);
    assert.equal(data.watchCount, 1);
  });
});

// -- Admin HTML serving --

describe('Admin page', () => {
  it('GET /admin serves admin.html when authenticated', async () => {
    const res = await authedFetch(cookie, '/admin');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('YourTube Admin'));
    assert.ok(text.includes('dashboard'));
  });

  it('GET /admin serves login form without session', async () => {
    const res = await fetch('/admin');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('login-form'));
  });

  it('admin CSS is served', async () => {
    const res = await fetch('/css/admin.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/css');
  });

  it('admin JS is served', async () => {
    const res = await fetch('/js/admin.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript');
  });
});
