/**
 * Aggregate stats: daily counts, referrer domains, donate clicks, key-protected endpoint.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'yourtube-stats-test-'));
process.env.YOURTUBE_DB_PATH = join(tmpDir, 'test.db');
process.env.YOURTUBE_SESSION_SECRET = 'test-stats-secret';
process.env.YOURTUBE_WORKER_MASTER_KEY = 'test-worker-master-key';
process.env.YOURTUBE_STATS_KEY = 'stats-key-for-tests';
process.env.YOURTUBE_DONATE_URL = 'https://ko-fi.com/example';
process.env.PORT = '0';

const { startServer, stopServer } = await import('../server.js');

let baseUrl;
let serverInstance;
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

before(async () => {
  serverInstance = await startServer();
  baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
});

after(async () => {
  await stopServer(serverInstance);
  rmSync(tmpDir, { recursive: true });
});

async function get(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'User-Agent': BROWSER, ...headers }, redirect: 'manual' });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, headers: res.headers, body };
}

const stats = () => get('/api/stats', { 'X-Stats-Key': 'stats-key-for-tests' });

test('stats endpoint is hidden without the key', async () => {
  assert.equal((await get('/api/stats')).status, 404);
  assert.equal((await get('/api/stats', { 'X-Stats-Key': 'wrong' })).status, 404);
  assert.equal((await stats()).status, 200);
});

test('landing views are counted with the referrer domain only', async () => {
  await get('/', { Referer: 'https://news.ycombinator.com/item?id=123' });
  await get('/', { Referer: 'https://news.ycombinator.com/item?id=456' });
  await get('/', { Referer: 'https://yourtube.me/admin' });   // internal: no ref key
  await get('/');                                               // direct
  const s = (await stats()).body;
  const today = Object.values(s.days).at(-1);
  assert.equal(today['view:landing'], 4);
  assert.equal(today['ref:news.ycombinator.com'], 2);
  assert.equal(Object.keys(today).some(k => k.includes('yourtube.me')), false);
  assert.equal(Object.keys(today).some(k => k.includes('item?id')), false);
});

test('bots and scripts are not counted', async () => {
  const before = Object.values((await stats()).body.days).at(-1)['view:landing'];
  await get('/', { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
  await get('/', { 'User-Agent': 'curl/8.5.0' });
  const after = Object.values((await stats()).body.days).at(-1)['view:landing'];
  assert.equal(after, before);
});

test('/go/donate counts a click and redirects to the donate page', async () => {
  const r = await get('/go/donate', { Referer: 'https://yourtube.me/' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://ko-fi.com/example');
  const today = Object.values((await stats()).body.days).at(-1);
  assert.equal(today['click:donate'], 1);
});

test('signups and waitlist joins are counted and listed for the operator', async () => {
  const su = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER },
    body: JSON.stringify({ email: 'new.parent@example.com', password: 'long-enough-pw' }),
  });
  assert.equal(su.status, 201);
  await fetch(`${baseUrl}/api/waitlist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER },
    body: JSON.stringify({ email: 'later@example.com' }),
  });
  const s = (await stats()).body;
  const today = Object.values(s.days).at(-1);
  assert.equal(today.signup, 1);
  assert.equal(today.waitlist, 1);
  assert.equal(s.families_total, 1);
  assert.ok(s.recent_signups.some(f => f.email === 'new.parent@example.com'));
  assert.equal(s.waitlist_total, 1);
});

test('referrer keys per day are capped so junk referrers cannot bloat the table', async () => {
  for (let i = 0; i < 230; i++) {
    await get('/', { Referer: `https://spam${i}.example.net/` });
  }
  const today = Object.values((await stats()).body.days).at(-1);
  const refKeys = Object.keys(today).filter(k => k.startsWith('ref:'));
  assert.ok(refKeys.length <= 201, `got ${refKeys.length}`);
  assert.ok(today['ref:other'] > 0);
});
