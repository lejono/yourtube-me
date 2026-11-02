/**
 * Operator dashboard: /api/ops (key-protected) and the /ops page.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = mkdtempSync(join(tmpdir(), 'yourtube-ops-test-'));
const dbPath = join(tmpDir, 'test.db');
process.env.YOURTUBE_DB_PATH = dbPath;
process.env.YOURTUBE_SESSION_SECRET = 'test-ops-secret';
process.env.YOURTUBE_WORKER_MASTER_KEY = 'test-worker-master-key';
process.env.YOURTUBE_STATS_KEY = 'stats-key-for-ops-tests';
process.env.PORT = '0';

const { startServer, stopServer } = await import('../server.js');

let baseUrl;
let serverInstance;
const UA = 'Mozilla/5.0 (Macintosh) Safari/605.1.15';
const KEY = { 'X-Stats-Key': 'stats-key-for-ops-tests' };

before(async () => {
  serverInstance = await startServer();
  baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
});

after(async () => {
  await stopServer(serverInstance);
  rmSync(tmpDir, { recursive: true });
});

async function call(method, path, { body, headers = {}, cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = text;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, headers: res.headers, body: json };
}

const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];

test('/api/ops is hidden without the key', async () => {
  assert.equal((await call('GET', '/api/ops')).status, 404);
  assert.equal((await call('GET', '/api/ops', { headers: { 'X-Stats-Key': 'nope' } })).status, 404);
});

test('/ops page is served, not indexed, and carries no data', async () => {
  const r = await call('GET', '/ops');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
  assert.match(r.body, /id="ops-key"/);
  assert.doesNotMatch(r.body, /@example\.com/);
});

test('full funnel: signup -> kid -> channels -> device -> watch -> like', async () => {
  // Family that does everything
  const a = await call('POST', '/api/auth/signup', { body: { email: 'active@example.com', password: 'long-enough-pw' } });
  const parent = cookieOf(a);
  const kid = await call('POST', '/api/kids', { cookie: parent, body: { name: 'SecretKidName', age: 9 } });
  assert.equal(kid.status, 201);
  const kidId = kid.body.id;

  // Kid device setup via 3-word code, then opens the feed
  const setup = await call('POST', '/setup', { body: { code: kid.body.setup_token } });
  assert.equal(setup.status, 200);
  const kidCookie = cookieOf(setup);
  assert.equal((await call('GET', '/api/feed', { cookie: kidCookie })).status, 200);

  // Channels, videos, a watch, a like, a parent rating (direct DB)
  const db = new Database(dbPath);
  db.prepare("INSERT INTO channels (kid_id, channel_id, title, status) VALUES (?, 'UC_A', 'A', 'approved')").run(kidId);
  db.prepare("INSERT INTO channels (kid_id, channel_id, title, status) VALUES (?, 'UC_B', 'B', 'rejected')").run(kidId);
  db.prepare("INSERT INTO channels (kid_id, channel_id, title, status) VALUES (?, 'UC_C', 'C', 'pending')").run(kidId);
  for (const v of ['v1', 'v2', 'v3']) {
    db.prepare("INSERT INTO videos (kid_id, video_id, title, channel_id, channel_title, ai_approved) VALUES (?, ?, 't', 'UC_A', 'A', 1)").run(kidId, v);
  }
  db.prepare("INSERT INTO videos (kid_id, video_id, title, channel_id, channel_title, ai_approved) VALUES (?, 'vx', 't', 'UC_A', 'A', 0)").run(kidId);
  db.prepare("INSERT INTO watches (kid_id, video_id) VALUES (?, 'v1')").run(kidId);
  db.prepare("INSERT INTO watches (kid_id, video_id) VALUES (?, 'v2')").run(kidId);
  db.prepare("INSERT INTO likes (kid_id, video_id) VALUES (?, 'v1')").run(kidId);
  db.prepare("INSERT INTO parent_ratings (kid_id, video_id, rating) VALUES (?, 'v3', -1)").run(kidId);
  db.close();

  // Family that signs up and stops
  await call('POST', '/api/auth/signup', { body: { email: 'idle@example.com', password: 'long-enough-pw' } });

  const r = await call('GET', '/api/ops', { headers: KEY });
  assert.equal(r.status, 200);
  const ops = r.body;

  // Never expose children's names
  assert.doesNotMatch(JSON.stringify(ops), /SecretKidName/);

  const active = ops.families.find(f => f.email === 'active@example.com');
  assert.ok(active);
  assert.equal(active.kids.length, 1);
  const k = active.kids[0];
  assert.equal(k.age, 9);
  assert.deepEqual(k.channels, { approved: 1, pending: 1, rejected: 1 });
  assert.equal(k.videos_available, 3);
  assert.equal(k.videos_blocked, 1);
  assert.equal(k.watched, 2);
  assert.equal(k.likes, 1);
  assert.equal(k.parent_down, 1);
  assert.ok(k.device_setup_at, 'device setup recorded');
  assert.ok(k.last_seen_at, 'last seen recorded');

  const idle = ops.families.find(f => f.email === 'idle@example.com');
  assert.equal(idle.kids.length, 0);

  // Funnel over all families
  const f = ops.funnel.all;
  assert.equal(f.families, 2);
  assert.equal(f.with_kid, 1);
  assert.equal(f.with_approved_channels, 1);
  assert.equal(f.device_set_up, 1);
  assert.equal(f.watched, 1);
  assert.equal(f.liked, 1);

  // Daily stats include signups and kid setups
  const today = Object.values(ops.days).at(-1);
  assert.equal(today.signup, 2);
  assert.equal(today.kid_setup, 1);
  assert.equal(today.kid_created, 1);
});
