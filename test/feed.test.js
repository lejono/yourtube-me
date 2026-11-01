import { test, describe, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Set unique data dir BEFORE any project module imports
const testDataName = `test-data-feed-${randomBytes(4).toString('hex')}`;
process.env.YOURTUBE_DATA_DIR = testDataName;

const { generateFeed, refreshChannelVideos, refreshAllChannels, startPolling, stopPolling, _computeWeight } =
  await import('../lib/feed.js');
const { setChannels, setVideos, setBlocked, getVideos } =
  await import('../lib/store.js');
const { _setFetchForTesting } =
  await import('../lib/youtube.js');
const { DATA_DIR } =
  await import('../config.js');

after(async () => {
  stopPolling();
  _setFetchForTesting(globalThis.fetch); // restore
  await rm(DATA_DIR, { recursive: true, force: true });
});

// --- Helpers ---

async function seedData({ channels = [], videos = {}, blocked = undefined }) {
  await setChannels(channels);
  await setVideos(videos);
  if (blocked !== undefined) {
    await setBlocked(blocked);
  }
}

function makeChannel(id, opts = {}) {
  const { approved = true, blocked = false, title } = opts;
  return {
    channelId: id,
    title: title || `Channel ${id}`,
    description: '',
    thumbnail: '',
    approved,
    blocked,
  };
}

function makeVideo(channelId, publishedAt = '2024-06-01T00:00:00Z') {
  return {
    title: `Video from ${channelId}`,
    channelId,
    channelTitle: `Channel ${channelId}`,
    publishedAt,
    thumbnails: { default: { url: 'https://i.ytimg.com/vi/xxx/hqdefault.jpg' } },
  };
}

// --- Tests ---

describe('generateFeed', () => {
  beforeEach(async () => {
    await seedData({
      channels: [],
      videos: {},
      blocked: { channels: [], videos: [] },
    });
  });

  test('empty state returns empty array (not error)', async () => {
    const feed = await generateFeed();
    assert.deepEqual(feed, []);
  });

  test('returns empty array when channels exist but no videos', async () => {
    await seedData({ channels: [makeChannel('UC1')] });
    const feed = await generateFeed();
    assert.deepEqual(feed, []);
  });

  test('feed respects approved-only constraint', async () => {
    await seedData({
      channels: [
        makeChannel('UC_approved'),
        makeChannel('UC_unapproved', { approved: false }),
      ],
      videos: {
        vid1: makeVideo('UC_approved'),
        vid2: makeVideo('UC_unapproved'),
      },
    });

    const feed = await generateFeed();
    assert.equal(feed.length, 1);
    assert.equal(feed[0].channelId, 'UC_approved');
    assert.equal(feed[0].videoId, 'vid1');
  });

  test('blocked channels excluded from feed (channels.json blocked field)', async () => {
    await seedData({
      channels: [
        makeChannel('UC_ok'),
        makeChannel('UC_blocked', { approved: true, blocked: true }),
      ],
      videos: {
        vid1: makeVideo('UC_ok'),
        vid2: makeVideo('UC_blocked'),
      },
    });

    const feed = await generateFeed();
    assert.equal(feed.length, 1);
    assert.equal(feed[0].channelId, 'UC_ok');
  });

  test('blocked channels excluded from feed (blocked.json)', async () => {
    await seedData({
      channels: [makeChannel('UC1'), makeChannel('UC2')],
      videos: {
        vid1: makeVideo('UC1'),
        vid2: makeVideo('UC2'),
      },
      blocked: { channels: ['UC2'], videos: [] },
    });

    const feed = await generateFeed();
    assert.equal(feed.length, 1);
    assert.equal(feed[0].channelId, 'UC1');
  });

  test('blocked videos excluded from feed', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        vid_ok: makeVideo('UC1'),
        vid_blocked: makeVideo('UC1'),
      },
      blocked: { channels: [], videos: ['vid_blocked'] },
    });

    const feed = await generateFeed();
    assert.equal(feed.length, 1);
    assert.equal(feed[0].videoId, 'vid_ok');
  });

  test('channel filter returns only that channel\'s videos', async () => {
    await seedData({
      channels: [makeChannel('UC1'), makeChannel('UC2')],
      videos: {
        vid1: makeVideo('UC1'),
        vid2: makeVideo('UC2'),
        vid3: makeVideo('UC1'),
      },
    });

    const feed = await generateFeed({ channel: 'UC1' });
    assert.equal(feed.length, 2);
    for (const v of feed) {
      assert.equal(v.channelId, 'UC1');
    }
  });

  test('channel filter for non-existent channel returns empty', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: { vid1: makeVideo('UC1') },
    });

    const feed = await generateFeed({ channel: 'UC_nonexistent' });
    assert.deepEqual(feed, []);
  });

  test('respects limit parameter', async () => {
    const videos = {};
    for (let i = 0; i < 20; i++) {
      videos[`vid${i}`] = makeVideo('UC1', `2024-${String(i + 1).padStart(2, '0')}-01T00:00:00Z`);
    }
    await seedData({ channels: [makeChannel('UC1')], videos });

    const feed = await generateFeed({ limit: 5 });
    assert.equal(feed.length, 5);
  });

  test('default limit is 50', async () => {
    const videos = {};
    for (let i = 0; i < 60; i++) {
      videos[`vid${i}`] = makeVideo('UC1', `2024-01-01T00:00:00Z`);
    }
    await seedData({ channels: [makeChannel('UC1')], videos });

    const feed = await generateFeed();
    assert.equal(feed.length, 50);
  });

  test('weighted shuffle favors recent videos', async () => {
    const now = new Date();
    const recentDate = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const oldDate = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year ago

    const videos = {};
    for (let i = 0; i < 5; i++) {
      videos[`recent${i}`] = makeVideo('UC1', recentDate);
    }
    for (let i = 0; i < 5; i++) {
      videos[`old${i}`] = makeVideo('UC1', oldDate);
    }

    await seedData({ channels: [makeChannel('UC1')], videos });

    // With extreme weight differences (1-day vs 1-year), recent videos
    // should always appear in the top positions
    const feed = await generateFeed({ limit: 10 });
    const top5Ids = feed.slice(0, 5).map(v => v.videoId);
    const recentInTop5 = top5Ids.filter(id => id.startsWith('recent')).length;
    assert.equal(recentInTop5, 5, 'All 5 recent videos should be in top 5');
  });

  test('feed items include videoId', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: { myVid: makeVideo('UC1') },
    });

    const feed = await generateFeed();
    assert.equal(feed[0].videoId, 'myVid');
  });

  test('feed items include channel info', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        v1: {
          title: 'Test',
          channelId: 'UC1',
          channelTitle: 'My Channel',
          publishedAt: '2024-06-01T00:00:00Z',
          thumbnails: {},
        },
      },
    });

    const feed = await generateFeed();
    assert.equal(feed[0].channelTitle, 'My Channel');
    assert.equal(feed[0].channelId, 'UC1');
  });
});

