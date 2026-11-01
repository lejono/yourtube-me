import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_USAGE_LOG = join(__dirname, '..', 'logs', 'ai-usage.jsonl');

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = asNumber(obj[key]);
    if (value != null) return value;
  }
  return null;
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key];
  }
  return null;
}

function parseEnvelope(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function localDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeUsage(usage) {
  const input_tokens = pickNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const output_tokens = pickNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const cache_creation_input_tokens = pickNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);
  const cache_read_input_tokens = pickNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens']);

  let total_tokens = pickNumber(usage, ['total_tokens', 'totalTokens']);
  if (total_tokens == null) {
    const parts = [input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens]
      .filter(v => v != null);
    total_tokens = parts.length ? parts.reduce((sum, v) => sum + v, 0) : null;
  }

  return {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    total_tokens,
  };
}

function errorInfo(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || null,
    signal: error.signal || null,
  };
}

export function getAIUsageLogPath() {
  return process.env.YOURTUBE_AI_USAGE_LOG || DEFAULT_USAGE_LOG;
}

export function buildClaudeUsageRecord({
  component,
  operation,
  model,
  prompt,
  stdout,
  stderr,
  error,
  startedAt,
  finishedAt = new Date(),
  metadata = {},
}) {
  const finished = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt ?? finished);
  const envelope = parseEnvelope(stdout);
  const usage = envelope?.usage && typeof envelope.usage === 'object' ? envelope.usage : null;
  const tokens = normalizeUsage(usage);

  return {
    schema_version: 1,
    timestamp: finished.toISOString(),
    day: localDay(finished),
    component,
    operation,
    model,
    actual_model: pickString(envelope, ['model', 'model_name', 'actual_model']),
    status: error ? 'failure' : 'success',
    error: errorInfo(error),
    duration_ms: Math.max(0, finished.getTime() - started.getTime()),
    prompt_chars: typeof prompt === 'string' ? prompt.length : null,
    stdout_chars: typeof stdout === 'string' ? stdout.length : 0,
    stderr_chars: typeof stderr === 'string' ? stderr.length : 0,
    cost_usd: pickNumber(envelope, ['total_cost_usd', 'cost_usd', 'costUsd']),
    ...tokens,
    usage,
    metadata,
  };
}

export async function writeClaudeUsageRecord(record, { logPath = getAIUsageLogPath() } = {}) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * If YOURTUBE_AI_SUMMARY_FILE is set, write today's and this month's spend
 * there (atomically) so someone without access to the worker account can
 * monitor it.
 */
export async function writeSpendSummary(now = new Date()) {
  const target = process.env.YOURTUBE_AI_SUMMARY_FILE;
  if (!target) return;
  const spend = await getSpend(now);
  const summary = {
    updated_at: now.toISOString(),
    today: spend.today,
    today_usd: Number(spend.day.toFixed(4)),
    month: spend.month,
    month_usd: Number(spend.monthTotal.toFixed(4)),
    daily_cap_usd: budgetFromEnv('YOURTUBE_AI_DAILY_BUDGET_USD'),
    monthly_cap_usd: budgetFromEnv('YOURTUBE_AI_MONTHLY_BUDGET_USD'),
    kill_file: getKillFilePath(),
  };
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(summary, null, 2) + '\n', { mode: 0o644 });
  await rename(tmp, target);
}

export async function logClaudeUsage(args) {
  const record = buildClaudeUsageRecord(args);
  try {
    await writeClaudeUsageRecord(record);
  } catch (err) {
    console.warn('[ai-usage] Failed to write usage log:', err.message);
  }
  try {
    await writeSpendSummary();
  } catch (err) {
    console.warn('[ai-usage] Failed to write spend summary:', err.message);
  }
  return record;
}

// --- Spending cap + kill switch ---------------------------------------------
//
// YOURTUBE_AI_DAILY_BUDGET_USD / YOURTUBE_AI_MONTHLY_BUDGET_USD cap the summed
// cost_usd in the usage log (the CLI's own estimate at API prices). Unset = no
// cap. If the kill file exists (YOURTUBE_AI_KILL_FILE, default AI_DISABLED next
// to the usage log), every call is refused. Refused calls never reach Claude.

