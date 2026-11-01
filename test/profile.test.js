import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated temp data dir — must be set before any project imports
const testDataDir = await mkdtemp(join(tmpdir(), 'yourtube-profile-test-'));
process.env.YOURTUBE_DATA_DIR = testDataDir;
process.env.YOURTUBE_SESSION_SECRET = 'test-profile-secret';
process.env.YOURTUBE_PARENT_PASSWORD = 'changeme';

// Dynamic imports after env is set
const { sampleData, generateProfile, saveProfile, rebuildProfile, _setClaudeForTesting } = await import('../lib/profile.js');
const store = await import('../lib/store.js');
const { parseUsageLogText } = await import('../lib/ai-usage.js');
const aiUsageLogPath = join(testDataDir, 'ai-usage.jsonl');

// --- Helpers ---

function makeChannel(id, title, description = '') {
  return {
    channelId: id,
    title: title || `Channel ${id}`,
    description,
    thumbnail: '',
    source: 'oauth',
    approved: false,
  };
}

function makeVideo(id, opts = {}) {
  return {
    videoId: id,
    title: opts.title || `Video ${id}`,
    channelId: opts.channelId || 'UC1',
    channelTitle: opts.channelTitle || 'TestChannel',
    description: opts.description || `Description for ${id}`,
    tags: opts.tags || ['tag1', 'tag2'],
    categoryId: opts.categoryId || '22',
    publishedAt: opts.publishedAt || '2024-06-01T00:00:00Z',
    source: opts.source || 'liked',
    thumbnails: { default: { url: `https://thumb.example.com/${id}.jpg` } },
  };
}

const validProfileResponse = {
  interests: ['gaming', 'science', 'music'],
  preferredFormats: ['tutorials', 'gameplay', 'vlogs'],
  avoidPatterns: ['horror', 'violence', 'gambling'],
  discoveryTerms: ['minecraft tutorials', 'space science for kids', 'music production basics'],
};

function mockClaude(response) {
  return async () => JSON.stringify(response);
}

before(async () => {
  await mkdir(testDataDir, { recursive: true });
});

