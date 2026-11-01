#!/usr/bin/env node
/**
 * Print Claude spend (CLI's API-price estimate) for today and this month,
 * by model, plus cap and kill-switch status.
 *
 *   node worker/scripts/ai-usage-report.js            # human readable
 *   node worker/scripts/ai-usage-report.js --json     # for scripts/alerts
 */
import { access } from 'node:fs/promises';
import { getAIUsageLogPath, getKillFilePath, getSpend, readUsageSummary } from '../../lib/ai-usage.js';

const now = new Date();
const spend = await getSpend(now);
let summary = {};
try { summary = await readUsageSummary(); } catch { /* no log yet */ }
let killed = false;
try { await access(getKillFilePath()); killed = true; } catch { /* not killed */ }

const today = summary[spend.today];
const report = {
  log: getAIUsageLogPath(),
  today: spend.today,
  today_usd: Number(spend.day.toFixed(4)),
  month: spend.month,
  month_usd: Number(spend.monthTotal.toFixed(4)),
  daily_cap_usd: process.env.YOURTUBE_AI_DAILY_BUDGET_USD || null,
  monthly_cap_usd: process.env.YOURTUBE_AI_MONTHLY_BUDGET_USD || null,
  kill_file: getKillFilePath(),
  killed,
  today_by_model: Object.fromEntries(Object.entries(today?.models || {}).map(([m, b]) => [m, { calls: b.calls, failures: b.failures, usd: Number(b.cost_usd.toFixed(4)) }])),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report));
} else {
  console.log(`Today ${report.today}: $${report.today_usd.toFixed(2)} (cap ${report.daily_cap_usd ?? 'none'})`);
  console.log(`Month ${report.month}: $${report.month_usd.toFixed(2)} (cap ${report.monthly_cap_usd ?? 'none'})`);
  for (const [m, b] of Object.entries(report.today_by_model)) {
    console.log(`  ${m}: ${b.calls} calls, ${b.failures} failed, $${b.usd.toFixed(2)}`);
  }
  console.log(killed ? `KILL SWITCH ON (${report.kill_file})` : `Kill switch off. To stop all calls: touch ${report.kill_file}`);
}
