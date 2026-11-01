import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use isolated temp directory so we don't clobber data/ used by other tests
const testDataDir = await mkdtemp(join(tmpdir(), 'yourtube-oauth-test-'));
process.env.YOURTUBE_DATA_DIR = testDataDir;
process.env.YOURTUBE_SESSION_SECRET = 'test-oauth-secret';
process.env.YOURTUBE_PARENT_PASSWORD = 'changeme';
process.env.YOURTUBE_YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.YOURTUBE_YOUTUBE_CLIENT_SECRET = 'test-client-secret';

const { getAuthURL, validateState, exchangeCode, refreshAccessToken, getValidToken } = await import('../lib/oauth.js');
const store = await import('../lib/store.js');

const TOKENS_FILE = join(testDataDir, 'tokens.json');

before(async () => {
  await mkdir(testDataDir, { recursive: true });
});

after(async () => {
  await rm(testDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(TOKENS_FILE, '{}');
});

describe('OAuth state', () => {
  it('getAuthURL returns a Google OAuth URL with correct parameters', () => {
    const url = getAuthURL('test-session-123');
    assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
    assert.ok(url.includes('client_id=test-client-id.apps.googleusercontent.com'));
    assert.ok(url.includes('redirect_uri='));
    assert.ok(url.includes('response_type=code'));
    assert.ok(url.includes('scope='));
    assert.ok(url.includes('access_type=offline'));
    assert.ok(url.includes('prompt=consent'));
    assert.ok(url.includes('state='));
  });

  it('state generation includes session binding', () => {
    const url = getAuthURL('session-abc');
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state');
    assert.ok(state, 'state parameter should exist');

    // Decode and verify it contains session info
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
    assert.ok(decoded.payload, 'state should have payload');
    assert.ok(decoded.sig, 'state should have signature');

    const payload = JSON.parse(decoded.payload);
    assert.equal(payload.sessionId, 'session-abc');
    assert.ok(payload.nonce, 'state should include a nonce');
  });

  it('validateState accepts valid state for correct session', () => {
    const url = getAuthURL('my-session');
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state');
    assert.ok(validateState(state, 'my-session'));
  });

  it('validateState rejects tampered state', () => {
    const url = getAuthURL('my-session');
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state');

    // Tamper with the state by modifying a character
    const tampered = state.slice(0, -1) + (state.slice(-1) === 'A' ? 'B' : 'A');
    assert.equal(validateState(tampered, 'my-session'), false);
  });

  it('validateState rejects wrong session', () => {
    const url = getAuthURL('session-1');
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state');
    assert.equal(validateState(state, 'session-2'), false);
  });

  it('validateState rejects garbage input', () => {
    assert.equal(validateState('not-valid-base64', 'any-session'), false);
    assert.equal(validateState('', 'any-session'), false);
    assert.equal(validateState(null, 'any-session'), false);
  });

  it('each call to getAuthURL produces a unique state (nonce)', () => {
    const url1 = getAuthURL('same-session');
    const url2 = getAuthURL('same-session');
    const state1 = new URL(url1).searchParams.get('state');
    const state2 = new URL(url2).searchParams.get('state');
    assert.notEqual(state1, state2, 'states should differ due to nonce');
  });
});

describe('Token management', () => {
  it('getValidToken throws when no tokens stored', async () => {
    await writeFile(TOKENS_FILE, '{}');
    await assert.rejects(
      () => getValidToken(),
      { message: /No tokens stored/ }
    );
  });

  it('getValidToken returns cached token if not expired', async () => {
    const tokens = {
      access_token: 'valid-token-123',
      refresh_token: 'refresh-123',
      expiry_time: Date.now() + 3600 * 1000, // 1 hour from now
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
    };
    await store.write('tokens.json', tokens);

    const token = await getValidToken();
    assert.equal(token, 'valid-token-123');
  });

  it('getValidToken considers token expired within 5-min buffer', async () => {
    const tokens = {
      access_token: 'almost-expired',
      refresh_token: 'refresh-123',
      expiry_time: Date.now() + 4 * 60 * 1000, // 4 minutes from now (within 5-min buffer)
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
    };
    await store.write('tokens.json', tokens);

    // This will try to refresh and fail because we don't have a real Google endpoint
    await assert.rejects(
      () => getValidToken(),
      (err) => err instanceof Error
    );
  });

  it('getValidToken throws when expired with no refresh token', async () => {
    const tokens = {
      access_token: 'expired-token',
      expiry_time: Date.now() - 1000, // already expired
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
    };
    await store.write('tokens.json', tokens);

    await assert.rejects(
      () => getValidToken(),
      { message: /no refresh token/ }
    );
  });
});

describe('OAuth server routes', () => {
  let server;
  let baseURL;

  async function httpFetch(path, opts = {}) {
    const url = new URL(path, baseURL);
    return globalThis.fetch(url, { redirect: 'manual', ...opts });
  }

  async function login(password = 'changeme') {
    return httpFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  }

  function getSessionCookie(res) {
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/session=([^;]+)/);
    return match ? match[1] : null;
  }

  before(async () => {
    await mkdir(testDataDir, { recursive: true });

    const { createApp } = await import('../server.js');
    server = createApp();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseURL = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(async () => {
    await writeFile(join(testDataDir, 'sessions.json'), '{}');
  });

  it('GET /auth/youtube redirects to admin when not authenticated', async () => {
    const res = await httpFetch('/auth/youtube');
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.includes('/admin?error=not_authenticated'));
  });

  it('GET /auth/youtube redirects to Google when authenticated', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await httpFetch('/auth/youtube', {
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
    assert.ok(location.includes('client_id='));
    assert.ok(location.includes('state='));
  });

  it('GET /auth/callback rejects invalid state', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await httpFetch('/auth/callback?state=bad-state&code=test-code', {
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.includes('error=invalid_state'));
  });

  it('GET /auth/callback rejects when not authenticated', async () => {
    const res = await httpFetch('/auth/callback?state=any&code=test-code');
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.includes('error=invalid_state'));
  });

  it('GET /auth/callback forwards Google error parameter', async () => {
    const res = await httpFetch('/auth/callback?error=access_denied');
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.includes('error=access_denied'));
  });
});
