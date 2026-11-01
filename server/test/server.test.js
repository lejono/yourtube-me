import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set env vars before importing server module
const tmpDir = mkdtempSync(join(tmpdir(), 'yourtube-server-test-'));
process.env.YOURTUBE_DB_PATH = join(tmpDir, 'test.db');
process.env.YOURTUBE_SESSION_SECRET = 'test-session-secret-for-integration-tests';
process.env.YOURTUBE_WORKER_MASTER_KEY = 'test-worker-master-key';
process.env.PORT = '0'; // random port

import { startServer, stopServer } from '../server.js';

let baseUrl;
let serverInstance;

before(async () => {
  serverInstance = await startServer();
  const addr = serverInstance.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await stopServer(serverInstance);
  rmSync(tmpDir, { recursive: true });
});

// Helper: make HTTP request, return { status, headers, body }
async function req(method, path, { body, headers = {}, cookies = '' } = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body: json ?? text };
}

// Extract a named cookie value from a Set-Cookie header string
function extractCookie(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  // Handle both single string and array
  const header = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    const nameVal = trimmed.split(';')[0].trim();
    if (nameVal.startsWith(`${name}=`)) {
      return nameVal; // returns "name=encodedValue"
    }
  }
  return null;
}

// --- Basic routes ---

test('GET / returns 200', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
});

test('GET /admin returns 200', async () => {
  const r = await req('GET', '/admin');
  assert.equal(r.status, 200);
});

test('GET /api/health returns 200 with ok:true', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

// --- Auth: signup ---

test('POST /api/auth/signup returns 201 with family_id', async () => {
  const r = await req('POST', '/api/auth/signup', {
    body: { email: 'signup@example.com', password: 'secret123' },
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.family_id, 'should have family_id');
});

test('POST /api/auth/signup sets a session cookie', async () => {
  const r = await req('POST', '/api/auth/signup', {
    body: { email: 'signup-cookie@example.com', password: 'secret123' },
  });
  assert.equal(r.status, 201);
  const setCookie = r.headers.get('set-cookie');
  assert.ok(setCookie, 'should set a cookie');
  assert.ok(setCookie.includes('yt_session'), 'should set yt_session cookie');
});

// --- Auth: login ---

test('POST /api/auth/login returns 200 with session cookie', async () => {
  // First sign up
  await req('POST', '/api/auth/signup', {
    body: { email: 'login-test@example.com', password: 'mypassword' },
  });
  // Then log in
  const r = await req('POST', '/api/auth/login', {
    body: { email: 'login-test@example.com', password: 'mypassword' },
  });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get('set-cookie');
  assert.ok(setCookie, 'should set a cookie on login');
  assert.ok(setCookie.includes('yt_session'));
});

test('POST /api/auth/login returns 401 for wrong password', async () => {
  await req('POST', '/api/auth/signup', {
    body: { email: 'wrong-pass@example.com', password: 'correct-horse' },
  });
  const r = await req('POST', '/api/auth/login', {
    body: { email: 'wrong-pass@example.com', password: 'wrong' },
  });
  assert.equal(r.status, 401);
});

// --- Auth: session ---

test('GET /api/auth/session returns authenticated for valid session cookie', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'session-check@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  assert.ok(cookieStr, 'should have session cookie');

  const r = await req('GET', '/api/auth/session', { cookies: cookieStr });
  assert.equal(r.status, 200);
  assert.equal(r.body.authenticated, true);
  assert.ok(r.body.family_id);
});

test('GET /api/auth/session returns not authenticated without cookie', async () => {
  const r = await req('GET', '/api/auth/session');
  assert.equal(r.status, 200);
  assert.equal(r.body.authenticated, false);
});

// --- Full integration flow: signup -> create kid -> push videos -> setup link -> feed ---

test('Full flow: signup, create kid, push videos, setup link, fetch feed', async () => {
  // 1. Sign up
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'fullflow@example.com', password: 'testpass' },
  });
  assert.equal(signupRes.status, 201);
  const familyId = signupRes.body.family_id;
  const sessionCookie = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  assert.ok(sessionCookie);

  // 2. Create a kid (parent auth required)
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'TestKid', age: 8 },
    cookies: sessionCookie,
  });
  assert.equal(createKidRes.status, 201);
  const kidId = createKidRes.body.id;
  const setupToken = createKidRes.body.setup_token;
  assert.ok(kidId);
  assert.ok(setupToken);

  // 3. Add a channel for the kid
  const addChannelRes = await req('POST', `/api/kids/${kidId}/channels`, {
    body: { channel_id: 'UC_test123', title: 'Test Channel' },
    cookies: sessionCookie,
  });
  assert.equal(addChannelRes.status, 201);

  // 4. Push videos via worker key
  const pushRes = await req('POST', '/api/worker/push', {
    body: {
      kid_id: kidId,
      videos: [
        {
          video_id: 'vid001',
          title: 'Awesome Video',
          channel_id: 'UC_test123',
          channel_title: 'Test Channel',
          published_at: '2024-01-01T00:00:00Z',
          thumbnail: 'https://img.youtube.com/vi/vid001/default.jpg',
          ai_approved: 1,
          ai_reason: 'Great content',
        },
      ],
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(pushRes.status, 200);

  // 5. Follow setup link - should get kid cookie and redirect
  const setupRes = await fetch(`${baseUrl}/setup/${setupToken}`, { redirect: 'manual' });
  assert.equal(setupRes.status, 302);
  const location = setupRes.headers.get('location');
  assert.ok(location === '/' || location === `${baseUrl}/`, `redirect to /`);
  const kidCookie = extractCookie(setupRes.headers.get('set-cookie'), 'yt_kid');
  assert.ok(kidCookie, 'setup link should set yt_kid cookie');

  // 6. Fetch feed with kid cookie
  const feedRes = await req('GET', '/api/feed', { cookies: kidCookie });
  assert.equal(feedRes.status, 200);
  assert.ok(Array.isArray(feedRes.body.videos), 'feed should have videos array');
  assert.equal(feedRes.body.videos.length, 1);
  assert.equal(feedRes.body.videos[0].video_id, 'vid001');
  assert.equal(feedRes.body.kid_name, 'TestKid');
});

// --- Kids API ---

test('POST /api/kids returns 201 with setup_token', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'create-kid@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  const r = await req('POST', '/api/kids', {
    body: { name: 'Alice', age: 9 },
    cookies: cookieStr,
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.id);
  assert.ok(r.body.setup_token);
  assert.equal(r.body.name, 'Alice');
});

