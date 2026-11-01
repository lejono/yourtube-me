/**
 * Tests for lib/filter.js — AI content filter.
 *
 * All Claude CLI calls are mocked via _setExecForTesting, so no real Claude
 * invocation happens during tests.
 */

import { test, describe, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated data dir
const testDataName = `test-data-filter-${randomBytes(4).toString('hex')}`;
process.env.YOURTUBE_DATA_DIR = testDataName;

const {
  classifyVideos,
  classifyVideo,
  getCachedDecision,
  cacheDecision,
  classifyWithCache,
  _setExecForTesting,
} = await import('../lib/filter.js');

const { getAICache, setAICache } = await import('../lib/store.js');
const { DATA_DIR } = await import('../config.js');
const { parseUsageLogText } = await import('../lib/ai-usage.js');

let usageLogDir = null;
let usageLogPath = null;

beforeEach(async () => {
  usageLogDir = await mkdtemp(join(tmpdir(), 'yourtube-root-filter-usage-'));
  usageLogPath = join(usageLogDir, 'ai-usage.jsonl');
  process.env.YOURTUBE_AI_USAGE_LOG = usageLogPath;
});

afterEach(async () => {
  delete process.env.YOURTUBE_AI_USAGE_LOG;
  if (usageLogDir) {
    await rm(usageLogDir, { recursive: true, force: true });
  }
  usageLogDir = null;
  usageLogPath = null;
});

after(async () => {
  _setExecForTesting(null);
  await rm(DATA_DIR, { recursive: true, force: true });
});

// --- Helpers ---

function makeVideo(id, overrides = {}) {
  return {
    videoId: id,
    title: `Test Video ${id}`,
    channelId: 'UC_test',
    channelTitle: 'Test Channel',
    description: 'A test video description',
    tags: ['test'],
    categoryId: '22',
    ...overrides,
  };
}

function mockClaudeResponse(decisions) {
  return async () => JSON.stringify(decisions);
}

async function readUsageRecords() {
  return parseUsageLogText(await readFile(usageLogPath, 'utf8'));
}

const DEFAULT_CONTEXT = {
  profile: { interests: ['science', 'nature'] },
  guidelines: 'No violent content. Educational preferred.',
  blockedChannels: [],
  blockedVideos: [],
};

// --- Cache tests ---

describe('getCachedDecision / cacheDecision', () => {
  beforeEach(async () => {
    await setAICache({});
  });

  test('returns null for uncached video', async () => {
    const result = await getCachedDecision('vid_unknown');
    assert.equal(result, null);
  });

  test('cacheDecision stores and getCachedDecision retrieves', async () => {
    await cacheDecision('vid1', { approved: true, reason: 'looks good' });
    const result = await getCachedDecision('vid1');
    assert.equal(result.approved, true);
    assert.equal(result.reason, 'looks good');
    assert.ok(result.timestamp, 'should have a timestamp');
  });

  test('cacheDecision preserves existing entries', async () => {
    await cacheDecision('vid1', { approved: true, reason: 'ok' });
    await cacheDecision('vid2', { approved: false, reason: 'nope' });

    const r1 = await getCachedDecision('vid1');
    const r2 = await getCachedDecision('vid2');
    assert.equal(r1.approved, true);
    assert.equal(r2.approved, false);
  });

  test('cacheDecision overwrites existing entry', async () => {
    await cacheDecision('vid1', { approved: false, reason: 'initially blocked' });
    await cacheDecision('vid1', { approved: true, reason: 'reconsidered' });

    const result = await getCachedDecision('vid1');
    assert.equal(result.approved, true);
    assert.equal(result.reason, 'reconsidered');
  });
});

// --- classifyVideos tests ---

describe('classifyVideos', () => {
  beforeEach(async () => {
    await setAICache({});
  });

  test('returns empty array for empty input', async () => {
    const result = await classifyVideos([], DEFAULT_CONTEXT);
    assert.deepEqual(result, []);
  });

  test('returns empty array for null input', async () => {
    const result = await classifyVideos(null, DEFAULT_CONTEXT);
    assert.deepEqual(result, []);
  });

  test('calls Claude and parses valid JSON response', async () => {
    _setExecForTesting(mockClaudeResponse([
      { videoId: 'vid1', approved: true, reason: 'educational' },
      { videoId: 'vid2', approved: false, reason: 'too violent' },
    ]));

    const videos = [makeVideo('vid1'), makeVideo('vid2')];
    const result = await classifyVideos(videos, DEFAULT_CONTEXT);

    assert.equal(result.length, 2);
    assert.equal(result[0].videoId, 'vid1');
    assert.equal(result[0].approved, true);
    assert.equal(result[1].videoId, 'vid2');
    assert.equal(result[1].approved, false);

    _setExecForTesting(null);
  });

  test('logs root filter Claude usage', async () => {
    _setExecForTesting(async () =>
      JSON.stringify({
        type: 'result',
        model: 'claude-3-5-haiku-latest',
        total_cost_usd: 0.002,
        usage: { input_tokens: 40, output_tokens: 10 },
        result: JSON.stringify([{ videoId: 'vid1', approved: true, reason: 'ok' }]),
      })
    );

    await classifyVideos([makeVideo('vid1')], DEFAULT_CONTEXT);

    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].component, 'server');
    assert.equal(records[0].operation, 'filter.classify');
    assert.equal(records[0].model, 'haiku');
    assert.equal(records[0].status, 'success');
    assert.equal(records[0].total_tokens, 50);
    assert.equal(records[0].cost_usd, 0.002);

    _setExecForTesting(null);
  });

  test('handles markdown-fenced JSON response', async () => {
    _setExecForTesting(async () =>
      '```json\n[{"videoId":"vid1","approved":true,"reason":"ok"}]\n```'
    );

    const result = await classifyVideos([makeVideo('vid1')], DEFAULT_CONTEXT);
    assert.equal(result[0].approved, true);

    _setExecForTesting(null);
  });

  test('returns unclassified on CLI failure', async () => {
    _setExecForTesting(async () => {
      throw new Error('claude: command not found');
    });

    const result = await classifyVideos([makeVideo('vid1')], DEFAULT_CONTEXT);
    assert.equal(result.length, 1);
    assert.equal(result[0].videoId, 'vid1');
    assert.equal(result[0].approved, true);
    assert.ok(result[0].reason.includes('unclassified'));

    _setExecForTesting(null);
  });

  test('retries once on unparseable response then returns unclassified', async () => {
    let callCount = 0;
    _setExecForTesting(async () => {
      callCount++;
      return 'this is not json at all';
    });

    const result = await classifyVideos([makeVideo('vid1')], DEFAULT_CONTEXT);
    assert.equal(callCount, 2, 'should have retried once');
    assert.equal(result[0].approved, true);
    assert.ok(result[0].reason.includes('unclassified'));

    _setExecForTesting(null);
  });

  test('succeeds on retry after initial bad response', async () => {
    let callCount = 0;
    _setExecForTesting(async () => {
      callCount++;
      if (callCount === 1) return 'garbage';
      return JSON.stringify([{ videoId: 'vid1', approved: false, reason: 'bad content' }]);
    });

    const result = await classifyVideos([makeVideo('vid1')], DEFAULT_CONTEXT);
    assert.equal(callCount, 2);
    assert.equal(result[0].approved, false);
    assert.equal(result[0].reason, 'bad content');

    _setExecForTesting(null);
  });

  test('fills in missing decisions for videos Claude skipped', async () => {
    _setExecForTesting(mockClaudeResponse([
      { videoId: 'vid1', approved: true, reason: 'fine' },
      // vid2 omitted from response
    ]));

    const videos = [makeVideo('vid1'), makeVideo('vid2')];
    const result = await classifyVideos(videos, DEFAULT_CONTEXT);

    assert.equal(result.length, 2);
    assert.equal(result[0].approved, true);
    assert.equal(result[1].videoId, 'vid2');
    assert.equal(result[1].approved, true); // defaults to approved
    assert.ok(result[1].reason.includes('unclassified'));

    _setExecForTesting(null);
  });

  test('rejects response that is not an array', async () => {
    let callCount = 0;
    _setExecForTesting(async () => {
      callCount++;
      return JSON.stringify({ videoId: 'vid1', approved: true });
    });

    const result = await classifyVideos([makeVideo('vid1')], DEFAULT_CONTEXT);
    assert.equal(callCount, 2); // retried
    assert.ok(result[0].reason.includes('unclassified'));

    _setExecForTesting(null);
  });

  test('rejects response items missing required fields', async () => {
    let callCount = 0;
    _setExecForTesting(async () => {
      callCount++;
      return JSON.stringify([{ videoId: 'vid1' }]); // missing approved
    });

    const result = await classifyVideos([makeVideo('vid1')], DEFAULT_CONTEXT);
    assert.equal(callCount, 2);
    assert.ok(result[0].reason.includes('unclassified'));

    _setExecForTesting(null);
  });

  test('prompt includes parent guidelines', async () => {
    let capturedPrompt = '';
    _setExecForTesting(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify([{ videoId: 'vid1', approved: true, reason: 'ok' }]);
    });

    await classifyVideos([makeVideo('vid1')], {
      ...DEFAULT_CONTEXT,
      guidelines: 'No scary stuff please',
    });

    assert.ok(capturedPrompt.includes('No scary stuff please'));
    _setExecForTesting(null);
  });

  test('prompt includes video metadata', async () => {
    let capturedPrompt = '';
    _setExecForTesting(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify([{ videoId: 'vid1', approved: true, reason: 'ok' }]);
    });

    await classifyVideos([makeVideo('vid1', { title: 'Cool Science Experiment' })], DEFAULT_CONTEXT);

    assert.ok(capturedPrompt.includes('Cool Science Experiment'));
    _setExecForTesting(null);
  });

  test('handles empty context gracefully', async () => {
    _setExecForTesting(mockClaudeResponse([
      { videoId: 'vid1', approved: true, reason: 'ok' },
    ]));

    const result = await classifyVideos([makeVideo('vid1')], {});
    assert.equal(result[0].approved, true);

    _setExecForTesting(null);
  });
});

