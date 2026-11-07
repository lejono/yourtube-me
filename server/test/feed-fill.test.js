/**
 * Adding or approving a channel fetches its videos straight away, so the
 * feed starts filling without waiting for the worker. Also: the kid list
 * reports whether each child's device has been set up.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = mkdtempSync(join(tmpdir(), 'yourtube-feedfill-test-'));
const dbPath = join(tmpDir, 'test.db');
process.env.YOURTUBE_DB_PATH = dbPath;
process.env.YOURTUBE_SESSION_SECRET = 'test-feedfill-secret';
process.env.YOURTUBE_WORKER_MASTER_KEY = 'test-worker-master-key';
process.env.PORT = '0';

const { startServer, stopServer } = await import('../server.js');
const { _setFetchForTesting } = await import('../lib/rss-fetch.js');

let baseUrl;
let serverInstance;
const fetched = [];

function rss(channelId) {
  const ids = [1, 2, 3].map(i => `${channelId}-v${i}`);
  return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${
    ids.map(id => `<entry><yt:videoId>${id}</yt:videoId><title>T ${id}</title><published>2026-11-01T00:00:00+00:00</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/${id}/hq.jpg"/></media:group></entry>`).join('')
  }</feed>`;
}

before(async () => {
  _setFetchForTesting(async (url) => {
    const ch = new URL(url).searchParams.get('channel_id');
    fetched.push(ch);
    return { ok: true, text: async () => rss(ch) };
  });
  serverInstance = await startServer();
  baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
});

after(async () => {
  _setFetchForTesting(null);
  await stopServer(serverInstance);
  rmSync(tmpDir, { recursive: true });
});

async function call(method, path, { body, cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = text;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, body: json };
}

const videoCount = (kidId) => {
  const db = new Database(dbPath);
  const n = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE kid_id = ?').get(kidId).n;
  db.close();
  return n;
};

const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); }
  return fn();
};

let parent;
let kidId;

test('setup: parent and kid', async () => {
  const s = await call('POST', '/api/auth/signup', { body: { email: 'fill@example.com', password: 'long-enough-pw' } });
  parent = (s.headers.get('set-cookie') || '').split(';')[0];
  const k = await call('POST', '/api/kids', { cookie: parent, body: { name: 'K', age: 8 } });
  assert.equal(k.status, 201);
  kidId = k.body.id;
});

test('adding a channel by hand fetches its videos straight away', async () => {
  const chan = 'UCaaaaaaaaaaaaaaaaaaaaaa';
  const r = await call('POST', `/api/kids/${kidId}/channels`, { cookie: parent, body: { channel_id: chan, title: 'Manual' } });
  assert.equal(r.status, 201);
  assert.ok(await waitFor(() => videoCount(kidId) >= 3), 'videos inserted for the new channel');
  assert.ok(fetched.includes(chan));
});

test('approving a suggested channel fetches its videos straight away', async () => {
  const chan = 'UCbbbbbbbbbbbbbbbbbbbbbb';
  const db = new Database(dbPath);
  db.prepare("INSERT INTO channels (kid_id, channel_id, title, status) VALUES (?, ?, 'Suggested', 'pending')").run(kidId, chan);
  db.close();
  const before = videoCount(kidId);
  const r = await call('POST', `/api/kids/${kidId}/channels/${chan}/approve`, { cookie: parent });
  assert.equal(r.status, 200);
  assert.ok(await waitFor(() => videoCount(kidId) >= before + 3), 'videos inserted for the approved channel');
});

test('kid list says whether the device has been set up', async () => {
  let list = await call('GET', '/api/kids', { cookie: parent });
  assert.equal(list.body[0].device_setup, false);
  const kid = await call('GET', '/api/kids', { cookie: parent });
  const code = kid.body[0].setup_token;
  assert.equal((await call('POST', '/setup', { body: { code } })).status, 200);
  list = await call('GET', '/api/kids', { cookie: parent });
  assert.equal(list.body[0].device_setup, true);
});
