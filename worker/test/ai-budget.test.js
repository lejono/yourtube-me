/**
 * Spending cap and kill switch for Claude calls.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withClaudeUsageLog, checkAIBudget, AIBudgetError } from '../../lib/ai-usage.js';

let dir;
const saved = {};
const KEYS = ['YOURTUBE_AI_USAGE_LOG', 'YOURTUBE_AI_DAILY_BUDGET_USD', 'YOURTUBE_AI_MONTHLY_BUDGET_USD', 'YOURTUBE_AI_KILL_FILE'];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yt-budget-'));
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.YOURTUBE_AI_USAGE_LOG = join(dir, 'ai-usage.jsonl');
});

afterEach(async () => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(dir, { recursive: true, force: true });
});

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function logSpend(day, cost) {
  await appendFile(process.env.YOURTUBE_AI_USAGE_LOG, JSON.stringify({ day, cost_usd: cost, status: 'success' }) + '\n');
}

const fakeCall = (cost) => async () => ({ stdout: JSON.stringify({ result: 'ok', total_cost_usd: cost }), stderr: '' });

test('no caps set: calls go through', async () => {
  const out = await withClaudeUsageLog({ component: 't', operation: 'x', model: 'haiku', prompt: 'p' }, fakeCall(1));
  assert.match(out.stdout, /ok/);
});

test('daily cap blocks calls once today\'s spend reaches it', async () => {
  process.env.YOURTUBE_AI_DAILY_BUDGET_USD = '2';
  await logSpend(localDay(), 1.5);
  await logSpend('2001-01-01', 100); // old days don't count
  await withClaudeUsageLog({ component: 't', operation: 'x', model: 'haiku', prompt: 'p' }, fakeCall(0.6));
  // Now at 2.1 >= 2
  let called = false;
  await assert.rejects(
    withClaudeUsageLog({ component: 't', operation: 'x', model: 'haiku', prompt: 'p' }, async () => { called = true; return { stdout: '{}' }; }),
    err => err instanceof AIBudgetError && err.code === 'AI_BUDGET_EXCEEDED' && /daily/.test(err.message),
  );
  assert.equal(called, false, 'Claude must not be called once over budget');
});

test('monthly cap counts every day this month', async () => {
  process.env.YOURTUBE_AI_MONTHLY_BUDGET_USD = '10';
  const now = new Date();
  const firstOfMonth = localDay(new Date(now.getFullYear(), now.getMonth(), 1));
  await logSpend(firstOfMonth, 6);
  await logSpend(localDay(now), 4);
  await assert.rejects(checkAIBudget(), err => err.code === 'AI_BUDGET_EXCEEDED' && /monthly/.test(err.message));
});

test('kill file stops all calls', async () => {
  const kill = join(dir, 'AI_DISABLED');
  process.env.YOURTUBE_AI_KILL_FILE = kill;
  await checkAIBudget(); // fine without the file
  await writeFile(kill, 'stop\n');
  await assert.rejects(checkAIBudget(), err => err.code === 'AI_BUDGET_EXCEEDED' && /kill/i.test(err.message));
});

test('spend summary file is written after each call when configured', async () => {
  const summaryPath = join(dir, 'summary.json');
  process.env.YOURTUBE_AI_SUMMARY_FILE = summaryPath;
  process.env.YOURTUBE_AI_DAILY_BUDGET_USD = '5';
  try {
    await withClaudeUsageLog({ component: 't', operation: 'x', model: 'haiku', prompt: 'p' }, fakeCall(0.25));
    const { readFile } = await import('node:fs/promises');
    const s = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(s.today_usd, 0.25);
    assert.equal(s.daily_cap_usd, 5);
    assert.ok(s.kill_file.endsWith('AI_DISABLED'));
  } finally {
    delete process.env.YOURTUBE_AI_SUMMARY_FILE;
  }
});

test('default kill file sits next to the usage log', async () => {
  await writeFile(join(dir, 'AI_DISABLED'), '');
  await assert.rejects(checkAIBudget(), err => err.code === 'AI_BUDGET_EXCEEDED');
});