test('POST /api/kids returns 401 without session', async () => {
  const r = await req('POST', '/api/kids', {
    body: { name: 'Bob', age: 7 },
  });
  assert.equal(r.status, 401);
});

test('GET /api/kids returns kid list for authenticated parent', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'list-kids@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  await req('POST', '/api/kids', { body: { name: 'Kid1' }, cookies: cookieStr });
  await req('POST', '/api/kids', { body: { name: 'Kid2' }, cookies: cookieStr });

  const r = await req('GET', '/api/kids', { cookies: cookieStr });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 2);
});

// --- Setup link ---

test('GET /setup/:token with invalid token returns 404', async () => {
  const r = await req('GET', '/setup/totally-invalid-token-xyz');
  assert.equal(r.status, 404);
});

// --- Feed API ---

test('GET /api/feed without cookie returns 404', async () => {
  const r = await req('GET', '/api/feed');
  assert.equal(r.status, 404);
});

// --- Worker push ---

test('POST /api/worker/push rejects bad key with 401', async () => {
  const r = await req('POST', '/api/worker/push', {
    body: { kid_id: 'x', videos: [] },
    headers: { 'X-Worker-Key': 'wrong-key' },
  });
  assert.equal(r.status, 401);
});

test('POST /api/worker/push rejects missing key with 401', async () => {
  const r = await req('POST', '/api/worker/push', {
    body: { kid_id: 'x', videos: [] },
  });
  assert.equal(r.status, 401);
});

