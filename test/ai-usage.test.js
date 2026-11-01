import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildClaudeUsageRecord,
  parseUsageLogText,
  summarizeUsageRecords,
  writeClaudeUsageRecord,
} from '../lib/ai-usage.js';

test('buildClaudeUsageRecord extracts model, tokens, cost, and day', () => {
  const record = buildClaudeUsageRecord({
    component: 'worker',
    operation: 'filter.classify',
    model: 'haiku',
    prompt: 'Classify this',
    stdout: JSON.stringify({
      type: 'result',
      model: 'claude-3-5-haiku-latest',
      total_cost_usd: 0.003,
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 10,
      },
      result: '[]',
    }),
    startedAt: new Date('2026-05-02T10:00:00Z'),
    finishedAt: new Date('2026-05-02T10:00:02Z'),
  });

  assert.equal(record.component, 'worker');
  assert.equal(record.operation, 'filter.classify');
  assert.equal(record.model, 'haiku');
  assert.equal(record.actual_model, 'claude-3-5-haiku-latest');
  assert.equal(record.status, 'success');
  assert.equal(record.input_tokens, 100);
  assert.equal(record.output_tokens, 25);
  assert.equal(record.cache_creation_input_tokens, 5);
  assert.equal(record.cache_read_input_tokens, 10);
  assert.equal(record.total_tokens, 140);
  assert.equal(record.cost_usd, 0.003);
  assert.equal(record.prompt_chars, 13);
  assert.equal(record.day, '2026-05-02');
});

test('usage log can be summarized by day, model, and operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yourtube-ai-usage-test-'));
  const logPath = join(dir, 'ai-usage.jsonl');

  try {
    await writeClaudeUsageRecord(buildClaudeUsageRecord({
      component: 'worker',
      operation: 'filter.classify',
      model: 'haiku',
      prompt: 'one',
      stdout: JSON.stringify({
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
        result: '[]',
      }),
      startedAt: new Date('2026-05-02T10:00:00Z'),
      finishedAt: new Date('2026-05-02T10:00:01Z'),
    }), { logPath });

    await writeClaudeUsageRecord(buildClaudeUsageRecord({
      component: 'worker',
      operation: 'channel.generate',
      model: 'opus',
      prompt: 'two',
      error: new Error('boom'),
      startedAt: new Date('2026-05-02T11:00:00Z'),
      finishedAt: new Date('2026-05-02T11:00:01Z'),
    }), { logPath });

    const records = parseUsageLogText(await readFile(logPath, 'utf8'));
    const summary = summarizeUsageRecords(records);

    assert.equal(summary['2026-05-02'].total.calls, 2);
    assert.equal(summary['2026-05-02'].total.successes, 1);
    assert.equal(summary['2026-05-02'].total.failures, 1);
    assert.equal(summary['2026-05-02'].total.total_tokens, 15);
    assert.equal(summary['2026-05-02'].total.cost_usd, 0.001);
    assert.equal(summary['2026-05-02'].models.haiku.calls, 1);
    assert.equal(summary['2026-05-02'].models.opus.calls, 1);
    assert.equal(summary['2026-05-02'].operations['worker.filter.classify'].calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