after(async () => {
  _setClaudeForTesting(null);
  delete process.env.YOURTUBE_AI_USAGE_LOG;
  await rm(testDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.YOURTUBE_AI_USAGE_LOG = aiUsageLogPath;
  await rm(aiUsageLogPath, { force: true });
  _setClaudeForTesting(null);
  await store.setChannels([]);
  await store.setVideos({});
  await store.setProfile(null);
});

async function readUsageRecords() {
  return parseUsageLogText(await readFile(aiUsageLogPath, 'utf8'));
}

// --- sampleData tests ---

describe('sampleData', () => {
  test('returns all channels', async () => {
    await store.setChannels([
      makeChannel('UC1', 'Science Fun'),
      makeChannel('UC2', 'Gaming World'),
      makeChannel('UC3', 'Music Lessons'),
    ]);

    const data = await sampleData();
    assert.equal(data.channels.length, 3);
    assert.equal(data.channels[0].title, 'Science Fun');
    assert.equal(data.channels[1].title, 'Gaming World');
    assert.equal(data.channels[2].title, 'Music Lessons');
  });

  test('includes only liked videos, not RSS videos', async () => {
    const videos = {
      v1: makeVideo('v1', { source: 'liked' }),
      v2: makeVideo('v2', { source: 'rss' }),
      v3: makeVideo('v3', { source: 'liked' }),
    };
    await store.setVideos(videos);

    const data = await sampleData();
    assert.equal(data.videos.length, 2);
    assert.equal(data.stats.totalVideos, 2);
  });

  test('caps videos at 200', async () => {
    const videos = {};
    for (let i = 0; i < 250; i++) {
      videos[`v${i}`] = makeVideo(`v${i}`, {
        publishedAt: new Date(2024, 0, 1 + i).toISOString(),
      });
    }
    await store.setVideos(videos);

    const data = await sampleData();
    assert.equal(data.videos.length, 200);
    assert.equal(data.stats.totalVideos, 200);
  });

  test('sorts videos by publishedAt descending (most recent first)', async () => {
    const videos = {
      old: makeVideo('old', { title: 'Old Video', publishedAt: '2023-01-01T00:00:00Z' }),
      mid: makeVideo('mid', { title: 'Mid Video', publishedAt: '2024-06-01T00:00:00Z' }),
      new: makeVideo('new', { title: 'New Video', publishedAt: '2025-01-01T00:00:00Z' }),
    };
    await store.setVideos(videos);

    const data = await sampleData();
    assert.equal(data.videos[0].title, 'New Video');
    assert.equal(data.videos[1].title, 'Mid Video');
    assert.equal(data.videos[2].title, 'Old Video');
  });

  test('truncates descriptions to 200 chars', async () => {
    const longDesc = 'A'.repeat(500);
    const videos = {
      v1: makeVideo('v1', { description: longDesc }),
    };
    await store.setVideos(videos);

    const data = await sampleData();
    assert.equal(data.videos[0].description.length, 200);
  });

  test('limits tags to 10 per video', async () => {
    const manyTags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const videos = {
      v1: makeVideo('v1', { tags: manyTags }),
    };
    await store.setVideos(videos);

    const data = await sampleData();
    assert.equal(data.videos[0].tags.length, 10);
  });

  test('computes aggregate stats correctly', async () => {
    const videos = {
      v1: makeVideo('v1', { channelTitle: 'GameChan', categoryId: '20' }),
      v2: makeVideo('v2', { channelTitle: 'GameChan', categoryId: '20' }),
      v3: makeVideo('v3', { channelTitle: 'SciChan', categoryId: '28' }),
    };
    await store.setVideos(videos);

    const data = await sampleData();
    assert.equal(data.stats.topChannels.length, 2);
    assert.equal(data.stats.topChannels[0].name, 'GameChan');
    assert.equal(data.stats.topChannels[0].count, 2);
    assert.equal(data.stats.topChannels[1].name, 'SciChan');
    assert.equal(data.stats.topChannels[1].count, 1);

    assert.equal(data.stats.topCategories.length, 2);
    assert.equal(data.stats.topCategories[0].id, '20');
    assert.equal(data.stats.topCategories[0].count, 2);
  });

  test('handles empty channels and videos gracefully', async () => {
    const data = await sampleData();
    assert.equal(data.channels.length, 0);
    assert.equal(data.videos.length, 0);
    assert.equal(data.stats.totalVideos, 0);
    assert.equal(data.stats.topChannels.length, 0);
    assert.equal(data.stats.topCategories.length, 0);
  });

  test('handles videos with missing fields', async () => {
    const videos = {
      v1: {
        videoId: 'v1',
        title: 'Bare Video',
        source: 'liked',
        // missing channelTitle, categoryId, description, tags, publishedAt
      },
    };
    await store.setVideos(videos);

    const data = await sampleData();
    assert.equal(data.videos.length, 1);
    assert.equal(data.videos[0].title, 'Bare Video');
    assert.equal(data.videos[0].channelTitle, '');
    assert.equal(data.videos[0].categoryId, '');
    assert.equal(data.videos[0].description, '');
    assert.deepEqual(data.videos[0].tags, []);
  });
});

// --- generateProfile tests ---

describe('generateProfile', () => {
  test('returns profile with required fields from valid Claude response', async () => {
    _setClaudeForTesting(mockClaude(validProfileResponse));

    const data = {
      channels: [{ title: 'TestChan', description: 'A channel' }],
      videos: [{ title: 'Test Video', channelTitle: 'TestChan', categoryId: '22', description: 'desc', tags: [] }],
      stats: { topChannels: [], topCategories: [], totalVideos: 1 },
    };

    const profile = await generateProfile(data);
    assert.deepEqual(profile.interests, validProfileResponse.interests);
    assert.deepEqual(profile.preferredFormats, validProfileResponse.preferredFormats);
    assert.deepEqual(profile.avoidPatterns, validProfileResponse.avoidPatterns);
    assert.deepEqual(profile.discoveryTerms, validProfileResponse.discoveryTerms);
    assert.equal(profile.sampleSize, 1);
    assert.ok(profile.generatedAt);
    assert.ok(profile.rawResponse);
  });

  test('logs profile generation Claude usage', async () => {
    _setClaudeForTesting(async () =>
      JSON.stringify({
        type: 'result',
        model: 'claude-sonnet-latest',
        total_cost_usd: 0.012,
        usage: { input_tokens: 500, output_tokens: 100 },
        result: JSON.stringify(validProfileResponse),
      })
    );

    const data = {
      channels: [{ title: 'TestChan', description: 'A channel' }],
      videos: [{ title: 'Test Video', channelTitle: 'TestChan', categoryId: '22', description: 'desc', tags: [] }],
      stats: { topChannels: [], topCategories: [], totalVideos: 1 },
    };

    await generateProfile(data);

    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].component, 'server');
    assert.equal(records[0].operation, 'profile.generate');
    assert.equal(records[0].model, 'sonnet');
    assert.equal(records[0].actual_model, 'claude-sonnet-latest');
    assert.equal(records[0].total_tokens, 600);
    assert.equal(records[0].cost_usd, 0.012);
  });

  test('parses JSON wrapped in markdown code block', async () => {
    _setClaudeForTesting(async () => '```json\n' + JSON.stringify(validProfileResponse) + '\n```');

    const data = {
      channels: [{ title: 'Ch', description: '' }],
      videos: [],
      stats: { topChannels: [], topCategories: [], totalVideos: 0 },
    };

    const profile = await generateProfile(data);
    assert.deepEqual(profile.interests, validProfileResponse.interests);
  });

  test('parses JSON embedded in surrounding text', async () => {
    _setClaudeForTesting(async () =>
      'Here is the analysis:\n' + JSON.stringify(validProfileResponse) + '\nHope that helps!'
    );

    const data = {
      channels: [],
      videos: [{ title: 'V', channelTitle: 'C', categoryId: '1', description: '', tags: [] }],
      stats: { topChannels: [], topCategories: [], totalVideos: 1 },
    };

    const profile = await generateProfile(data);
    assert.deepEqual(profile.interests, validProfileResponse.interests);
  });

  test('retries once on unparseable response then succeeds', async () => {
    let callCount = 0;
    _setClaudeForTesting(async () => {
      callCount++;
      if (callCount === 1) return 'This is not JSON at all';
      return JSON.stringify(validProfileResponse);
    });

    const data = {
      channels: [{ title: 'Ch', description: '' }],
      videos: [],
      stats: { topChannels: [], topCategories: [], totalVideos: 0 },
    };

    const profile = await generateProfile(data);
    assert.equal(callCount, 2);
    assert.deepEqual(profile.interests, validProfileResponse.interests);
  });

  test('throws after retry also fails', async () => {
    _setClaudeForTesting(async () => 'Not JSON ever');

    const data = {
      channels: [{ title: 'Ch', description: '' }],
      videos: [],
      stats: { topChannels: [], topCategories: [], totalVideos: 0 },
    };

    await assert.rejects(
      generateProfile(data),
      /Could not parse profile from Claude/,
    );
  });

  test('throws on Claude CLI failure', async () => {
    _setClaudeForTesting(async () => { throw new Error('ENOENT: claude not found'); });

    const data = {
      channels: [{ title: 'Ch', description: '' }],
      videos: [],
      stats: { topChannels: [], topCategories: [], totalVideos: 0 },
    };

    await assert.rejects(
      generateProfile(data),
      /Profile generation failed/,
    );
  });

  test('rejects profile with missing required fields', async () => {
    _setClaudeForTesting(async () => JSON.stringify({
      interests: ['gaming'],
      // missing preferredFormats, avoidPatterns, discoveryTerms
    }));

    const data = {
      channels: [{ title: 'Ch', description: '' }],
      videos: [],
      stats: { topChannels: [], topCategories: [], totalVideos: 0 },
    };

    await assert.rejects(
      generateProfile(data),
      /Could not parse profile from Claude/,
    );
  });

  test('rejects profile with empty arrays', async () => {
    _setClaudeForTesting(async () => JSON.stringify({
      interests: [],
      preferredFormats: ['tutorials'],
      avoidPatterns: ['horror'],
      discoveryTerms: ['science'],
    }));

    const data = {
      channels: [{ title: 'Ch', description: '' }],
      videos: [],
      stats: { topChannels: [], topCategories: [], totalVideos: 0 },
    };

    await assert.rejects(
      generateProfile(data),
      /Could not parse profile from Claude/,
    );
  });
});