// --- classifyVideo (single) ---

describe('classifyVideo', () => {
  beforeEach(async () => {
    await setAICache({});
  });

  test('returns single decision', async () => {
    _setExecForTesting(mockClaudeResponse([
      { videoId: 'vid1', approved: true, reason: 'great' },
    ]));

    const result = await classifyVideo(makeVideo('vid1'), DEFAULT_CONTEXT);
    assert.equal(result.videoId, 'vid1');
    assert.equal(result.approved, true);

    _setExecForTesting(null);
  });
});

// --- classifyWithCache ---

describe('classifyWithCache', () => {
  beforeEach(async () => {
    await setAICache({});
  });

  test('returns empty array for empty input', async () => {
    const result = await classifyWithCache([], DEFAULT_CONTEXT);
    assert.deepEqual(result, []);
  });

  test('returns cached decisions without calling Claude', async () => {
    await setAICache({
      vid1: { approved: true, reason: 'cached approval', timestamp: '2024-01-01T00:00:00Z' },
    });

    let claudeCalled = false;
    _setExecForTesting(async () => {
      claudeCalled = true;
      return '[]';
    });

    const result = await classifyWithCache([makeVideo('vid1')], DEFAULT_CONTEXT);
    assert.equal(claudeCalled, false, 'should not call Claude for cached video');
    assert.equal(result[0].videoId, 'vid1');
    assert.equal(result[0].approved, true);
    assert.equal(result[0].reason, 'cached approval');

    _setExecForTesting(null);
  });

  test('calls Claude only for uncached videos', async () => {
    await setAICache({
      vid1: { approved: true, reason: 'cached', timestamp: '2024-01-01T00:00:00Z' },
    });

    let classifiedIds = [];
    _setExecForTesting(async (prompt) => {
      // Extract video IDs from prompt
      const match = prompt.match(/"videoId"\s*:\s*"([^"]+)"/g);
      classifiedIds = match ? match.map(m => m.match(/"([^"]+)"$/)[1]) : [];
      return JSON.stringify([{ videoId: 'vid2', approved: false, reason: 'bad' }]);
    });

    const videos = [makeVideo('vid1'), makeVideo('vid2')];
    const result = await classifyWithCache(videos, DEFAULT_CONTEXT);

    assert.equal(result.length, 2);
    // vid1 from cache
    assert.equal(result[0].videoId, 'vid1');
    assert.equal(result[0].approved, true);
    assert.equal(result[0].reason, 'cached');
    // vid2 freshly classified
    assert.equal(result[1].videoId, 'vid2');
    assert.equal(result[1].approved, false);

    // Only vid2 was sent to Claude
    assert.ok(!classifiedIds.includes('vid1'), 'vid1 should not be sent to Claude');
    assert.ok(classifiedIds.includes('vid2'), 'vid2 should be sent to Claude');

    _setExecForTesting(null);
  });

  test('caches new decisions after classification', async () => {
    _setExecForTesting(mockClaudeResponse([
      { videoId: 'vid1', approved: true, reason: 'approved by AI' },
    ]));

    await classifyWithCache([makeVideo('vid1')], DEFAULT_CONTEXT);

    const cached = await getCachedDecision('vid1');
    assert.equal(cached.approved, true);
    assert.equal(cached.reason, 'approved by AI');
    assert.ok(cached.timestamp);

    _setExecForTesting(null);
  });

  test('handles mixed cached and uncached batch', async () => {
    await setAICache({
      vid1: { approved: true, reason: 'cached', timestamp: '2024-01-01T00:00:00Z' },
      vid3: { approved: false, reason: 'cached bad', timestamp: '2024-01-01T00:00:00Z' },
    });

    _setExecForTesting(mockClaudeResponse([
      { videoId: 'vid2', approved: true, reason: 'fresh' },
    ]));

    const videos = [makeVideo('vid1'), makeVideo('vid2'), makeVideo('vid3')];
    const result = await classifyWithCache(videos, DEFAULT_CONTEXT);

    assert.equal(result.length, 3);
    assert.equal(result[0].reason, 'cached');
    assert.equal(result[1].reason, 'fresh');
    assert.equal(result[2].reason, 'cached bad');

    _setExecForTesting(null);
  });

  test('Claude failure caches unclassified decisions', async () => {
    _setExecForTesting(async () => {
      throw new Error('claude not found');
    });

    await classifyWithCache([makeVideo('vid1')], DEFAULT_CONTEXT);

    // The unclassified result should still be cached
    const cached = await getCachedDecision('vid1');
    assert.equal(cached.approved, true);
    assert.ok(cached.reason.includes('unclassified'));

    _setExecForTesting(null);
  });

  test('preserves original video order in results', async () => {
    await setAICache({
      vid3: { approved: true, reason: 'c3', timestamp: '2024-01-01T00:00:00Z' },
    });

    _setExecForTesting(mockClaudeResponse([
      { videoId: 'vid1', approved: true, reason: 'c1' },
      { videoId: 'vid2', approved: false, reason: 'c2' },
    ]));

    const videos = [makeVideo('vid1'), makeVideo('vid2'), makeVideo('vid3')];
    const result = await classifyWithCache(videos, DEFAULT_CONTEXT);

    assert.equal(result[0].videoId, 'vid1');
    assert.equal(result[1].videoId, 'vid2');
    assert.equal(result[2].videoId, 'vid3');

    _setExecForTesting(null);
  });
});