test('GET /api/worker/manifest rejects bad key with 401', async () => {
  const r = await req('GET', '/api/worker/manifest', {
    headers: { 'X-Worker-Key': 'wrong-key' },
  });
  assert.equal(r.status, 401);
});

// --- Auth: logout ---

test('POST /api/auth/logout clears session', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'logout-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  // Verify session is valid
  const sessionRes = await req('GET', '/api/auth/session', { cookies: cookieStr });
  assert.equal(sessionRes.body.authenticated, true);

  // Log out
  const logoutRes = await req('POST', '/api/auth/logout', { cookies: cookieStr });
  assert.equal(logoutRes.status, 200);

  // Session should now be invalid
  const afterRes = await req('GET', '/api/auth/session', { cookies: cookieStr });
  assert.equal(afterRes.body.authenticated, false);
});

// --- Worker: kid status endpoint ---

test('POST /api/worker/kid/:id/status sets channels_status on kid', async () => {
  // Set up: create a family + kid
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'status-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'StatusKid', age: 8 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  // Set status to 'generating'
  const r = await req('POST', `/api/worker/kid/${kidId}/status`, {
    body: { status: 'generating' },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // Verify via manifest
  const manifestRes = await req('GET', '/api/worker/manifest', {
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  const kid = manifestRes.body.find(k => k.kid_id === kidId);
  assert.ok(kid, 'kid should be in manifest');
  assert.equal(kid.channels_status, 'generating');
});

test('POST /api/worker/kid/:id/status requires worker auth', async () => {
  const r = await req('POST', '/api/worker/kid/some-kid-id/status', {
    body: { status: 'generating' },
    headers: { 'X-Worker-Key': 'wrong-key' },
  });
  assert.equal(r.status, 401);
});

test('POST /api/worker/kid/:id/status rejects invalid status values', async () => {
  // Create a kid first
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'status-invalid@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'InvalidStatusKid', age: 8 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  const r = await req('POST', `/api/worker/kid/${kidId}/status`, {
    body: { status: 'not-a-valid-status' },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(r.status, 400);
});

// --- Worker: channels endpoint with status/reason fields ---

// --- Suggestions API ---

test('GET /api/kids/:id/suggestions returns pending channels', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'suggestions-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'SuggestKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  // Add a pending channel via worker endpoint
  await req('POST', '/api/worker/channels', {
    body: {
      kid_id: kidId,
      channel_id: 'UC_suggest_test',
      title: 'Suggested Channel',
      status: 'pending',
      reason: 'Matches interests',
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });

  const r = await req('GET', `/api/kids/${kidId}/suggestions`, { cookies: cookieStr });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.suggestions), 'should have suggestions array');
  assert.equal(r.body.suggestions.length, 1);
  assert.equal(r.body.suggestions[0].channel_id, 'UC_suggest_test');
  assert.equal(r.body.suggestions[0].status, 'pending');
});

test('GET /api/kids/:id/suggestions requires parent auth', async () => {
  const r = await req('GET', '/api/kids/some-kid/suggestions');
  assert.equal(r.status, 401);
});

test('POST /api/kids/:id/channels/:channelId/approve changes status to approved', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'approve-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'ApproveKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  // Add pending channel
  await req('POST', '/api/worker/channels', {
    body: {
      kid_id: kidId,
      channel_id: 'UC_approve_test',
      title: 'To Approve',
      status: 'pending',
      reason: 'Great content',
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });

  // Approve it
  const r = await req('POST', `/api/kids/${kidId}/channels/UC_approve_test/approve`, {
    cookies: cookieStr,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // Verify status changed
  const channelsRes = await req('GET', `/api/kids/${kidId}/channels`, { cookies: cookieStr });
  const ch = channelsRes.body.find(c => c.channel_id === 'UC_approve_test');
  assert.ok(ch, 'channel should exist');
  assert.equal(ch.status, 'approved');
});

test('POST /api/kids/:id/channels/:channelId/reject changes status to rejected', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'reject-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'RejectKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  await req('POST', '/api/worker/channels', {
    body: {
      kid_id: kidId,
      channel_id: 'UC_reject_test',
      title: 'To Reject',
      status: 'pending',
      reason: 'Might not be suitable',
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });

  const r = await req('POST', `/api/kids/${kidId}/channels/UC_reject_test/reject`, {
    cookies: cookieStr,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  const channelsRes = await req('GET', `/api/kids/${kidId}/channels`, { cookies: cookieStr });
  const ch = channelsRes.body.find(c => c.channel_id === 'UC_reject_test');
  assert.ok(ch, 'channel should exist');
  assert.equal(ch.status, 'rejected');
});

test('POST /api/kids/:id/channels/:channelId/unapprove changes approved channel to rejected', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'unapprove-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'UnapproveKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  // Add channel as approved (the normal curated-channel flow)
  await req('POST', '/api/worker/channels', {
    body: {
      kid_id: kidId,
      channel_id: 'UC_unapprove_test',
      title: 'Was Approved',
      status: 'approved',
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });

  // Push some videos for that channel
  await req('POST', '/api/worker/push', {
    body: {
      kid_id: kidId,
      videos: [
        { video_id: 'vid_unapp_1', title: 'Bad Video 1', channel_id: 'UC_unapprove_test', channel_title: 'Was Approved', published_at: '2026-01-01', ai_approved: 1 },
        { video_id: 'vid_unapp_2', title: 'Bad Video 2', channel_id: 'UC_unapprove_test', channel_title: 'Was Approved', published_at: '2026-01-02', ai_approved: 1 },
      ],
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });

  // Confirm it's approved
  const beforeRes = await req('GET', `/api/kids/${kidId}/channels`, { cookies: cookieStr });
  const before = beforeRes.body.find(c => c.channel_id === 'UC_unapprove_test');
  assert.equal(before.status, 'approved');

  // Unapprove it
  const r = await req('POST', `/api/kids/${kidId}/channels/UC_unapprove_test/unapprove`, {
    cookies: cookieStr,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // Verify status changed to rejected but channel record kept (prevents re-suggestion)
  const afterRes = await req('GET', `/api/kids/${kidId}/channels`, { cookies: cookieStr });
  const after = afterRes.body.find(c => c.channel_id === 'UC_unapprove_test');
  assert.ok(after, 'channel record should still exist (prevents re-suggestion)');
  assert.equal(after.status, 'rejected');

  // Re-approve to prove videos were actually deleted (not just hidden by channel filter)
  await req('POST', `/api/kids/${kidId}/channels/UC_unapprove_test/approve`, { cookies: cookieStr });
  const previewRes = await req('GET', `/api/kids/${kidId}/feed-preview`, { cookies: cookieStr });
  const allVideos = previewRes.body.videos ?? [];
  const channelVideos = allVideos.filter(v => v.channel_id === 'UC_unapprove_test');
  assert.equal(channelVideos.length, 0, 'videos should be deleted on unapprove, not just hidden');
});

// --- Feedback API ---

test('POST /api/kids/:id/feedback stores feedback and sets status to refining', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'feedback-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'FeedbackKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  const r = await req('POST', `/api/kids/${kidId}/feedback`, {
    body: { message: 'More educational, less gaming' },
    cookies: cookieStr,
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.id, 'should return feedback id');
  assert.equal(r.body.message, 'More educational, less gaming');

  // Verify channels_status is now 'refining'
  const manifestRes = await req('GET', '/api/worker/manifest', {
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  const kid = manifestRes.body.find(k => k.kid_id === kidId);
  assert.ok(kid, 'kid should be in manifest');
  assert.equal(kid.channels_status, 'refining');
});

test('POST /api/kids/:id/feedback requires parent auth', async () => {
  const r = await req('POST', '/api/kids/some-kid/feedback', {
    body: { message: 'test' },
  });
  assert.equal(r.status, 401);
});

test('POST /api/kids/:id/feedback requires message field', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'feedback-validation@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'FeedbackValidKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  const r = await req('POST', `/api/kids/${kidId}/feedback`, {
    body: {},
    cookies: cookieStr,
  });
  assert.equal(r.status, 400);
});

// --- Worker feedback endpoints ---

test('GET /api/worker/kid/:id/feedback returns unprocessed feedback', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'worker-feedback@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'WorkerFeedbackKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  // Add feedback via parent endpoint
  await req('POST', `/api/kids/${kidId}/feedback`, {
    body: { message: 'Less scary content' },
    cookies: cookieStr,
  });

  const r = await req('GET', `/api/worker/kid/${kidId}/feedback`, {
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.feedback));
  assert.equal(r.body.feedback.length, 1);
  assert.equal(r.body.feedback[0].message, 'Less scary content');
  assert.equal(r.body.feedback[0].processed, 0);
});

test('POST /api/worker/feedback/:id/processed marks feedback as processed', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'worker-processed@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'ProcessedKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  // Add feedback
  const feedbackRes = await req('POST', `/api/kids/${kidId}/feedback`, {
    body: { message: 'Add chess channels' },
    cookies: cookieStr,
  });
  const feedbackId = feedbackRes.body.id;

  // Mark as processed
  const r = await req('POST', `/api/worker/feedback/${feedbackId}/processed`, {
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // Verify it no longer shows as unprocessed
  const feedbackListRes = await req('GET', `/api/worker/kid/${kidId}/feedback`, {
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(feedbackListRes.body.feedback.length, 0);
});

test('GET /api/worker/kid/:id/channels returns all channels for worker', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'worker-channels@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'WorkerChansKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  await req('POST', `/api/kids/${kidId}/channels`, {
    body: { channel_id: 'UC_worker_ch_test', title: 'Worker Channel Test' },
    cookies: cookieStr,
  });

  const r = await req('GET', `/api/worker/kid/${kidId}/channels`, {
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.channels));
  assert.ok(r.body.channels.some(c => c.channel_id === 'UC_worker_ch_test'));
});

test('POST /api/worker/channels accepts status=pending and reason fields', async () => {
  // Create kid
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'pending-channel@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'PendingKid', age: 9 },
    cookies: cookieStr,
  });
  const kidId = createKidRes.body.id;

  const r = await req('POST', '/api/worker/channels', {
    body: {
      kid_id: kidId,
      channel_id: 'UC_pending_test',
      title: 'Pending Test Channel',
      status: 'pending',
      reason: 'Great science content for this age',
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });
  assert.equal(r.status, 201);

  // Verify channel appears as pending for the kid
  const channelsRes = await req('GET', `/api/kids/${kidId}/channels`, { cookies: cookieStr });
  assert.equal(channelsRes.status, 200);
  const ch = channelsRes.body.find(c => c.channel_id === 'UC_pending_test');
  assert.ok(ch, 'channel should exist');
  assert.equal(ch.status, 'pending');
  assert.equal(ch.reason, 'Great science content for this age');
});

// --- Auto-suggest from curated DB on kid creation ---

test('POST /api/kids with interests auto-generates pending suggestions from curated DB', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'auto-suggest@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  // Create a kid with interests that match the seeded curated DB
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'AutoSuggestKid', age: 10, interests: ['science', 'engineering'] },
    cookies: cookieStr,
  });
  assert.equal(createKidRes.status, 201);
  const kidId = createKidRes.body.id;

  // Suggestions should be available immediately (no worker needed)
  const suggestRes = await req('GET', `/api/kids/${kidId}/suggestions`, { cookies: cookieStr });
  assert.equal(suggestRes.status, 200);
  assert.ok(Array.isArray(suggestRes.body.suggestions), 'should have suggestions array');
  assert.ok(suggestRes.body.suggestions.length > 0, 'should have at least one suggestion from curated DB');
  // All suggestions should be pending
  for (const s of suggestRes.body.suggestions) {
    assert.equal(s.status, 'pending', 'all auto-suggestions should be pending');
  }
});

test('POST /api/kids with interests sets channels_status to ready immediately', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'auto-suggest-status@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'StatusAutoKid', age: 8, interests: ['gaming', 'minecraft'] },
    cookies: cookieStr,
  });
  assert.equal(createKidRes.status, 201);
  const kidId = createKidRes.body.id;

  // channels_status should be 'ready' so the UI shows suggestions immediately
  const kidsRes = await req('GET', '/api/kids', { cookies: cookieStr });
  const kid = kidsRes.body.find(k => k.id === kidId);
  assert.ok(kid, 'kid should exist');
  assert.equal(kid.channels_status, 'ready', 'channels_status should be ready after auto-suggestion');
});

test('POST /api/kids with interests AND guidelines sets channels_status to reviewing', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'guidelines-review@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'GuidelinesKid', age: 9, interests: ['science'], guidelines: 'No competitive content' },
    cookies: cookieStr,
  });
  assert.equal(createKidRes.status, 201);
  assert.equal(createKidRes.body.channels_status, 'reviewing');
});

