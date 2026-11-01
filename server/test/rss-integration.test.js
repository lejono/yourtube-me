/**
 * Integration tests for POST /api/kids with interests triggering RSS fetch.
 *
 * Verifies that creating a kid with interests auto-suggests channels and
 * the fire-and-forget RSS fetch inserts videos into the DB.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set env vars before importing server or rss-fetch
const tmpDir = mkdtempSync(join(tmpdir(), 'yourtube-rss-integ-test-'));
process.env.YOURTUBE_DB_PATH = join(tmpDir, 'test.db');
process.env.YOURTUBE_SESSION_SECRET = 'test-session-secret-rss-integ';
process.env.YOURTUBE_WORKER_MASTER_KEY = 'test-worker-key-rss-integ';
process.env.PORT = '0';

import { startServer, stopServer } from '../server.js';
import { _setFetchForTesting } from '../lib/rss-fetch.js';
import { getDb } from '../lib/db.js';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <yt:videoId>rss_vid_001</yt:videoId>
    <title>Curated Video One</title>
    <published>2024-03-10T12:00:00+00:00</published>
    <author><name>Curated Channel</name></author>
    <media:thumbnail url="https://i.ytimg.com/vi/rss_vid_001/mqdefault.jpg"/>
  </entry>
</feed>`;

let baseUrl;
let serverInstance;

before(async () => {
  serverInstance = await startServer();
  const addr = serverInstance.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setFetchForTesting(null);
  await stopServer(serverInstance);
  rmSync(tmpDir, { recursive: true });
});

async function req(method, path, { body, cookies = '' } = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body: json ?? text };
}

function extractCookie(header, name) {
  if (!header) return null;
  const parts = (Array.isArray(header) ? header.join('; ') : header).split(',');
  for (const part of parts) {
    const nameVal = part.trim().split(';')[0].trim();
    if (nameVal.startsWith(name + '=')) return nameVal;
  }
  return null;
}

test('POST /api/kids with interests triggers RSS fetch and populates videos', async () => {
  // Stub RSS fetch — track fetched channel IDs, return a known video for each
  const fetchedChannelIds = [];
  _setFetchForTesting(async (url) => {
    const m = url.match(/channel_id=([^&]+)/);
    if (m) fetchedChannelIds.push(m[1]);
    return {
      ok: true,
      text: async () => SAMPLE_RSS,
    };
  });

  // Sign up + get session
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'rss-integ@example.com', password: 'testpass' },
  });
  assert.equal(signupRes.status, 201);
  const sessionCookie = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  // Create kid with interests + age (triggers curated channel auto-suggest)
  const createRes = await req('POST', '/api/kids', {
    body: { name: 'GamerKid', age: 10, interests: ['gaming'] },
    cookies: sessionCookie,
  });
  assert.equal(createRes.status, 201);
  const kidId = createRes.body.id;
  assert.ok(kidId);
  assert.equal(createRes.body.channels_status, 'ready');

  // Give the fire-and-forget a moment to complete
  await new Promise(r => setTimeout(r, 150));

  // Verify fetch was called for at least one channel
  assert.ok(fetchedChannelIds.length > 0, 'RSS fetch should have been called for at least one channel');

  // Check the DB for RSS-fetched videos (not hand-picked curated ones)
  const db = getDb(process.env.YOURTUBE_DB_PATH);
  const rssVideos = db.prepare(
    "SELECT * FROM videos WHERE kid_id = ? AND ai_reason != 'Hand-picked'"
  ).all(kidId);
  assert.ok(rssVideos.length > 0, 'should have inserted at least one RSS video');

  // RSS-fetched videos should await worker review
  for (const v of rssVideos) {
    assert.equal(v.ai_approved, 0, 'RSS videos should await worker review');
    assert.equal(v.ai_reason, 'Awaiting review');
  }
});

test('POST /api/kids without interests does not trigger RSS fetch', async () => {
  let fetchCalled = false;
  _setFetchForTesting(async () => {
    fetchCalled = true;
    return { ok: true, text: async () => '<feed></feed>' };
  });

  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'no-interests@example.com', password: 'testpass' },
  });
  const sessionCookie = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  const createRes = await req('POST', '/api/kids', {
    body: { name: 'NoInterestKid' },
    cookies: sessionCookie,
  });
  assert.equal(createRes.status, 201);

  await new Promise(r => setTimeout(r, 50));
  assert.equal(fetchCalled, false, 'should not call fetch when no interests provided');
});
