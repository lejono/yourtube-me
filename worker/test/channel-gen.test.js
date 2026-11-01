/**
 * Tests for worker/lib/channel-gen.js — Opus-powered channel generation.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateChannels, parseChannelResponse, parseGuidelinesReview, reviewChannelsAgainstGuidelines, _setExecForTesting } from '../lib/channel-gen.js';
import { parseUsageLogText } from '../../lib/ai-usage.js';

let usageLogDir = null;
let usageLogPath = null;

beforeEach(async () => {
  usageLogDir = await mkdtemp(join(tmpdir(), 'yourtube-worker-channel-usage-'));
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

// ---- parseChannelResponse ----

describe('parseChannelResponse', () => {
  test('parses valid JSON with channels array', () => {
    const raw = JSON.stringify({
      channels: [
        { name: 'Vsauce', reason: 'Educational science', searchQuery: 'Vsauce YouTube' },
        { name: 'Kurzgesagt', reason: 'Animated explainers', searchQuery: 'Kurzgesagt YouTube' },
      ],
    });
    const result = parseChannelResponse(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'Vsauce');
    assert.equal(result[0].reason, 'Educational science');
    assert.equal(result[0].searchQuery, 'Vsauce YouTube');
    assert.equal(result[1].name, 'Kurzgesagt');
  });

  test('returns empty array for garbage input', () => {
    assert.deepEqual(parseChannelResponse('not json at all'), []);
  });

  test('returns empty array for empty string', () => {
    assert.deepEqual(parseChannelResponse(''), []);
  });

  test('returns empty array when channels key is missing', () => {
    assert.deepEqual(parseChannelResponse(JSON.stringify({ foo: 'bar' })), []);
  });

  test('returns empty array when channels is not an array', () => {
    assert.deepEqual(parseChannelResponse(JSON.stringify({ channels: 'oops' })), []);
  });

  test('filters out entries missing name or searchQuery', () => {
    const raw = JSON.stringify({
      channels: [
        { name: 'Good Channel', reason: 'Fine', searchQuery: 'Good Channel YouTube' },
        { reason: 'No name', searchQuery: 'something' },
        { name: 'No search query', reason: 'Fine' },
      ],
    });
    const result = parseChannelResponse(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Good Channel');
  });
});

// ---- generateChannels ----

describe('generateChannels', () => {
  test('returns channel suggestions with name, reason, searchQuery fields', async () => {
    const mockResponse = JSON.stringify({
      channels: [
        { name: 'Mark Rober', reason: 'Fun engineering experiments', searchQuery: 'Mark Rober YouTube' },
        { name: 'SciShow Kids', reason: 'Science for kids', searchQuery: 'SciShow Kids YouTube' },
      ],
    });

    _setExecForTesting(async (_prompt) => mockResponse);

    const kidProfile = {
      kid_name: 'Alex',
      age: 9,
      interests: ['science', 'engineering'],
      guidelines: 'Educational content preferred',
    };

    const channels = await generateChannels(kidProfile);
    assert.equal(channels.length, 2);

    const ch = channels[0];
    assert.ok(ch.name, 'should have name');
    assert.ok(ch.reason, 'should have reason');
    assert.ok(ch.searchQuery, 'should have searchQuery');
    assert.equal(ch.name, 'Mark Rober');
    assert.equal(ch.searchQuery, 'Mark Rober YouTube');
  });

  test('logs successful Sonnet usage for channel generation', async () => {
    _setExecForTesting(async () =>
      JSON.stringify({
        type: 'result',
        model: 'claude-opus-latest',
        total_cost_usd: 0.045,
        usage: { input_tokens: 1000, output_tokens: 250 },
        result: JSON.stringify({ channels: [] }),
      })
    );

    await generateChannels({ kid_name: 'Alex', age: 9, interests: ['science'], guidelines: null });

    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].component, 'worker');
    assert.equal(records[0].operation, 'channel.generate');
    assert.equal(records[0].model, 'sonnet');
    assert.equal(records[0].actual_model, 'claude-opus-latest');
    assert.equal(records[0].status, 'success');
    assert.equal(records[0].total_tokens, 1250);
    assert.equal(records[0].cost_usd, 0.045);
  });

  test('returns empty array when CLI fails', async () => {
    _setExecForTesting(async () => { throw new Error('Claude CLI not available'); });

    const kidProfile = { kid_name: 'Sam', age: 8, interests: ['Lego'], guidelines: null };
    const channels = await generateChannels(kidProfile);
    assert.deepEqual(channels, []);
  });

  test('logs failed Sonnet usage attempts', async () => {
    _setExecForTesting(async () => {
      const err = new Error('Claude CLI not available');
      err.code = 'ENOENT';
      throw err;
    });

    await generateChannels({ kid_name: 'Sam', age: 8, interests: ['Lego'], guidelines: null });

    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, 'channel.generate');
    assert.equal(records[0].model, 'sonnet');
    assert.equal(records[0].status, 'failure');
    assert.equal(records[0].error.code, 'ENOENT');
  });

  test('returns empty array when CLI returns garbage', async () => {
    _setExecForTesting(async () => 'this is not json');

    const kidProfile = { kid_name: 'Sam', age: 8, interests: ['Lego'], guidelines: null };
    const channels = await generateChannels(kidProfile);
    assert.deepEqual(channels, []);
  });

  test('passes kid profile info to the prompt', async () => {
    let capturedPrompt = null;
    _setExecForTesting(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ channels: [] });
    });

    const kidProfile = { kid_name: 'Sam', age: 10, interests: ['gaming', 'parkour'], guidelines: 'No violence' };
    await generateChannels(kidProfile);

    assert.ok(capturedPrompt.includes('10'), 'prompt should include age');
    assert.ok(capturedPrompt.includes('gaming'), 'prompt should include interests');
  });

  test('returns channel suggestions with description field', async () => {
    const mockResponse = JSON.stringify({
      channels: [
        {
          name: 'Mark Rober',
          description: 'Former NASA engineer who makes science and engineering videos.',
          reason: "Matches Alex's interest in engineering.",
          searchQuery: 'Mark Rober YouTube',
        },
      ],
    });

    _setExecForTesting(async () => mockResponse);

    const kidProfile = { kid_name: 'Alex', age: 9, interests: ['engineering'], guidelines: null };
    const channels = await generateChannels(kidProfile);

    assert.equal(channels.length, 1);
    assert.ok(channels[0].description, 'should have description field');
    assert.equal(channels[0].description, 'Former NASA engineer who makes science and engineering videos.');
  });

  test('prompt asks for description field in JSON output', async () => {
    let capturedPrompt = null;
    _setExecForTesting(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ channels: [] });
    });

    await generateChannels({ kid_name: 'Sam', age: 8, interests: ['lego'], guidelines: null });

    assert.ok(capturedPrompt.includes('description'), 'prompt should ask for description field');
  });
});

// --- parseChannelResponse with description field ---

describe('parseChannelResponse with description', () => {
  test('extracts description field from channel objects', () => {
    const raw = JSON.stringify({
      channels: [
        {
          name: 'Vsauce',
          description: 'Mind-bending science and philosophy questions with Michael Stevens.',
          reason: 'Great for curious kids',
          searchQuery: 'Vsauce YouTube',
        },
      ],
    });
    const result = parseChannelResponse(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].description, 'Mind-bending science and philosophy questions with Michael Stevens.');
  });

  test('still parses channels that have no description field', () => {
    const raw = JSON.stringify({
      channels: [
        { name: 'OldFormat', reason: 'Classic format', searchQuery: 'OldFormat YouTube' },
      ],
    });
    const result = parseChannelResponse(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'OldFormat');
  });
});

// ---- parseGuidelinesReview ----

describe('parseGuidelinesReview', () => {
  test('parses valid review response with compatible and incompatible channels', () => {
    const raw = JSON.stringify({
      reviews: [
        { title: 'Mark Rober', compatible: true, reason: 'Non-competitive educational content' },
        { title: 'Dude Perfect', compatible: false, reason: 'Competitive sports stunts conflict with no-competition guideline' },
      ],
    });
    const result = parseGuidelinesReview(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'Mark Rober');
    assert.equal(result[0].compatible, true);
    assert.equal(result[1].title, 'Dude Perfect');
    assert.equal(result[1].compatible, false);
    assert.ok(result[1].reason.includes('competition'));
  });

  test('returns empty array for garbage input', () => {
    assert.deepEqual(parseGuidelinesReview('not json'), []);
  });

  test('returns empty array when reviews key is missing', () => {
    assert.deepEqual(parseGuidelinesReview(JSON.stringify({ foo: 'bar' })), []);
  });

  test('filters out entries missing title or compatible field', () => {
    const raw = JSON.stringify({
      reviews: [
        { title: 'Good', compatible: true, reason: 'Fine' },
        { compatible: true, reason: 'No title' },
        { title: 'No compatible field', reason: 'Missing' },
      ],
    });
    const result = parseGuidelinesReview(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Good');
  });

  test('handles Claude CLI JSON wrapper with result field', () => {
    const inner = JSON.stringify({
      reviews: [
        { title: 'SciShow', compatible: true, reason: 'Fits guidelines' },
      ],
    });
    const raw = JSON.stringify({ type: 'text', result: inner });
    const result = parseGuidelinesReview(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'SciShow');
  });
});

// ---- reviewChannelsAgainstGuidelines ----

describe('reviewChannelsAgainstGuidelines', () => {
  test('returns review decisions for each channel', async () => {
    const mockResponse = JSON.stringify({
      reviews: [
        { title: 'Mark Rober', compatible: true, reason: 'Educational, non-competitive' },
        { title: 'Dude Perfect', compatible: false, reason: 'Competitive sports content' },
      ],
    });
    _setExecForTesting(async () => mockResponse);

    const kidProfile = { kid_name: 'Alex', age: 9, interests: ['science'], guidelines: 'No competitive content' };
    const channels = [
      { title: 'Mark Rober', channel_id: 'UCY1kMZp36IQSyNx_9h4mpCg', reason: 'Engineering videos' },
      { title: 'Dude Perfect', channel_id: 'UCRijo3ddMTht_IHyNSNXpNQ', reason: 'Sports tricks' },
    ];

    const result = await reviewChannelsAgainstGuidelines(kidProfile, channels);
    assert.equal(result.length, 2);
    assert.equal(result[0].compatible, true);
    assert.equal(result[1].compatible, false);
  });

  test('includes guidelines in the prompt', async () => {
    let capturedPrompt = null;
    _setExecForTesting(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ reviews: [] });
    });

    const kidProfile = { kid_name: 'Sam', age: 8, interests: ['gaming'], guidelines: 'Only female presenters' };
    await reviewChannelsAgainstGuidelines(kidProfile, [{ title: 'TestChan', channel_id: 'abc', reason: 'Test' }]);

    assert.ok(capturedPrompt.includes('Only female presenters'), 'prompt should include guidelines');
    assert.ok(capturedPrompt.includes('TestChan'), 'prompt should include channel names');
  });

  test('returns empty array when CLI fails', async () => {
    _setExecForTesting(async () => { throw new Error('CLI unavailable'); });

    const kidProfile = { kid_name: 'Sam', age: 8, interests: ['gaming'], guidelines: 'No violence' };
    const result = await reviewChannelsAgainstGuidelines(kidProfile, [{ title: 'Test', channel_id: 'x', reason: 'test' }]);
    assert.deepEqual(result, []);
  });
});