test('POST /api/kids without interests does not auto-generate suggestions', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'no-interests@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'NoInterestsKid', age: 8 },
    cookies: cookieStr,
  });
  assert.equal(createKidRes.status, 201);
  const kidId = createKidRes.body.id;

  const suggestRes = await req('GET', `/api/kids/${kidId}/suggestions`, { cookies: cookieStr });
  assert.equal(suggestRes.status, 200);
  assert.equal(suggestRes.body.suggestions.length, 0, 'should have no suggestions without interests');

  // channels_status should remain idle
  const kidsRes = await req('GET', '/api/kids', { cookies: cookieStr });
  const kid = kidsRes.body.find(k => k.id === kidId);
  assert.equal(kid.channels_status, 'idle');
});

test('POST /api/kids auto-suggestion caps at 15 channels', async () => {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: 'cap-test@example.com', password: 'pass-word-123' },
  });
  const cookieStr = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');

  // Use many interests to maximise matches from the 133-channel seed DB
  const createKidRes = await req('POST', '/api/kids', {
    body: {
      name: 'CapTestKid',
      age: 10,
      interests: ['gaming', 'science', 'engineering', 'minecraft', 'animals', 'space', 'comedy', 'lego', 'sports'],
    },
    cookies: cookieStr,
  });
  assert.equal(createKidRes.status, 201);
  const kidId = createKidRes.body.id;

  const suggestRes = await req('GET', `/api/kids/${kidId}/suggestions`, { cookies: cookieStr });
  assert.equal(suggestRes.status, 200);
  assert.ok(suggestRes.body.suggestions.length <= 15, 'should not exceed 15 suggestions');
});

