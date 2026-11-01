/**
 * End-to-end integration test for YourTube.
 * Runs the full pipeline: parent signup -> kid creation -> setup link -> cookie -> worker push -> filtered feed.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set env BEFORE importing the server
const tmpDir = mkdtempSync(join(tmpdir(), 'yt-e2e-'));
process.env.YOURTUBE_DB_PATH = join(tmpDir, 'test.sqlite');
process.env.YOURTUBE_SESSION_SECRET = 'e2e-secret';
process.env.YOURTUBE_WORKER_MASTER_KEY = 'e2e-worker-key';
process.env.PORT = '0';

import { startServer, stopServer } from '../server/server.js';

let server;
let baseUrl;

// Shared state across test steps
let parentCookie;
let kidId;
let setupToken;
let kidCookie;

before(async () => {
  server = await startServer();
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await stopServer(server);
  rmSync(tmpDir, { recursive: true });
});

test('1. parent signs up (POST /api/auth/signup -> 201 with family_id)', async () => {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'parent@example.com', password: 'hunter2' }),
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.family_id, 'response should include family_id');

  // Capture the session cookie for subsequent parent requests
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'signup should set a session cookie');
  parentCookie = setCookie.split(';')[0]; // e.g. "yt_session=..."
});

test('2. parent adds kid (POST /api/kids -> 201 with setup_token)', async () => {
  const res = await fetch(`${baseUrl}/api/kids`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': parentCookie,
    },
    body: JSON.stringify({ name: 'Alice', age: 8, guidelines: 'No scary stuff' }),
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id, 'response should include kid id');
  assert.ok(body.setup_token, 'response should include setup_token');

  kidId = body.id;
  setupToken = body.setup_token;
});

test('3. kid opens setup link (GET /setup/:token -> 302, yt_kid cookie set)', async () => {
  const res = await fetch(`${baseUrl}/setup/${setupToken}`, {
    redirect: 'manual', // do not follow the redirect; capture 302 directly
  });

  assert.equal(res.status, 302);

  const location = res.headers.get('location');
  assert.equal(location, '/');

  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'setup link should set a yt_kid cookie');
  assert.ok(setCookie.includes('yt_kid='), 'cookie should be named yt_kid');

  kidCookie = setCookie.split(';')[0]; // e.g. "yt_kid=..."
});

test('4. worker pushes videos (POST /api/worker/push -> 200)', async () => {
  const videos = [
    {
      video_id: 'vid-approved-1',
      title: 'Cool Science Video',
      channel_id: 'ch-science',
      channel_title: 'Science For Kids',
      published_at: '2024-01-01T00:00:00Z',
      thumbnail: null,
      ai_approved: 1,
      ai_reason: 'Educational and age appropriate',
    },
    {
      video_id: 'vid-approved-2',
      title: 'Fun Craft Tutorial',
      channel_id: 'ch-crafts',
      channel_title: 'Crafts With Kids',
      published_at: '2024-01-02T00:00:00Z',
      thumbnail: null,
      ai_approved: 1,
      ai_reason: 'Creative and suitable',
    },
    {
      video_id: 'vid-rejected-1',
      title: 'Scary Horror Compilation',
      channel_id: 'ch-horror',
      channel_title: 'Horror Channel',
      published_at: '2024-01-03T00:00:00Z',
      thumbnail: null,
      ai_approved: 0,
      ai_reason: 'Contains scary content',
    },
  ];

  const res = await fetch(`${baseUrl}/api/worker/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-key': 'e2e-worker-key',
    },
    body: JSON.stringify({ kid_id: kidId, videos }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 3);
});

test('5. kid feed returns only approved videos (GET /api/feed with yt_kid cookie -> 200)', async () => {
  const res = await fetch(`${baseUrl}/api/feed`, {
    headers: { 'Cookie': kidCookie },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.videos), 'feed should have a videos array');
  assert.equal(body.videos.length, 2, 'feed should return only the 2 approved videos');

  const videoIds = body.videos.map(v => v.video_id);
  assert.ok(videoIds.includes('vid-approved-1'), 'approved video 1 should be in feed');
  assert.ok(videoIds.includes('vid-approved-2'), 'approved video 2 should be in feed');
  assert.ok(!videoIds.includes('vid-rejected-1'), 'rejected video should not be in feed');
});

test('6. kid SPA loads at / (GET -> 200, HTML contains "YourTube")', async () => {
  const res = await fetch(`${baseUrl}/`);

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('YourTube'), 'SPA HTML should contain "YourTube"');
});

test('7. feed without cookie returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/feed`);

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error, 'response should include an error message');
});
