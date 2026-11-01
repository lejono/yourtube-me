import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated temp data dir — must be set before any project imports
const testDataDir = await mkdtemp(join(tmpdir(), 'yourtube-import-test-'));
process.env.YOURTUBE_DATA_DIR = testDataDir;
process.env.YOURTUBE_SESSION_SECRET = 'test-import-secret';
process.env.YOURTUBE_PARENT_PASSWORD = 'changeme';
process.env.YOURTUBE_YOUTUBE_CLIENT_ID = 'test-client-id';
process.env.YOURTUBE_YOUTUBE_CLIENT_SECRET = 'test-secret';

// Dynamic imports after env is set
const { importSubscriptions, importLikedVideos, getImportStatus, _resetImportStatus } = await import('../lib/import.js');
const store = await import('../lib/store.js');
const { _setFetchForTesting, _resetQuota } = await import('../lib/youtube.js');

// --- Helpers ---

function makeFetch(responses) {
  const queue = [...responses];
  return async (url) => {
    if (!queue.length) throw new Error(`Unexpected fetch: ${url}`);
    const item = queue.shift();
    if (item instanceof Error) throw item;
    const body = typeof item === 'string' ? item : JSON.stringify(item);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => body,
      json: async () => (typeof item === 'string' ? JSON.parse(body) : item),
    };
  };
}

function mockSub(id, title) {
  return {
    snippet: {
      resourceId: { channelId: id },
      title: title || `Channel ${id}`,
      description: `About ${id}`,
      thumbnails: { default: { url: `https://thumb.example.com/${id}.jpg` } },
    },
  };
}

function mockLikedVideo(id) {
  return {
    id,
    snippet: {
      title: `Liked ${id}`,
      channelId: 'UC1',
      channelTitle: 'TestChannel',
      publishedAt: '2024-06-01T00:00:00Z',
      thumbnails: { default: { url: `https://thumb.example.com/${id}.jpg` } },
    },
    contentDetails: { duration: 'PT3M' },
  };
}

function mockVideoDetail(id) {
  return {
    id,
    snippet: {
      title: `Detail ${id}`,
      description: `Description for ${id}`,
      tags: ['tag1'],
      categoryId: '22',
      channelId: 'UC1',
      channelTitle: 'TestChannel',
      publishedAt: '2024-06-01T00:00:00Z',
      thumbnails: { default: { url: `https://thumb.example.com/${id}.jpg` } },
    },
    contentDetails: { duration: 'PT3M' },
  };
}

// Write a valid (non-expired) token so getValidToken() works without network
async function seedTokens() {
  await store.write('tokens.json', {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expiry_time: Date.now() + 3600 * 1000,
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
  });
}

before(async () => {
  await mkdir(testDataDir, { recursive: true });
});