// --- Watch + Like + Search endpoints (kid-facing, yt_kid cookie) ---

// Helper: sets up a kid with a cookie, channel, and videos
async function setupKidWithVideos() {
  const signupRes = await req('POST', '/api/auth/signup', {
    body: { email: `kid-activity-${Math.random()}@example.com`, password: 'pass-word-123' },
  });
  const sessionCookie = extractCookie(signupRes.headers.get('set-cookie'), 'yt_session');
  const createKidRes = await req('POST', '/api/kids', {
    body: { name: 'ActivityKid', age: 10 },
    cookies: sessionCookie,
  });
  const kidId = createKidRes.body.id;
  const setupToken = createKidRes.body.setup_token;

  // Add channel and push videos
  await req('POST', `/api/kids/${kidId}/channels`, {
    body: { channel_id: 'UC_ACT', title: 'Activity Channel' },
    cookies: sessionCookie,
  });
  await req('POST', '/api/worker/push', {
    body: {
      kid_id: kidId,
      videos: [
        { video_id: 'act_v1', title: 'Parkour Tricks', channel_id: 'UC_ACT', channel_title: 'Activity Channel', published_at: '2024-06-01', thumbnail: null, ai_approved: 1, ai_reason: null },
        { video_id: 'act_v2', title: 'Minecraft Build', channel_id: 'UC_ACT', channel_title: 'Activity Channel', published_at: '2024-07-01', thumbnail: null, ai_approved: 1, ai_reason: null },
        { video_id: 'act_v3', title: 'Parkour World', channel_id: 'UC_ACT', channel_title: 'Activity Channel', published_at: '2024-08-01', thumbnail: null, ai_approved: 1, ai_reason: null },
      ],
    },
    headers: { 'X-Worker-Key': 'test-worker-master-key' },
  });

  // Get kid cookie via setup link
  const setupRes = await fetch(`${baseUrl}/setup/${setupToken}`, { redirect: 'manual' });
  const kidCookie = extractCookie(setupRes.headers.get('set-cookie'), 'yt_kid');

  return { kidId, kidCookie, sessionCookie };
}

