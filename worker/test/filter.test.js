/**
 * Tests for worker/lib/filter.js — AI content filter.
 *
 * All Claude CLI invocations are mocked via _setExecForTesting.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyVideos,
  buildPrompt,
  parseResponse,
  _setExecForTesting,
} from '../lib/filter.js';
import { parseUsageLogText } from '../../lib/ai-usage.js';

let usageLogDir = null;
let usageLogPath = null;

beforeEach(async () => {
  usageLogDir = await mkdtemp(join(tmpdir(), 'yourtube-worker-filter-usage-'));
  usageLogPath = join(usageLogDir, 'ai-usage.jsonl');
  process.env.YOURTUBE_AI_USAGE_LOG = usageLogPath;
});

afterEach(async () => {
  _setExecForTesting(null);
  delete process.env.YOURTUBE_AI_USAGE_LOG;
  if (usageLogDir) {
    await rm(usageLogDir, { recursive: true, force: true });
  }
  usageLogDir = null;
  usageLogPath = null;
});

async function readUsageRecords() {
  return parseUsageLogText(await readFile(usageLogPath, 'utf8'));
}

// --- Helpers ---

function makeVideo(id, overrides = {}) {
  return {
    videoId: id,
    title: `Test Video ${id}`,
    channelTitle: 'Test Channel',
    ...overrides,
  };
}

const DEFAULT_CONTEXT = {
  age: 10,
  guidelines: 'No violent content. Educational preferred.',
};

// --- buildPrompt tests ---

describe('buildPrompt', () => {
  test('includes child age in prompt', () => {
    const prompt = buildPrompt([makeVideo('v1')], { age: 8, guidelines: 'Be safe' });
    assert.ok(prompt.includes('8'), 'prompt should include the age');
  });

  test('includes parent guidelines in prompt', () => {
    const prompt = buildPrompt([makeVideo('v1')], DEFAULT_CONTEXT);
    assert.ok(prompt.includes('No violent content. Educational preferred.'));
  });

  test('includes video title in prompt', () => {
    const prompt = buildPrompt([makeVideo('v1', { title: 'Cool Science Experiment' })], DEFAULT_CONTEXT);
    assert.ok(prompt.includes('Cool Science Experiment'));
  });

  test('includes videoId in prompt', () => {
    const prompt = buildPrompt([makeVideo('myVideoId')], DEFAULT_CONTEXT);
    assert.ok(prompt.includes('myVideoId'));
  });

  test('works with no guidelines', () => {
    const prompt = buildPrompt([makeVideo('v1')], { age: 7 });
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 0);
  });

  test('works with no age', () => {
    const prompt = buildPrompt([makeVideo('v1')], { guidelines: 'Only educational' });
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 0);
  });
});

// --- parseResponse tests ---

describe('parseResponse', () => {
  test('parses valid JSON array', () => {
    const raw = JSON.stringify([{ videoId: 'v1', approved: true, reason: 'good' }]);
    const result = parseResponse(raw);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].videoId, 'v1');
    assert.equal(result[0].approved, true);
  });

  test('strips markdown code fences', () => {
    const raw = '```json\n[{"videoId":"v1","approved":false,"reason":"bad"}]\n```';
    const result = parseResponse(raw);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].approved, false);
  });

  test('returns null for garbage input', () => {
    assert.equal(parseResponse('this is not json'), null);
    assert.equal(parseResponse('{"videoId":"v1"}'), null); // object, not array
    assert.equal(parseResponse('[{"videoId":"v1"}]'), null); // missing approved
    assert.equal(parseResponse(''), null);
    assert.equal(parseResponse(null), null);
    assert.equal(parseResponse(42), null);
  });

  test('returns null for array missing required fields', () => {
    const raw = JSON.stringify([{ videoId: 'v1' }]); // missing approved
    assert.equal(parseResponse(raw), null);
  });

  test('returns null for non-array JSON', () => {
    const raw = JSON.stringify({ videoId: 'v1', approved: true });
    assert.equal(parseResponse(raw), null);
  });
});

// --- classifyVideos tests ---

describe('classifyVideos', () => {
  test('returns empty array for empty input', async () => {
    const result = await classifyVideos([], DEFAULT_CONTEXT);
    assert.deepEqual(result, []);
  });

  test('calls mock executor and returns classifications', async () => {
    _setExecForTesting(async () =>
      JSON.stringify([
        { videoId: 'v1', approved: true, reason: 'educational' },
        { videoId: 'v2', approved: false, reason: 'too violent' },
      ])
    );

    const videos = [makeVideo('v1'), makeVideo('v2')];
    const result = await classifyVideos(videos, DEFAULT_CONTEXT);

    assert.equal(result.length, 2);
    assert.equal(result[0].videoId, 'v1');
    assert.equal(result[0].approved, true);
    assert.equal(result[1].videoId, 'v2');
    assert.equal(result[1].approved, false);
  });

  test('logs successful Claude usage with model, tokens, cost, and operation', async () => {
    _setExecForTesting(async () =>
      JSON.stringify({
        type: 'result',
        model: 'claude-3-5-haiku-latest',
        total_cost_usd: 0.0012,
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
        result: JSON.stringify([{ videoId: 'v1', approved: true, reason: 'ok' }]),
      })
    );

    await classifyVideos([makeVideo('v1')], DEFAULT_CONTEXT);

    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].component, 'worker');
    assert.equal(records[0].operation, 'filter.classify');
    assert.equal(records[0].model, 'haiku');
    assert.equal(records[0].actual_model, 'claude-3-5-haiku-latest');
    assert.equal(records[0].status, 'success');
    assert.equal(records[0].input_tokens, 120);
    assert.equal(records[0].output_tokens, 30);
    assert.equal(records[0].total_tokens, 160);
    assert.equal(records[0].cost_usd, 0.0012);
    assert.ok(records[0].day);
    assert.ok(records[0].prompt_chars > 0);
    assert.equal('prompt' in records[0], false);
  });

  test('gracefully degrades on executor failure — fails closed — approved: false, reason: unclassified', async () => {
    _setExecForTesting(async () => {
      throw new Error('claude: command not found');
    });

    const result = await classifyVideos([makeVideo('v1')], DEFAULT_CONTEXT);
    assert.equal(result.length, 1);
    assert.equal(result[0].videoId, 'v1');
    assert.equal(result[0].approved, false);
    assert.ok(result[0].reason.includes('unclassified'));
  });

  test('logs failed Claude usage attempts', async () => {
    _setExecForTesting(async () => {
      const err = new Error('claude: command not found');
      err.code = 'ENOENT';
      throw err;
    });

    await classifyVideos([makeVideo('v1')], DEFAULT_CONTEXT);

    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'failure');
    assert.equal(records[0].model, 'haiku');
    assert.equal(records[0].error.code, 'ENOENT');
    assert.equal(records[0].total_tokens, null);
  });

  test('gracefully degrades on unparseable response', async () => {
    _setExecForTesting(async () => 'not json at all');

    const result = await classifyVideos([makeVideo('v1')], DEFAULT_CONTEXT);
    assert.equal(result[0].approved, false);
    assert.ok(result[0].reason.includes('unclassified'));
  });

  test('batches by 10', async () => {
    const calls = [];
    _setExecForTesting(async (prompt) => {
      // Extract the JSON video list section and count entries
      const listMatch = prompt.match(/<videos>\n([\s\S]*?)\n<\/videos>/);
      const listJson = listMatch ? listMatch[1].trim() : '[]';
      const ids = JSON.parse(listJson).map(v => v.videoId);
      calls.push(ids.length);
      return JSON.stringify(ids.map(id => ({ videoId: id, approved: true, reason: 'ok' })));
    });

    const videos = Array.from({ length: 15 }, (_, i) => makeVideo(`v${i}`));
    const result = await classifyVideos(videos, DEFAULT_CONTEXT);

    assert.equal(calls.length, 2, 'should make 2 batch calls for 15 videos');
    assert.equal(calls[0], 10, 'first batch should have 10');
    assert.equal(calls[1], 5, 'second batch should have 5');
    assert.equal(result.length, 15);
  });

  test('fills in unclassified for videos Claude skipped', async () => {
    _setExecForTesting(async () =>
      JSON.stringify([{ videoId: 'v1', approved: true, reason: 'fine' }])
      // v2 omitted
    );

    const result = await classifyVideos([makeVideo('v1'), makeVideo('v2')], DEFAULT_CONTEXT);
    assert.equal(result.length, 2);
    assert.equal(result[1].videoId, 'v2');
    assert.equal(result[1].approved, false);
    assert.ok(result[1].reason.includes('unclassified'));
  });
});