// --- saveProfile tests ---

describe('saveProfile', () => {
  test('persists profile to store', async () => {
    const profile = {
      interests: ['gaming'],
      preferredFormats: ['tutorials'],
      avoidPatterns: ['horror'],
      discoveryTerms: ['minecraft'],
      sampleSize: 5,
      generatedAt: '2024-06-01T00:00:00Z',
      rawResponse: '{}',
    };

    await saveProfile(profile);
    const stored = await store.getProfile();
    assert.deepEqual(stored.interests, ['gaming']);
    assert.equal(stored.sampleSize, 5);
  });
});

// --- rebuildProfile tests ---

describe('rebuildProfile', () => {
  test('samples, generates, and saves in one call', async () => {
    await store.setChannels([makeChannel('UC1', 'ScienceChannel')]);
    const videos = {
      v1: makeVideo('v1', { channelTitle: 'ScienceChannel', categoryId: '28' }),
    };
    await store.setVideos(videos);
    _setClaudeForTesting(mockClaude(validProfileResponse));

    const profile = await rebuildProfile();
    assert.deepEqual(profile.interests, validProfileResponse.interests);
    assert.equal(profile.sampleSize, 1);

    // Verify it was saved
    const stored = await store.getProfile();
    assert.deepEqual(stored.interests, validProfileResponse.interests);
  });

  test('throws when no data is available', async () => {
    await assert.rejects(
      rebuildProfile(),
      /No subscriptions or liked videos found/,
    );
  });

  test('works with channels only (no liked videos)', async () => {
    await store.setChannels([makeChannel('UC1', 'TestChannel')]);
    _setClaudeForTesting(mockClaude(validProfileResponse));

    const profile = await rebuildProfile();
    assert.deepEqual(profile.interests, validProfileResponse.interests);
    assert.equal(profile.sampleSize, 0);
  });
});