// POST /api/watch

test('POST /api/watch records a watch and returns ok', async () => {
  const { kidCookie } = await setupKidWithVideos();

  const r = await req('POST', '/api/watch', {
    body: { video_id: 'act_v1' },
    cookies: kidCookie,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('POST /api/watch returns 404 without kid cookie', async () => {
  const r = await req('POST', '/api/watch', {
    body: { video_id: 'act_v1' },
  });
  assert.equal(r.status, 404);
});

test('POST /api/watch returns 400 without video_id', async () => {
  const { kidCookie } = await setupKidWithVideos();

  const r = await req('POST', '/api/watch', {
    body: {},
    cookies: kidCookie,
  });
  assert.equal(r.status, 400);
});

// POST /api/likes

test('POST /api/likes toggles like on', async () => {
  const { kidCookie } = await setupKidWithVideos();

  const r = await req('POST', '/api/likes', {
    body: { video_id: 'act_v1', title: 'Parkour Tricks', channel_title: 'Activity Channel' },
    cookies: kidCookie,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.liked, true);
});

test('POST /api/likes toggles like off on second call', async () => {
  const { kidCookie } = await setupKidWithVideos();

  await req('POST', '/api/likes', {
    body: { video_id: 'act_v2', title: 'Minecraft Build', channel_title: 'Activity Channel' },
    cookies: kidCookie,
  });
  const r = await req('POST', '/api/likes', {
    body: { video_id: 'act_v2', title: 'Minecraft Build', channel_title: 'Activity Channel' },
    cookies: kidCookie,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.liked, false);
});

test('POST /api/likes returns 404 without kid cookie', async () => {
  const r = await req('POST', '/api/likes', {
    body: { video_id: 'act_v1', title: 'T', channel_title: 'C' },
  });
  assert.equal(r.status, 404);
});

// GET /api/feed now includes watched and liked IDs

test('GET /api/feed includes watched_video_ids and liked_video_ids', async () => {
  const { kidCookie } = await setupKidWithVideos();

  // Watch and like some videos
  await req('POST', '/api/watch', { body: { video_id: 'act_v1' }, cookies: kidCookie });
  await req('POST', '/api/likes', { body: { video_id: 'act_v2', title: 'T', channel_title: 'C' }, cookies: kidCookie });

  const r = await req('GET', '/api/feed', { cookies: kidCookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.watched_video_ids), 'should have watched_video_ids');
  assert.ok(r.body.watched_video_ids.includes('act_v1'));
  assert.ok(Array.isArray(r.body.liked_video_ids), 'should have liked_video_ids');
  assert.ok(r.body.liked_video_ids.includes('act_v2'));
});

// GET /api/search

test('GET /api/search returns matching videos', async () => {
  const { kidCookie } = await setupKidWithVideos();

  const r = await req('GET', '/api/search?q=parkour', { cookies: kidCookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.videos), 'should have videos array');
  assert.equal(r.body.videos.length, 2); // 'Parkour Tricks' and 'Parkour World'
  assert.ok(Array.isArray(r.body.liked_video_ids), 'should have liked_video_ids');
});

test('GET /api/search returns empty for no match', async () => {
  const { kidCookie } = await setupKidWithVideos();

  const r = await req('GET', '/api/search?q=hockey', { cookies: kidCookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.videos.length, 0);
});

test('GET /api/search returns 404 without kid cookie', async () => {
  const r = await req('GET', '/api/search?q=test');
  assert.equal(r.status, 404);
});

test('GET /api/search returns 400 without query', async () => {
  const { kidCookie } = await setupKidWithVideos();

  const r = await req('GET', '/api/search', { cookies: kidCookie });
  assert.equal(r.status, 400);
});

// --- Parent ratings: POST /api/kids/:id/rate ---

test('POST /api/kids/:id/rate inserts a thumbs up rating', async () => {
  const { kidId, sessionCookie } = await setupKidWithVideos();

  const r = await req('POST', `/api/kids/${kidId}/rate`, {
    body: { video_id: 'act_v1', rating: 1 },
    cookies: sessionCookie,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('POST /api/kids/:id/rate with -1 removes video from feed', async () => {
  const { kidId, kidCookie, sessionCookie } = await setupKidWithVideos();

  // Verify video is in the feed first
  const feedBefore = await req('GET', '/api/feed', { cookies: kidCookie });
  assert.ok(feedBefore.body.videos.some(v => v.video_id === 'act_v1'), 'video should be in feed initially');

  // Thumbs down
  const r = await req('POST', `/api/kids/${kidId}/rate`, {
    body: { video_id: 'act_v1', rating: -1 },
    cookies: sessionCookie,
  });
  assert.equal(r.status, 200);

  // Video should no longer be in the feed
  const feedAfter = await req('GET', '/api/feed', { cookies: kidCookie });
  assert.ok(!feedAfter.body.videos.some(v => v.video_id === 'act_v1'), 'video should be removed from feed after thumbs down');
});

test('POST /api/kids/:id/rate requires parent auth', async () => {
  const r = await req('POST', '/api/kids/some-kid/rate', {
    body: { video_id: 'v1', rating: 1 },
  });
  assert.equal(r.status, 401);
});

test('POST /api/kids/:id/rate requires video_id and rating', async () => {
  const { kidId, sessionCookie } = await setupKidWithVideos();

  const r1 = await req('POST', `/api/kids/${kidId}/rate`, {
    body: { rating: 1 },
    cookies: sessionCookie,
  });
  assert.equal(r1.status, 400);

  const r2 = await req('POST', `/api/kids/${kidId}/rate`, {
    body: { video_id: 'v1' },
    cookies: sessionCookie,
  });
  assert.equal(r2.status, 400);
});

test('POST /api/kids/:id/rate rejects invalid rating values', async () => {
  const { kidId, sessionCookie } = await setupKidWithVideos();

  const r = await req('POST', `/api/kids/${kidId}/rate`, {
    body: { video_id: 'v1', rating: 5 },
    cookies: sessionCookie,
  });
  assert.equal(r.status, 400);
});

// --- Parent feed preview: GET /api/kids/:id/feed-preview ---

test('GET /api/kids/:id/feed-preview returns videos and ratings', async () => {
  const { kidId, sessionCookie } = await setupKidWithVideos();

  // Rate one video
  await req('POST', `/api/kids/${kidId}/rate`, {
    body: { video_id: 'act_v1', rating: 1 },
    cookies: sessionCookie,
  });

  const r = await req('GET', `/api/kids/${kidId}/feed-preview`, {
    cookies: sessionCookie,
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.videos), 'should have videos array');
  assert.ok(r.body.parent_ratings, 'should have parent_ratings');
  assert.equal(r.body.parent_ratings['act_v1'], 1);
});

test('GET /api/kids/:id/feed-preview requires parent auth', async () => {
  const r = await req('GET', '/api/kids/some-kid/feed-preview');
  assert.equal(r.status, 401);
});

test('GET /api/kids/:id/feed-preview includes kid_name', async () => {
  const { kidId, sessionCookie } = await setupKidWithVideos();

  const r = await req('GET', `/api/kids/${kidId}/feed-preview`, {
    cookies: sessionCookie,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.kid_name, 'ActivityKid');
});