describe('_computeWeight', () => {
  test('recent video has higher weight than old video', () => {
    const now = Date.now();
    const recent = new Date(now - 1000 * 60 * 60).toISOString(); // 1 hour ago
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago

    assert.ok(_computeWeight(recent, now) > _computeWeight(old, now));
  });

  test('brand new video has weight close to 1', () => {
    const now = Date.now();
    const w = _computeWeight(new Date(now).toISOString(), now);
    assert.ok(w > 0.99, `Expected > 0.99, got ${w}`);
  });

  test('14-day-old video has weight close to 0.5', () => {
    const now = Date.now();
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const w = _computeWeight(twoWeeksAgo, now);
    assert.ok(w > 0.45 && w < 0.55, `Expected ~0.5, got ${w}`);
  });

  test('returns small weight for null publishedAt', () => {
    assert.ok(_computeWeight(null) < 0.1);
  });

  test('returns small weight for undefined publishedAt', () => {
    assert.ok(_computeWeight(undefined) < 0.1);
  });
});

describe('refreshChannelVideos', () => {
  beforeEach(async () => {
    await seedData({
      channels: [makeChannel('UCtest', { title: 'Test Channel' })],
      videos: {},
    });
  });

  test('adds RSS entries to videos.json', async () => {
    const rssXml = `<feed>
      <entry>
        <yt:videoId>rss1</yt:videoId>
        <title>RSS Video One</title>
        <published>2024-06-01T00:00:00Z</published>
        <media:thumbnail url="https://i.ytimg.com/vi/rss1/hqdefault.jpg" width="480" height="360"/>
      </entry>
      <entry>
        <yt:videoId>rss2</yt:videoId>
        <title>RSS Video Two</title>
        <published>2024-06-02T00:00:00Z</published>
        <media:thumbnail url="https://i.ytimg.com/vi/rss2/hqdefault.jpg" width="480" height="360"/>
      </entry>
    </feed>`;

    _setFetchForTesting(async () => ({
      ok: true,
      status: 200,
      text: async () => rssXml,
    }));

    const result = await refreshChannelVideos('UCtest');
    assert.equal(result.total, 2);
    assert.equal(result.added, 2);

    const videos = await getVideos();
    assert.ok(videos['rss1']);
    assert.equal(videos['rss1'].title, 'RSS Video One');
    assert.equal(videos['rss1'].channelId, 'UCtest');
    assert.equal(videos['rss1'].channelTitle, 'Test Channel');
    assert.equal(videos['rss1'].publishedAt, '2024-06-01T00:00:00Z');
  });

  test('preserves existing video metadata on refresh', async () => {
    await setVideos({
      rss1: {
        title: 'Old Title',
        channelId: 'UCtest',
        description: 'Detailed description from API',
        duration: 'PT10M30S',
        tags: ['science', 'kids'],
        thumbnails: {
          medium: { url: 'https://i.ytimg.com/vi/rss1/mqdefault.jpg' },
        },
      },
    });

    const rssXml = `<feed>
      <entry>
        <yt:videoId>rss1</yt:videoId>
        <title>Updated Title</title>
        <published>2024-06-15T00:00:00Z</published>
        <media:thumbnail url="https://i.ytimg.com/vi/rss1/hqdefault.jpg" width="480" height="360"/>
      </entry>
    </feed>`;

    _setFetchForTesting(async () => ({
      ok: true,
      status: 200,
      text: async () => rssXml,
    }));

    await refreshChannelVideos('UCtest');
    const videos = await getVideos();

    // Updated from RSS
    assert.equal(videos['rss1'].title, 'Updated Title');
    assert.equal(videos['rss1'].publishedAt, '2024-06-15T00:00:00Z');
    assert.equal(videos['rss1'].thumbnails.default.url, 'https://i.ytimg.com/vi/rss1/hqdefault.jpg');

    // Preserved from existing data
    assert.equal(videos['rss1'].description, 'Detailed description from API');
    assert.equal(videos['rss1'].duration, 'PT10M30S');
    assert.deepEqual(videos['rss1'].tags, ['science', 'kids']);
    assert.equal(videos['rss1'].thumbnails.medium.url, 'https://i.ytimg.com/vi/rss1/mqdefault.jpg');
  });

  test('reports zero added when all videos already exist', async () => {
    await setVideos({
      rss1: makeVideo('UCtest'),
    });

    const rssXml = `<feed>
      <entry>
        <yt:videoId>rss1</yt:videoId>
        <title>Same Video</title>
        <published>2024-06-01T00:00:00Z</published>
      </entry>
    </feed>`;

    _setFetchForTesting(async () => ({
      ok: true,
      status: 200,
      text: async () => rssXml,
    }));

    const result = await refreshChannelVideos('UCtest');
    assert.equal(result.total, 1);
    assert.equal(result.added, 0);
  });
});

