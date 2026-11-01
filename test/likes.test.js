import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Set unique data dir BEFORE any project module imports
const testDataName = `test-data-likes-${randomBytes(4).toString('hex')}`;
process.env.YOURTUBE_DATA_DIR = testDataName;

const { setChannels, setVideos, setBlocked, setLikes, getLikes } =
  await import('../lib/store.js');
const { DATA_DIR } =
  await import('../config.js');

after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});

async function seedData() {
  await setChannels([{
    channelId: 'UC1',
    title: 'Test Channel',
    approved: true,
    blocked: false,
  }]);
  await setVideos({
    vid1: {
      title: 'Test Video',
      channelId: 'UC1',
      channelTitle: 'Test Channel',
      publishedAt: '2024-06-01T00:00:00Z',
      thumbnails: { default: { url: 'https://example.com/thumb.jpg' } },
    },
  });
  await setBlocked({ channels: [], videos: [] });
  await setLikes([]);
}

describe('Likes API', () => {
  let server;
  let baseURL;
  let sessionCookie;

  async function httpFetch(path, opts = {}) {
    const url = new URL(path, baseURL);
    const headers = { ...(opts.headers || {}) };
    if (sessionCookie) {
      headers.Cookie = `session=${sessionCookie}`;
    }
    return globalThis.fetch(url, { ...opts, headers });
  }

  before(async () => {
    await seedData();

    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseURL = `http://127.0.0.1:${addr.port}`;

    const loginRes = await globalThis.fetch(new URL('/auth/login', baseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'changeme' }),
    });
    const setCookie = loginRes.headers.get('set-cookie') || '';
    const match = setCookie.match(/session=([^;]+)/);
    sessionCookie = match ? match[1] : null;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('POST /api/likes requires auth', async () => {
    const res = await globalThis.fetch(new URL('/api/likes', baseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'vid1' }),
    });
    assert.equal(res.status, 401);
  });

  test('POST /api/likes requires videoId', async () => {
    const res = await httpFetch('/api/likes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/likes toggles like on', async () => {
    const res = await httpFetch('/api/likes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: 'vid1',
        title: 'Test Video',
        channelTitle: 'Test Channel',
        channelId: 'UC1',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.liked, true);

    const likes = await getLikes();
    assert.equal(likes.length, 1);
    assert.equal(likes[0].videoId, 'vid1');
    assert.equal(likes[0].title, 'Test Video');
    assert.ok(likes[0].likedAt);
  });

  test('POST /api/likes toggles like off', async () => {
    // vid1 was liked in previous test
    const res = await httpFetch('/api/likes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'vid1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.liked, false);

    const likes = await getLikes();
    assert.equal(likes.length, 0);
  });

  test('GET /api/feed returns likedVideoIds', async () => {
    // Like a video first
    await httpFetch('/api/likes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'vid1', title: 'Test', channelTitle: 'TC', channelId: 'UC1' }),
    });

    const res = await httpFetch('/api/feed');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.likedVideoIds));
    assert.ok(body.likedVideoIds.includes('vid1'));
  });
});