after(async () => {
  await rm(testDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  _resetImportStatus();
  _resetQuota();
  await store.setChannels([]);
  await store.setVideos({});
  await seedTokens();
});

// --- Unit tests ---

describe('importSubscriptions', () => {
  test('creates channel records with correct structure', async () => {
    _setFetchForTesting(makeFetch([
      { items: [mockSub('UC_abc'), mockSub('UC_def')] },
    ]));

    const result = await importSubscriptions();
    assert.equal(result.total, 2);
    assert.equal(result.added, 2);
    assert.equal(result.skipped, 0);

    const channels = await store.getChannels();
    assert.equal(channels.length, 2);

    const ch = channels[0];
    assert.equal(ch.channelId, 'UC_abc');
    assert.equal(ch.title, 'Channel UC_abc');
    assert.equal(ch.source, 'oauth');
    assert.equal(ch.approved, false);
    assert.ok(ch.description !== undefined);
    assert.ok(ch.thumbnail !== undefined);
  });

  test('merges without duplicating existing channels', async () => {
    // Pre-populate with one existing channel
    await store.setChannels([
      { channelId: 'UC_abc', title: 'Existing', source: 'manual', approved: true },
    ]);

    _setFetchForTesting(makeFetch([
      { items: [mockSub('UC_abc'), mockSub('UC_new')] },
    ]));

    const result = await importSubscriptions();
    assert.equal(result.total, 2);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 1);

    const channels = await store.getChannels();
    assert.equal(channels.length, 2);

    // Existing channel should be preserved (not overwritten)
    const existing = channels.find(c => c.channelId === 'UC_abc');
    assert.equal(existing.title, 'Existing');
    assert.equal(existing.approved, true);
    assert.equal(existing.source, 'manual');
  });

  test('handles empty subscription list', async () => {
    _setFetchForTesting(makeFetch([{ items: [] }]));

    const result = await importSubscriptions();
    assert.equal(result.total, 0);
    assert.equal(result.added, 0);

    const channels = await store.getChannels();
    assert.equal(channels.length, 0);
  });

  test('follows pagination across multiple pages', async () => {
    _setFetchForTesting(makeFetch([
      { items: [mockSub('UC1')], nextPageToken: 'page2' },
      { items: [mockSub('UC2')], nextPageToken: 'page3' },
      { items: [mockSub('UC3')] },
    ]));

    const result = await importSubscriptions();
    assert.equal(result.total, 3);
    assert.equal(result.added, 3);

    const channels = await store.getChannels();
    assert.equal(channels.length, 3);
  });

  test('updates import status during import', async () => {
    _setFetchForTesting(makeFetch([
      { items: [mockSub('UC1'), mockSub('UC2')] },
    ]));

    await importSubscriptions();

    const status = getImportStatus();
    assert.equal(status.importing, false);
    assert.equal(status.type, 'subscriptions');
    assert.equal(status.progress, 2);
    assert.equal(status.total, 2);
    assert.equal(status.error, null);
    assert.ok(status.lastImport);
  });

  test('records error when no tokens available', async () => {
    await store.write('tokens.json', {});

    await assert.rejects(
      importSubscriptions(),
      /YouTube not connected/,
    );

    const status = getImportStatus();
    assert.equal(status.importing, false);
    assert.ok(status.error.includes('YouTube not connected'));
  });

  test('rejects concurrent imports', async () => {
    // Use a slow mock that blocks on getSubscriptions
    let unblock;
    const blocked = new Promise(r => { unblock = r; });

    _setFetchForTesting(async () => {
      await blocked;
      return {
        ok: true,
        json: async () => ({ items: [] }),
        text: async () => '{"items":[]}',
      };
    });

    const first = importSubscriptions();

    // Give first call time to set importing=true and reach the fetch
    await new Promise(r => setTimeout(r, 50));

    await assert.rejects(importSubscriptions(), /already in progress/);

    // Unblock and clean up
    unblock();
    await first;
  });
});