export class AIBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIBudgetError';
    this.code = 'AI_BUDGET_EXCEEDED';
  }
}

export function getKillFilePath() {
  return process.env.YOURTUBE_AI_KILL_FILE || join(dirname(getAIUsageLogPath()), 'AI_DISABLED');
}

function budgetFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function getSpend(now = new Date(), logPath = getAIUsageLogPath()) {
  const today = localDay(now);
  const month = today.slice(0, 7);
  let text = '';
  try { text = await readFile(logPath, 'utf8'); } catch { /* no log yet */ }
  let day = 0;
  let monthTotal = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(month)) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const cost = typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd) ? r.cost_usd : 0;
    const d = r.day || String(r.timestamp || '').slice(0, 10);
    if (d.startsWith(month)) monthTotal += cost;
    if (d === today) day += cost;
  }
  return { today, day, month, monthTotal };
}

let lastBudgetWarning = '';

export async function checkAIBudget(now = new Date()) {
  const killFile = getKillFilePath();
  try {
    await access(killFile);
    throw new AIBudgetError(`AI calls disabled by kill file ${killFile}`);
  } catch (err) {
    if (err instanceof AIBudgetError) throw err;
  }

  const daily = budgetFromEnv('YOURTUBE_AI_DAILY_BUDGET_USD');
  const monthly = budgetFromEnv('YOURTUBE_AI_MONTHLY_BUDGET_USD');
  if (daily == null && monthly == null) return;

  const spend = await getSpend(now);
  let reason = null;
  if (daily != null && spend.day >= daily) {
    reason = `daily AI budget reached: $${spend.day.toFixed(2)} of $${daily} on ${spend.today}`;
  } else if (monthly != null && spend.monthTotal >= monthly) {
    reason = `monthly AI budget reached: $${spend.monthTotal.toFixed(2)} of $${monthly} in ${spend.month}`;
  }
  if (reason) {
    if (lastBudgetWarning !== reason.split(':')[0] + spend.today) {
      lastBudgetWarning = reason.split(':')[0] + spend.today;
      console.error(`[ai-usage] STOPPED: ${reason}`);
    }
    throw new AIBudgetError(reason);
  }
}

export async function withClaudeUsageLog(context, fn) {
  await checkAIBudget();
  const startedAt = new Date();
  try {
    const output = await fn();
    const stdout = typeof output === 'string' ? output : output?.stdout;
    const stderr = typeof output === 'string' ? '' : output?.stderr;
    await logClaudeUsage({ ...context, stdout, stderr, startedAt });
    return output;
  } catch (error) {
    await logClaudeUsage({
      ...context,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error,
      startedAt,
    });
    throw error;
  }
}

export function parseUsageLogText(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function emptySummaryBucket() {
  return {
    calls: 0,
    successes: 0,
    failures: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

function addToBucket(bucket, record) {
  bucket.calls += 1;
  if (record.status === 'failure') bucket.failures += 1;
  else bucket.successes += 1;

  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'total_tokens',
    'cost_usd',
  ]) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) {
      bucket[key] += record[key];
    }
  }
}

export function summarizeUsageRecords(records) {
  const summary = {};
  for (const record of records) {
    const day = record.day || String(record.timestamp || '').slice(0, 10) || 'unknown';
    const model = record.actual_model || record.model || 'unknown';
    if (!summary[day]) {
      summary[day] = { total: emptySummaryBucket(), models: {}, operations: {} };
    }

    if (!summary[day].models[model]) summary[day].models[model] = emptySummaryBucket();

    const operation = [record.component, record.operation].filter(Boolean).join('.') || 'unknown';
    if (!summary[day].operations[operation]) summary[day].operations[operation] = emptySummaryBucket();

    addToBucket(summary[day].total, record);
    addToBucket(summary[day].models[model], record);
    addToBucket(summary[day].operations[operation], record);
  }
  return summary;
}

export async function readUsageSummary(logPath = getAIUsageLogPath()) {
  const text = await readFile(logPath, 'utf8');
  return summarizeUsageRecords(parseUsageLogText(text));
}