// --- Integration tests via HTTP ---

describe('Profile API routes', () => {
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
    _setClaudeForTesting(null);
    await store.setChannels([]);
    await store.setVideos({});
    await store.setProfile(null);
    await store.write('sessions.json', {});
  });

  test('GET /api/profile requires auth', async () => {
    const res = await httpFetch('/api/profile');
    assert.equal(res.status, 401);
  });

  test('GET /api/profile returns null when no profile exists', async () => {
    const cookie = await login();
    const res = await httpFetch('/api/profile', {
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.profile, null);
  });

  test('GET /api/profile returns saved profile', async () => {
    const saved = {
      interests: ['gaming'],
      preferredFormats: ['tutorials'],
      avoidPatterns: ['horror'],
      discoveryTerms: ['minecraft'],
      sampleSize: 3,
      generatedAt: '2024-06-01T00:00:00Z',
      rawResponse: '{}',
    };
    await store.setProfile(saved);

    const cookie = await login();
    const res = await httpFetch('/api/profile', {
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.profile.interests, ['gaming']);
    assert.equal(body.profile.sampleSize, 3);
  });

  test('POST /api/profile/rebuild requires auth', async () => {
    const res = await httpFetch('/api/profile/rebuild', { method: 'POST' });
    assert.equal(res.status, 401);
  });

  test('POST /api/profile/rebuild generates and returns profile', async () => {
    await store.setChannels([makeChannel('UC1', 'TestChan')]);
    await store.setVideos({ v1: makeVideo('v1') });
    _setClaudeForTesting(mockClaude(validProfileResponse));

    const cookie = await login();
    const res = await httpFetch('/api/profile/rebuild', {
      method: 'POST',
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.profile.interests, validProfileResponse.interests);

    // Verify it was persisted
    const stored = await store.getProfile();
    assert.deepEqual(stored.interests, validProfileResponse.interests);
  });

  test('POST /api/profile/rebuild returns 500 when no data', async () => {
    _setClaudeForTesting(mockClaude(validProfileResponse));

    const cookie = await login();
    const res = await httpFetch('/api/profile/rebuild', {
      method: 'POST',
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error.includes('No subscriptions or liked videos'));
  });

  test('POST /api/profile/rebuild returns 500 on Claude failure', async () => {
    await store.setChannels([makeChannel('UC1', 'TestChan')]);
    _setClaudeForTesting(async () => { throw new Error('Claude not available'); });

    const cookie = await login();
    const res = await httpFetch('/api/profile/rebuild', {
      method: 'POST',
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error.includes('Profile generation failed'));
  });
});