describe('refreshAllChannels', () => {
  test('refreshes only approved non-blocked channels', async () => {
    const fetchedChannels = [];
    _setFetchForTesting(async (url) => {
      const match = url.match(/channel_id=([^&]+)/);
      if (match) fetchedChannels.push(decodeURIComponent(match[1]));
      return {
        ok: true,
        status: 200,
        text: async () => '<feed></feed>',
      };
    });

    await seedData({
      channels: [
        makeChannel('UC_yes', { approved: true }),
        makeChannel('UC_no', { approved: false }),
        makeChannel('UC_blocked', { approved: true, blocked: true }),
      ],
      videos: {},
    });

    await refreshAllChannels();
    assert.deepEqual(fetchedChannels, ['UC_yes']);
  });

  test('continues if one channel fails', async () => {
    let callCount = 0;
    _setFetchForTesting(async (url) => {
      callCount++;
      if (url.includes('UC_fail')) {
        return { ok: false, status: 500, statusText: 'Server Error', text: async () => 'Error' };
      }
      return { ok: true, status: 200, text: async () => '<feed></feed>' };
    });

    await seedData({
      channels: [
        makeChannel('UC_fail'),
        makeChannel('UC_ok'),
      ],
      videos: {},
    });

    const results = await refreshAllChannels();
    assert.equal(results.length, 2);
    assert.ok(results[0].error, 'First channel should have error');
    assert.equal(results[1].total, 0); // UC_ok succeeded with empty feed
  });

  test('returns empty array when no approved channels', async () => {
    _setFetchForTesting(async () => ({
      ok: true,
      status: 200,
      text: async () => '<feed></feed>',
    }));

    await seedData({
      channels: [makeChannel('UC1', { approved: false })],
      videos: {},
    });

    const results = await refreshAllChannels();
    assert.deepEqual(results, []);
  });
});

