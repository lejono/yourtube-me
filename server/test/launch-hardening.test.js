import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = mkdtempSync(join(tmpdir(), 'yourtube-hardening-test-'));
const dbPath = join(tmpDir, 'test.db');
process.env.YOURTUBE_DB_PATH = dbPath;
process.env.YOURTUBE_SESSION_SECRET = 'test-session-secret-hardening';
process.env.YOURTUBE_WORKER_MASTER_KEY = 'test-worker-master-key';
process.env.PORT = '0';

const { startServer, stopServer } = await import('../server.js');

let baseUrl;
let serverInstance;

before(async () => {
  serverInstance = await startServer();
  baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
});

after(async () => {
  await stopServer(serverInstance);
  rmSync(tmpDir, { recursive: true });
});

async function req(method, path, { body, cookies = '' } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body: json ?? text };
}

async function signup(email) {
  const res = await req('POST', '/api/auth/signup', { body: { email, password: 'pw-123456' } });
  const setCookie = res.headers.get('set-cookie') || '';
  return { res, cookie: setCookie.split(';')[0] };
}

// --- Ownership guard on /api/kids/:id/* ---

test('a parent cannot read or change another family\'s kid', async () => {
  const a = await signup('owner-a@example.com');
  const b = await signup('intruder-b@example.com');
  assert.equal(a.res.status, 201);
  assert.equal(b.res.status, 201);

  const kid = await req('POST', '/api/kids', { cookies: a.cookie, body: { name: 'Kid A', age: 9 } });
  assert.equal(kid.status, 201);
  const kidId = kid.body.id;

  // Owner can see it
  assert.equal((await req('GET', `/api/kids/${kidId}/channels`, { cookies: a.cookie })).status, 200);
  assert.equal((await req('GET', `/api/kids/${kidId}/feed-preview`, { cookies: a.cookie })).status, 200);

  // Intruder gets 404 everywhere
  const probes = [
    ['GET', `/api/kids/${kidId}/channels`],
    ['GET', `/api/kids/${kidId}/feed-preview`],
    ['GET', `/api/kids/${kidId}/suggestions`],
    ['GET', `/api/kids/${kidId}/recent-videos`],
    ['POST', `/api/kids/${kidId}/channels/UCxxxxxxxxxxxxxxxxxxxxxx/approve`],
    ['POST', `/api/kids/${kidId}/channels/UCxxxxxxxxxxxxxxxxxxxxxx/unapprove`],
    ['DELETE', `/api/kids/${kidId}/channels/UCxxxxxxxxxxxxxxxxxxxxxx`],
    ['POST', `/api/kids/${kidId}/rate`],
    ['PATCH', `/api/kids/${kidId}`],
    ['DELETE', `/api/kids/${kidId}`],
    ['POST', `/api/kids/${kidId}/regenerate-token`],
    ['POST', `/api/kids/${kidId}/revoke`],
  ];
  for (const [method, path] of probes) {
    const r = await req(method, path, { cookies: b.cookie, body: method === 'GET' ? undefined : { video_id: 'v', rating: 1, name: 'x' } });
    assert.equal(r.status, 404, `${method} ${path} should be 404 for another family, got ${r.status}`);
  }

  // Unauthenticated still 401
  assert.equal((await req('GET', `/api/kids/${kidId}/channels`)).status, 401);

  // Kid still exists for its owner
  assert.equal((await req('GET', `/api/kids/${kidId}/channels`, { cookies: a.cookie })).status, 200);
});

// --- Signup cap + waitlist ---

test('signup cap: no limit when YOURTUBE_SIGNUP_SLOTS is unset', async () => {
  delete process.env.YOURTUBE_SIGNUP_SLOTS;
  delete process.env.YOURTUBE_SIGNUP_SLOTS_SINCE;
  const { res } = await signup('unlimited@example.com');
  assert.equal(res.status, 201);
});

