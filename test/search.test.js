import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Set unique data dir BEFORE any project module imports
const testDataName = `test-data-search-${randomBytes(4).toString('hex')}`;
process.env.YOURTUBE_DATA_DIR = testDataName;

const { setChannels, setVideos, setBlocked, setLikes, getSearchLog } =
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
  await setVideos({});
  await setBlocked({ channels: [], videos: [] });
  await setLikes([]);
}

describe('Search API', () => {
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

  test('GET /api/search requires auth', async () => {
    const res = await globalThis.fetch(new URL('/api/search?q=test', baseURL));
    assert.equal(res.status, 401);
  });

  test('GET /api/search requires query', async () => {
    const res = await httpFetch('/api/search');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Query is required');
  });

  test('GET /api/search rejects query over 100 chars', async () => {
    const longQuery = 'a'.repeat(101);
    const res = await httpFetch(`/api/search?q=${longQuery}`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Query too long (max 100 chars)');
  });

  test('GET /api/search returns videos array and likedVideoIds', async () => {
    // This test will hit the real search endpoint which may fail without OAuth.
    // We accept either a success with videos or a 200 with empty + message.
    const res = await httpFetch('/api/search?q=minecraft');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.videos));
    assert.ok(Array.isArray(body.likedVideoIds));
  });
});