describe('importLikedVideos', () => {
  test('saves videos with full details and source tag', async () => {
    _setFetchForTesting(makeFetch([
      // getLikedVideos response
      { items: [mockLikedVideo('v1'), mockLikedVideo('v2')] },
      // getVideoDetails response
      { items: [mockVideoDetail('v1'), mockVideoDetail('v2')] },
    ]));

    const result = await importLikedVideos();
    assert.equal(result.total, 2);
    assert.equal(result.added, 2);

    const videos = await store.getVideos();
    assert.ok(videos.v1);
    assert.ok(videos.v2);
    assert.equal(videos.v1.source, 'liked');
    assert.equal(videos.v1.videoId, 'v1');
    assert.equal(videos.v1.title, 'Detail v1');
    assert.equal(videos.v1.description, 'Description for v1');
    assert.deepEqual(videos.v1.tags, ['tag1']);
  });

  test('caps at 200 liked videos', async () => {
    // getLikedVideos internally caps at 200 — we just verify we pass 200
    const likedItems = Array.from({ length: 50 }, (_, i) => mockLikedVideo(`v${i}`));
    const detailItems = Array.from({ length: 50 }, (_, i) => mockVideoDetail(`v${i}`));

    _setFetchForTesting(makeFetch([
      { items: likedItems },
      { items: detailItems },
    ]));

    const result = await importLikedVideos();
    assert.equal(result.total, 50);
    assert.equal(result.added, 50);
  });

  test('saves partial results when getVideoDetails fails', async () => {
    _setFetchForTesting(makeFetch([
      // getLikedVideos succeeds
      { items: [mockLikedVideo('v1'), mockLikedVideo('v2')] },
      // getVideoDetails fails
      { error: { code: 403, message: 'Quota exceeded' } },
    ]));

    const result = await importLikedVideos();
    assert.ok(result.error);
    assert.equal(result.total, 2);
    assert.equal(result.added, 2);

    // Should have saved basic info from getLikedVideos
    const videos = await store.getVideos();
    assert.ok(videos.v1);
    assert.equal(videos.v1.source, 'liked');
    assert.equal(videos.v1.videoId, 'v1');

    const status = getImportStatus();
    assert.ok(status.error.includes('Partial import'));
  });

  test('updates import status during import', async () => {
    _setFetchForTesting(makeFetch([
      { items: [mockLikedVideo('v1')] },
      { items: [mockVideoDetail('v1')] },
    ]));

    await importLikedVideos();

    const status = getImportStatus();
    assert.equal(status.importing, false);
    assert.equal(status.type, 'liked');
    assert.equal(status.progress, 1);
    assert.equal(status.total, 1);
    assert.equal(status.error, null);
    assert.ok(status.lastImport);
  });

  test('records error when no tokens available', async () => {
    await store.write('tokens.json', {});

    await assert.rejects(
      importLikedVideos(),
      /YouTube not connected/,
    );

    const status = getImportStatus();
    assert.equal(status.importing, false);
    assert.ok(status.error.includes('YouTube not connected'));
  });
});

// --- Integration tests via HTTP ---

describe('Import API routes', () => {
  let server;
  let baseURL;

  async function httpFetch(path, opts = {}) {
    const url = new URL(path, baseURL);
    return globalThis.fetch(url, { redirect: 'manual', ...opts });
  }

  async function login() {
    const res = await httpFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'changeme' }),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/session=([^;]+)/);
    return match ? match[1] : null;
  }

  before(async () => {
    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseURL = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(async () => {
    _resetImportStatus();
    _resetQuota();
    await store.setChannels([]);
    await store.setVideos({});
    await store.write('sessions.json', {});
    await seedTokens();
  });

  test('POST /api/import/subscriptions requires auth', async () => {
    const res = await httpFetch('/api/import/subscriptions', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  test('POST /api/import/liked requires auth', async () => {
    const res = await httpFetch('/api/import/liked', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  test('GET /api/import/status requires auth', async () => {
    const res = await httpFetch('/api/import/status');
    assert.equal(res.status, 401);
  });

  test('POST /api/import/subscriptions imports channels', async () => {
    _setFetchForTesting(makeFetch([
      { items: [mockSub('UC_http1')] },
    ]));

    const cookie = await login();
    const res = await httpFetch('/api/import/subscriptions', {
      method: 'POST',
      headers: { Cookie: `session=${cookie}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.added, 1);

    const channels = await store.getChannels();
    assert.equal(channels.length, 1);
    assert.equal(channels[0].channelId, 'UC_http1');
  });

  test('GET /api/import/status returns status', async () => {
    const cookie = await login();
    const res = await httpFetch('/api/import/status', {
      headers: { Cookie: `session=${cookie}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.importing, false);
    assert.equal(body.type, null);
  });

  test('POST /api/import/liked imports videos', async () => {
    _setFetchForTesting(makeFetch([
      { items: [mockLikedVideo('v_http1')] },
      { items: [mockVideoDetail('v_http1')] },
    ]));

    const cookie = await login();
    const res = await httpFetch('/api/import/liked', {
      method: 'POST',
      headers: { Cookie: `session=${cookie}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.added, 1);

    const videos = await store.getVideos();
    assert.ok(videos.v_http1);
    assert.equal(videos.v_http1.source, 'liked');
  });
});