test('signup cap: only N new families after the start time, then waitlist', async () => {
  const db = new Database(dbPath);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM families').get().n;
  db.close();
  assert.ok(existing > 0);

  // Start the window in the future relative to existing rows by counting from now
  const since = new Date(Date.now() - 1000).toISOString().replace('T', ' ').slice(0, 19);
  // Backdate existing families so they fall outside the window
  const db2 = new Database(dbPath);
  db2.prepare("UPDATE families SET created_at = '2020-01-01 00:00:00'").run();
  db2.close();

  process.env.YOURTUBE_SIGNUP_SLOTS = '2';
  process.env.YOURTUBE_SIGNUP_SLOTS_SINCE = since;
  try {
    assert.equal((await signup('slot1@example.com')).res.status, 201);
    assert.equal((await signup('slot2@example.com')).res.status, 201);

    const full = await signup('Late.Comer@example.com');
    assert.equal(full.res.status, 403);
    assert.equal(full.res.body.waitlisted, true);
    assert.match(full.res.body.error, /full/i);
    assert.equal(full.cookie, '', 'no session cookie when waitlisted');

    // Signing up twice while full does not error
    assert.equal((await signup('late.comer@example.com')).res.status, 403);

    const db3 = new Database(dbPath);
    const rows = db3.prepare('SELECT email FROM waitlist').all();
    const fam = db3.prepare("SELECT COUNT(*) AS n FROM families WHERE email LIKE '%comer%'").get().n;
    db3.close();
    assert.deepEqual(rows.map(r => r.email), ['late.comer@example.com']);
    assert.equal(fam, 0);

    // Existing parents can still log in
    const login = await req('POST', '/api/auth/login', { body: { email: 'slot1@example.com', password: 'pw-123456' } });
    assert.equal(login.status, 200);
  } finally {
    delete process.env.YOURTUBE_SIGNUP_SLOTS;
    delete process.env.YOURTUBE_SIGNUP_SLOTS_SINCE;
  }
});

test('signup cap: public status endpoint reports whether signups are open', async () => {
  process.env.YOURTUBE_SIGNUP_SLOTS = '0';
  process.env.YOURTUBE_SIGNUP_SLOTS_SINCE = '2020-01-01 00:00:00';
  try {
    const r = await req('GET', '/api/auth/signup-status');
    assert.equal(r.status, 200);
    assert.equal(r.body.open, false);
  } finally {
    delete process.env.YOURTUBE_SIGNUP_SLOTS;
    delete process.env.YOURTUBE_SIGNUP_SLOTS_SINCE;
  }
  const r2 = await req('GET', '/api/auth/signup-status');
  assert.equal(r2.body.open, true);
});

// --- HTTP hardening ---

test('request bodies over 64KB are refused', async () => {
  const big = 'x'.repeat(70 * 1024);
  const r = await req('POST', '/api/auth/login', { body: { email: big, password: 'x' } });
  assert.ok(r.status === 413 || r.status === 400, `got ${r.status}`);
  const r2 = await req('POST', '/setup', { body: { code: big } });
  assert.ok(r2.status === 413 || r2.status === 400, `got ${r2.status}`);
});

test('signup requires a password of at least 8 characters', async () => {
  const r = await req('POST', '/api/auth/signup', { body: { email: 'shortpw@example.com', password: 'abc' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /8/);
});

test('responses carry basic security headers', async () => {
  for (const path of ['/api/health', '/admin']) {
    const r = await req('GET', path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.ok(r.headers.get('referrer-policy'), path);
  }
});

test('rate limits: kid setup codes and login are throttled per IP when enabled', async () => {
  process.env.YOURTUBE_RATE_LIMIT = 'on';
  try {
    let last;
    for (let i = 0; i < 12; i++) {
      last = await req('POST', '/setup', { body: { code: `nope-nope-${i}` } });
    }
    assert.equal(last.status, 429);
    const g = await req('GET', '/setup/nope-nope-nope');
    assert.equal(g.status, 429);

    for (let i = 0; i < 12; i++) {
      last = await req('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-pass' } });
    }
    assert.equal(last.status, 429);
  } finally {
    process.env.YOURTUBE_RATE_LIMIT = 'off';
  }
  // Off again: no 429
  const ok = await req('POST', '/setup', { body: { code: 'nope-nope-x' } });
  assert.equal(ok.status, 404);
});

test('rate-limit keys group IPv6 by /64', async () => {
  const { ipKey } = await import('../lib/rate-limit.js');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
});
