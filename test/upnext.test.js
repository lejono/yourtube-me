/**
 * Tests for lib/upnext.js — Up Next engine.
 *
 * All external calls (scraper, YouTube search, Claude filter) are mocked
 * via injection points. No real API calls happen during tests.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Isolated data dir — set BEFORE any project module imports
const testDataName = `test-data-upnext-${randomBytes(4).toString('hex')}`;
process.env.YOURTUBE_DATA_DIR = testDataName;

const {
  getUpNext,
  vetUpNext,
  gatherCandidates,
  _setScraperForTesting,
  _setSearchForTesting,
  _getActiveJobs,
} = await import('../lib/upnext.js');

const {
  setChannels, setVideos, setBlocked, setConfig, setProfile,
  setUpNextCache, getUpNextCache, setAICache,
} = await import('../lib/store.js');

const { _setExecForTesting } = await import('../lib/filter.js');
const { DATA_DIR } = await import('../config.js');

after(async () => {
  _setScraperForTesting(null);
  _setSearchForTesting(null);
  _setExecForTesting(null);
  await rm(DATA_DIR, { recursive: true, force: true });
});

// --- Helpers ---

function makeChannel(id, opts = {}) {
  return {
    channelId: id,
    title: opts.title || `Channel ${id}`,
    description: '',
    thumbnail: '',
    approved: opts.approved ?? true,
    blocked: opts.blocked ?? false,
  };
}

function makeVideo(channelId, overrides = {}) {
  return {
    title: overrides.title || `Video from ${channelId}`,
    channelId,
    channelTitle: `Channel ${channelId}`,
    publishedAt: overrides.publishedAt || '2024-06-01T00:00:00Z',
    thumbnails: { default: { url: 'https://i.ytimg.com/vi/xxx/hqdefault.jpg' } },
    ...overrides,
  };
}

async function seedData({
  channels = [],
  videos = {},
  blocked = { channels: [], videos: [] },
  config = { guidelines: '', searchBudgetPerDay: 10, scraperEnabled: false, parentNotes: '' },
  profile = null,
  upnextCache = {},
  aiCache = {},
} = {}) {
  await Promise.all([
    setChannels(channels),
    setVideos(videos),
    setBlocked(blocked),
    setConfig(config),
    setProfile(profile),
    setUpNextCache(upnextCache),
    setAICache(aiCache),
  ]);
}

function mockClaude(decisions) {
  _setExecForTesting(async () => JSON.stringify(decisions));
}

function mockClaudeApproveAll() {
  _setExecForTesting(async (prompt) => {
    // Extract videoIds from the prompt and approve them all
    const matches = prompt.match(/"videoId"\s*:\s*"([^"]+)"/g) || [];
    const ids = matches.map(m => m.match(/"([^"]+)"$/)[1]);
    return JSON.stringify(ids.map(id => ({
      videoId: id,
      approved: true,
      reason: 'test approved',
    })));
  });
}

// --- getUpNext tests ---

describe('getUpNext', () => {
  beforeEach(async () => {
    _getActiveJobs().clear();
    _setScraperForTesting(null);
    _setSearchForTesting(null);
    _setExecForTesting(null);
  });

  test('returns cached vetted picks when available', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: { vid1: makeVideo('UC1') },
      upnextCache: {
        vid1: {
          picks: [
            { videoId: 'rec1', title: 'Rec 1', channelId: 'UC1', channelTitle: 'Ch 1', thumbnails: {}, source: 'search' },
            { videoId: 'rec2', title: 'Rec 2', channelId: 'UC1', channelTitle: 'Ch 1', thumbnails: {}, source: 'search' },
          ],
          generatedAt: new Date().toISOString(),
          candidateCount: 5,
        },
      },
    });

    const result = await getUpNext('vid1');
    assert.equal(result.complete, true);
    assert.equal(result.source, 'cache');
    assert.equal(result.picks.length, 2);
    assert.equal(result.picks[0].videoId, 'rec1');
  });

  test('filters blocked videos from cached picks', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: { vid1: makeVideo('UC1') },
      blocked: { channels: [], videos: ['rec1'] },
      upnextCache: {
        vid1: {
          picks: [
            { videoId: 'rec1', title: 'Blocked', channelId: 'UC1', channelTitle: 'Ch', thumbnails: {}, source: 'test' },
            { videoId: 'rec2', title: 'OK', channelId: 'UC1', channelTitle: 'Ch', thumbnails: {}, source: 'test' },
          ],
          generatedAt: new Date().toISOString(),
          candidateCount: 2,
        },
      },
    });

    const result = await getUpNext('vid1');
    assert.equal(result.picks.length, 1);
    assert.equal(result.picks[0].videoId, 'rec2');
  });

  test('filters blocked channels from cached picks', async () => {
    await seedData({
      channels: [makeChannel('UC1'), makeChannel('UC_bad')],
      videos: { vid1: makeVideo('UC1') },
      blocked: { channels: ['UC_bad'], videos: [] },
      upnextCache: {
        vid1: {
          picks: [
            { videoId: 'rec1', title: 'From bad ch', channelId: 'UC_bad', channelTitle: 'Bad', thumbnails: {}, source: 'test' },
            { videoId: 'rec2', title: 'OK', channelId: 'UC1', channelTitle: 'Good', thumbnails: {}, source: 'test' },
          ],
          generatedAt: new Date().toISOString(),
          candidateCount: 2,
        },
      },
    });

    const result = await getUpNext('vid1');
    assert.equal(result.picks.length, 1);
    assert.equal(result.picks[0].videoId, 'rec2');
  });

  test('returns backfill when no cache exists', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        vid1: makeVideo('UC1'),
        vid2: makeVideo('UC1', { title: 'Backfill Video' }),
        vid3: makeVideo('UC1', { title: 'Another Backfill' }),
      },
    });

    const result = await getUpNext('vid1');
    assert.equal(result.source, 'backfill');
    assert.equal(result.complete, true);
    assert.ok(result.picks.length > 0, 'should have backfill picks');
    // Current video should be excluded from backfill
    assert.ok(!result.picks.some(p => p.videoId === 'vid1'), 'current video excluded');
  });

  test('returns empty picks when no data exists', async () => {
    await seedData();
    const result = await getUpNext('nonexistent');
    assert.deepEqual(result.picks, []);
    assert.equal(result.complete, true);
  });

  test('limits picks to MAX_PICKS (8)', async () => {
    const picks = [];
    for (let i = 0; i < 15; i++) {
      picks.push({ videoId: `rec${i}`, title: `Rec ${i}`, channelId: 'UC1', channelTitle: 'Ch', thumbnails: {}, source: 'test' });
    }
    await seedData({
      channels: [makeChannel('UC1')],
      upnextCache: {
        vid1: { picks, generatedAt: new Date().toISOString(), candidateCount: 15 },
      },
    });

    const result = await getUpNext('vid1');
    assert.ok(result.picks.length <= 8, `expected <= 8, got ${result.picks.length}`);
  });
});

// --- vetUpNext tests ---

describe('vetUpNext', () => {
  beforeEach(async () => {
    _getActiveJobs().clear();
    _setScraperForTesting(null);
    _setSearchForTesting(null);
    _setExecForTesting(null);
  });

  test('skips vetting when cache already has picks', async () => {
    let classifyCalled = false;
    _setExecForTesting(async () => {
      classifyCalled = true;
      return '[]';
    });

    await seedData({
      channels: [makeChannel('UC1')],
      videos: { vid1: makeVideo('UC1') },
      upnextCache: {
        vid1: {
          picks: [{ videoId: 'rec1', title: 'Cached', channelId: 'UC1', channelTitle: 'Ch', thumbnails: {}, source: 'test' }],
          generatedAt: new Date().toISOString(),
          candidateCount: 1,
        },
      },
    });

    await vetUpNext('vid1');
    assert.equal(classifyCalled, false, 'should not classify when cache exists');
  });

  test('vets same-channel videos and saves to cache', async () => {
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        current: makeVideo('UC1', { title: 'Current Video' }),
        other1: makeVideo('UC1', { title: 'Other Video 1' }),
        other2: makeVideo('UC1', { title: 'Other Video 2' }),
      },
    });

    await vetUpNext('current');

    const cache = await getUpNextCache();
    assert.ok(cache.current, 'cache entry should exist');
    assert.ok(cache.current.picks.length > 0, 'should have picks');
    assert.ok(!cache.current.picks.some(p => p.videoId === 'current'), 'current video excluded');
  });

  test('uses scraper results as candidates', async () => {
    _setScraperForTesting(async () => [
      { id: 'scraped1', title: 'Scraped Video', channel: 'Some Channel', thumbnail: 'http://thumb.jpg' },
    ]);
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1')],
      videos: { current: makeVideo('UC1') },
    });

    await vetUpNext('current');

    const cache = await getUpNextCache();
    const picks = cache.current?.picks || [];
    const sources = picks.map(p => p.source);
    assert.ok(sources.includes('scraper'), 'should include scraper results');
  });

  test('uses search when scraper gives too few candidates', async () => {
    _setScraperForTesting(async () => []); // scraper returns nothing
    _setSearchForTesting(async (query) => [
      { videoId: 'search1', title: 'Search Result', channelId: 'UC_other', channelTitle: 'Other Ch', publishedAt: '2024-01-01' },
    ]);
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1')],
      videos: { current: makeVideo('UC1', { title: 'Searchable Title' }) },
    });

    await vetUpNext('current');

    const cache = await getUpNextCache();
    const picks = cache.current?.picks || [];
    const sources = picks.map(p => p.source);
    assert.ok(sources.includes('search'), 'should include search results');
  });

  test('skips search when scraper provides enough candidates', async () => {
    _setScraperForTesting(async () => [
      { id: 'sc1', title: 'Scraped 1', channel: 'Ch', thumbnail: '' },
      { id: 'sc2', title: 'Scraped 2', channel: 'Ch', thumbnail: '' },
      { id: 'sc3', title: 'Scraped 3', channel: 'Ch', thumbnail: '' },
      { id: 'sc4', title: 'Scraped 4', channel: 'Ch', thumbnail: '' },
    ]);

    let searchCalled = false;
    _setSearchForTesting(async () => {
      searchCalled = true;
      return [];
    });
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1')],
      videos: { current: makeVideo('UC1', { title: 'Something' }) },
    });

    await vetUpNext('current');
    assert.equal(searchCalled, false, 'search should not be called when scraper has enough');
  });

  test('excludes blocked videos from candidates', async () => {
    _setScraperForTesting(async () => [
      { id: 'blocked_vid', title: 'Blocked', channel: 'Ch', thumbnail: '' },
      { id: 'ok_vid', title: 'OK', channel: 'Ch', thumbnail: '' },
    ]);
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1')],
      videos: { current: makeVideo('UC1') },
      blocked: { channels: [], videos: ['blocked_vid'] },
    });

    await vetUpNext('current');

    const cache = await getUpNextCache();
    const picks = cache.current?.picks || [];
    assert.ok(!picks.some(p => p.videoId === 'blocked_vid'), 'blocked video should not be in picks');
  });

  test('excludes blocked channels from candidates', async () => {
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1'), makeChannel('UC_blocked')],
      videos: {
        current: makeVideo('UC1'),
        from_blocked: makeVideo('UC_blocked', { title: 'From Blocked' }),
        from_ok: makeVideo('UC1', { title: 'From OK' }),
      },
      blocked: { channels: ['UC_blocked'], videos: [] },
    });

    await vetUpNext('current');

    const cache = await getUpNextCache();
    const picks = cache.current?.picks || [];
    assert.ok(!picks.some(p => p.channelId === 'UC_blocked'), 'blocked channel videos excluded');
  });

  test('handles AI filter rejecting videos', async () => {
    _setScraperForTesting(async () => [
      { id: 'bad1', title: 'Bad Video', channel: 'Ch', thumbnail: '' },
      { id: 'good1', title: 'Good Video', channel: 'Ch', thumbnail: '' },
    ]);
    _setExecForTesting(async () => JSON.stringify([
      { videoId: 'bad1', approved: false, reason: 'inappropriate' },
      { videoId: 'good1', approved: true, reason: 'safe content' },
    ]));

    await seedData({
      channels: [makeChannel('UC1')],
      videos: { current: makeVideo('UC1') },
    });

    await vetUpNext('current');

    const cache = await getUpNextCache();
    const picks = cache.current?.picks || [];
    assert.ok(!picks.some(p => p.videoId === 'bad1'), 'AI-rejected video excluded');
    assert.ok(picks.some(p => p.videoId === 'good1'), 'AI-approved video included');
  });

  test('deduplicates concurrent vetting requests', async () => {
    let vetCount = 0;
    _setExecForTesting(async (prompt) => {
      vetCount++;
      // Simulate slow AI call
      await new Promise(r => setTimeout(r, 50));
      const matches = prompt.match(/"videoId"\s*:\s*"([^"]+)"/g) || [];
      const ids = matches.map(m => m.match(/"([^"]+)"$/)[1]);
      return JSON.stringify(ids.map(id => ({ videoId: id, approved: true, reason: 'ok' })));
    });

    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        current: makeVideo('UC1'),
        other: makeVideo('UC1', { title: 'Other' }),
      },
    });

    // Launch two concurrent vetting requests for the same video
    const [r1, r2] = await Promise.all([
      vetUpNext('current'),
      vetUpNext('current'),
    ]);

    // The AI should only have been called once (dedup)
    assert.ok(vetCount <= 1, `expected at most 1 classify call, got ${vetCount}`);
  });

  test('gracefully handles AI filter failure', async () => {
    _setExecForTesting(async () => {
      throw new Error('claude not found');
    });

    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        current: makeVideo('UC1'),
        other: makeVideo('UC1', { title: 'Other' }),
      },
    });

    // Should not throw
    await vetUpNext('current');

    // Should still have cached something (unclassified videos default to approved)
    const cache = await getUpNextCache();
    assert.ok(cache.current, 'cache entry should exist despite AI failure');
  });

  test('gracefully handles scraper failure', async () => {
    _setScraperForTesting(async () => {
      throw new Error('playwright crashed');
    });
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        current: makeVideo('UC1'),
        other: makeVideo('UC1', { title: 'Other' }),
      },
    });

    // Should not throw
    await vetUpNext('current');

    const cache = await getUpNextCache();
    assert.ok(cache.current, 'cache entry should exist despite scraper failure');
  });

  test('gracefully handles search failure', async () => {
    _setScraperForTesting(async () => []); // no scraper results
    _setSearchForTesting(async () => {
      throw new Error('quota exceeded');
    });
    mockClaudeApproveAll();

    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        current: makeVideo('UC1', { title: 'Search Me' }),
        other: makeVideo('UC1', { title: 'Fallback' }),
      },
    });

    await vetUpNext('current');

    const cache = await getUpNextCache();
    assert.ok(cache.current, 'cache entry should exist despite search failure');
  });
});

// --- gatherCandidates tests ---

describe('gatherCandidates', () => {
  beforeEach(async () => {
    _setScraperForTesting(null);
    _setSearchForTesting(null);
  });

  test('returns empty array when no sources available', async () => {
    await seedData();

    const result = await gatherCandidates('vid1', null, {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(),
    });

    assert.deepEqual(result, []);
  });

  test('includes same-channel videos', async () => {
    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        current: makeVideo('UC1'),
        sibling: makeVideo('UC1', { title: 'Sibling Video' }),
      },
    });

    const result = await gatherCandidates('current', makeVideo('UC1'), {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(),
    });

    assert.ok(result.some(c => c.videoId === 'sibling'), 'should include sibling video');
    assert.ok(!result.some(c => c.videoId === 'current'), 'should exclude current video');
  });

  test('deduplicates candidates across sources', async () => {
    _setScraperForTesting(async () => [
      { id: 'dup', title: 'Dup From Scraper', channel: 'Ch', thumbnail: '' },
    ]);

    await seedData({
      channels: [makeChannel('UC1')],
      videos: {
        current: makeVideo('UC1'),
        dup: makeVideo('UC1', { title: 'Dup From Channel' }),
      },
    });

    const result = await gatherCandidates('current', makeVideo('UC1'), {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(),
    });

    const dupEntries = result.filter(c => c.videoId === 'dup');
    assert.equal(dupEntries.length, 1, 'should deduplicate');
    // First source wins (scraper before same-channel)
    assert.equal(dupEntries[0]._source, 'scraper');
  });

  test('filters out blocked videos during gathering', async () => {
    _setScraperForTesting(async () => [
      { id: 'blocked1', title: 'Blocked', channel: 'Ch', thumbnail: '' },
      { id: 'ok1', title: 'OK', channel: 'Ch', thumbnail: '' },
    ]);

    await seedData({
      channels: [makeChannel('UC1')],
      videos: { current: makeVideo('UC1') },
    });

    const result = await gatherCandidates('current', makeVideo('UC1'), {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(['blocked1']),
    });

    assert.ok(!result.some(c => c.videoId === 'blocked1'));
    assert.ok(result.some(c => c.videoId === 'ok1'));
  });

  test('filters out blocked channels during gathering', async () => {
    await seedData({
      channels: [makeChannel('UC1'), makeChannel('UC_bad')],
      videos: {
        current: makeVideo('UC1'),
        bad_vid: makeVideo('UC_bad', { title: 'From Bad Channel' }),
        ok_vid: makeVideo('UC1', { title: 'From Good Channel' }),
      },
    });

    const result = await gatherCandidates('current', makeVideo('UC1'), {
      blockedChannelIds: new Set(['UC_bad']),
      blockedVideoIds: new Set(),
    });

    assert.ok(!result.some(c => c.channelId === 'UC_bad'));
  });
});

// --- HTTP route integration tests ---

describe('HTTP /api/upnext/:videoId', () => {
  let server;
  let baseURL;
  let sessionCookie;

  before(async () => {
    _setScraperForTesting(null);
    _setSearchForTesting(null);
    _setExecForTesting(null);
    _getActiveJobs().clear();

    await seedData({
      channels: [makeChannel('UC1', { title: 'Approved Channel' })],
      videos: {
        vid_current: makeVideo('UC1', { title: 'Current Video' }),
        vid_rec1: makeVideo('UC1', { title: 'Recommendation 1' }),
        vid_rec2: makeVideo('UC1', { title: 'Recommendation 2' }),
      },
    });

    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseURL = `http://127.0.0.1:${addr.port}`;

    // Login to get session
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
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('GET /api/upnext/:videoId returns valid response', async () => {
    const res = await globalThis.fetch(new URL('/api/upnext/vid_current', baseURL));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.picks), 'response should have picks array');
    assert.ok(typeof body.complete === 'boolean', 'response should have complete flag');
    assert.ok(typeof body.source === 'string', 'response should have source string');
  });

  test('GET /api/upnext/:videoId backfill excludes current video', async () => {
    const res = await globalThis.fetch(new URL('/api/upnext/vid_current', baseURL));
    const body = await res.json();
    assert.ok(!body.picks.some(p => p.videoId === 'vid_current'), 'current video excluded from picks');
  });

  test('GET /api/upnext/:videoId returns cached results', async () => {
    // Pre-seed cache
    await setUpNextCache({
      vid_cached: {
        picks: [
          { videoId: 'rec_cached', title: 'Cached Pick', channelId: 'UC1', channelTitle: 'Ch', thumbnails: {}, source: 'test' },
        ],
        generatedAt: new Date().toISOString(),
        candidateCount: 1,
      },
    });

    const res = await globalThis.fetch(new URL('/api/upnext/vid_cached', baseURL));
    const body = await res.json();
    assert.equal(body.source, 'cache');
    assert.equal(body.picks[0].videoId, 'rec_cached');
  });

  test('POST /api/watch/start triggers background vetting', async () => {
    mockClaudeApproveAll();

    const res = await globalThis.fetch(new URL('/api/watch/start', baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${sessionCookie}`,
      },
      body: JSON.stringify({ videoId: 'vid_current' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // Wait briefly for background vetting to complete
    await new Promise(r => setTimeout(r, 200));

    // Verify cache was populated
    const cache = await getUpNextCache();
    assert.ok(cache.vid_current, 'vetting should have populated the cache');
  });

  test('GET /api/upnext returns 200 for unknown video', async () => {
    const res = await globalThis.fetch(new URL('/api/upnext/totally_unknown', baseURL));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.picks));
  });
});
