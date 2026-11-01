import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use isolated temp directory so we don't clobber data/ used by other tests
const testDataDir = await mkdtemp(join(tmpdir(), 'yourtube-auth-test-'));
process.env.YOURTUBE_DATA_DIR = testDataDir;

const { createApp } = await import('../server.js');

let server;
let baseURL;

async function fetch(path, opts = {}) {
  const url = new URL(path, baseURL);
  const res = await globalThis.fetch(url, { redirect: 'manual', ...opts });
  return res;
}

async function login(password = 'changeme') {
  return fetch('/auth/login', {
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

  server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseURL = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(testDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(join(testDataDir, 'sessions.json'), '{}');
});

describe('Auth', () => {
  it('login with correct password succeeds', async () => {
    const res = await login('changeme');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('login with wrong password returns 401', async () => {
    const res = await login('wrong');
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid password');
  });

  it('session cookie is set on login', async () => {
    const res = await login();
    const cookie = getSessionCookie(res);
    assert.ok(cookie, 'session cookie should be set');
    assert.ok(cookie.includes('.'), 'cookie should contain signature');
  });

  it('protected route returns 401 without session', async () => {
    const res = await fetch('/api/status');
    assert.equal(res.status, 401);
  });

  it('protected route succeeds with valid session', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await fetch('/api/status', {
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(res.status, 200);
  });

  it('logout clears session', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const logoutRes = await fetch('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(logoutRes.status, 200);

    const adminRes = await fetch('/api/status', {
      headers: { Cookie: `session=${cookie}` },
    });
    assert.equal(adminRes.status, 401);
  });
});

describe('Server', () => {
  it('GET / returns index.html', async () => {
    const res = await fetch('/');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('YourTube'));
    assert.ok(text.includes('login-screen'));
  });

  it('GET /api/admin/session returns auth status', async () => {
    const res = await fetch('/api/admin/session');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, false);
  });

  it('GET /api/admin/session returns true when logged in', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await fetch('/api/admin/session', {
      headers: { Cookie: `session=${cookie}` },
    });
    const body = await res.json();
    assert.equal(body.authenticated, true);
  });

  it('serves static CSS files with correct content type', async () => {
    await mkdir('public/css', { recursive: true });
    await writeFile('public/css/test.css', 'body { color: red; }');

    const res = await fetch('/css/test.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/css');

    await rm('public/css/test.css');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch('/nonexistent.xyz');
    assert.equal(res.status, 404);
  });
});