describe('polling', () => {
  afterEach(() => stopPolling());

  test('startPolling and stopPolling run without errors', async () => {
    _setFetchForTesting(async () => ({
      ok: true,
      status: 200,
      text: async () => '<feed></feed>',
    }));

    await seedData({ channels: [makeChannel('UC1')], videos: {} });
    startPolling(60000);
    stopPolling();
  });

  test('stopPolling is idempotent', () => {
    stopPolling();
    stopPolling();
    // No throws
  });
});

describe('HTTP routes', () => {
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
    // Seed some test data
    await seedData({
      channels: [
        makeChannel('UC_approved', { title: 'Approved Channel' }),
        makeChannel('UC_blocked_ch', { approved: true, blocked: true }),
      ],
      videos: {
        vid_good: {
          title: 'Good Video',
          channelId: 'UC_approved',
          channelTitle: 'Approved Channel',
          publishedAt: '2024-06-01T00:00:00Z',
          thumbnails: { default: { url: 'https://example.com/thumb.jpg' } },
        },
        vid_blocked_ch: {
          title: 'From Blocked Channel',
          channelId: 'UC_blocked_ch',
          channelTitle: 'Blocked Channel',
          publishedAt: '2024-06-01T00:00:00Z',
          thumbnails: {},
        },
      },
      blocked: { channels: [], videos: [] },
    });

    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseURL = `http://127.0.0.1:${addr.port}`;

    // Login to get a session cookie (default password is 'changeme')
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

  test('GET /api/feed returns 401 without session', async () => {
    const url = new URL('/api/feed', baseURL);
    const res = await globalThis.fetch(url);
    assert.equal(res.status, 401);
  });

  test('GET /api/feed returns videos array in response', async () => {
    const res = await httpFetch('/api/feed');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.videos));
  });

  test('GET /api/feed excludes blocked channel videos', async () => {
    const res = await httpFetch('/api/feed');
    const body = await res.json();
    const ids = body.videos.map(v => v.videoId);
    assert.ok(!ids.includes('vid_blocked_ch'));
  });

  test('GET /api/feed supports channel filter', async () => {
    const res = await httpFetch('/api/feed?channel=UC_approved');
    const body = await res.json();
    assert.ok(body.videos.length > 0);
    for (const v of body.videos) {
      assert.equal(v.channelId, 'UC_approved');
    }
  });

  test('GET /api/video/:id returns video metadata', async () => {
    const res = await httpFetch('/api/video/vid_good');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.videoId, 'vid_good');
    assert.equal(body.title, 'Good Video');
    assert.equal(body.channelTitle, 'Approved Channel');
  });

  test('GET /api/video/:id returns 404 for missing video', async () => {
    const res = await httpFetch('/api/video/nonexistent');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Video not found');
  });
});
