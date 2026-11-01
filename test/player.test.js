import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const testDataDir = join('test', '.player-test-data');
process.env.YOURTUBE_DATA_DIR = testDataDir;

const { createApp } = await import('../server.js');
const { DATA_DIR } = await import('../config.js');

let server;
let baseURL;

async function fetch(path, opts = {}) {
  const url = new URL(path, baseURL);
  return globalThis.fetch(url, { redirect: 'manual', ...opts });
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
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, 'sessions.json'), '{}');
  await writeFile(join(DATA_DIR, 'history.json'), '[]');

  server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseURL = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(join(DATA_DIR, 'sessions.json'), '{}');
  await writeFile(join(DATA_DIR, 'history.json'), '[]');
});

describe('POST /api/watch/start', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await fetch('/api/watch/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'abc123' }),
    });
    assert.equal(res.status, 401);
  });

  it('creates a history entry on watch start', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await fetch('/api/watch/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({
        videoId: 'test-video-1',
        timestamp: '2024-06-01T12:00:00Z',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // Verify history file
    const history = JSON.parse(await readFile(join(DATA_DIR, 'history.json'), 'utf-8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].videoId, 'test-video-1');
    assert.equal(history[0].startedAt, '2024-06-01T12:00:00Z');
    assert.equal(history[0].endedAt, null);
    assert.equal(history[0].duration, null);
  });

  it('returns 400 when videoId is missing', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await fetch('/api/watch/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('generates timestamp when not provided', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const beforeTime = new Date().toISOString();
    const res = await fetch('/api/watch/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({ videoId: 'v1' }),
    });
    assert.equal(res.status, 200);

    const history = JSON.parse(await readFile(join(DATA_DIR, 'history.json'), 'utf-8'));
    assert.equal(history.length, 1);
    // startedAt should be a valid ISO timestamp
    assert.ok(new Date(history[0].startedAt).getTime() >= new Date(beforeTime).getTime());
  });
});

describe('POST /api/watch/end', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await fetch('/api/watch/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'abc123' }),
    });
    assert.equal(res.status, 401);
  });

  it('updates the matching history entry on watch end', async () => {
    // Seed a start entry
    await writeFile(join(DATA_DIR, 'history.json'), JSON.stringify([
      { videoId: 'v1', startedAt: '2024-06-01T12:00:00Z', endedAt: null, duration: null },
    ]));

    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await fetch('/api/watch/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({
        videoId: 'v1',
        timestamp: '2024-06-01T12:05:00Z',
        duration: 300,
      }),
    });
    assert.equal(res.status, 200);

    const history = JSON.parse(await readFile(join(DATA_DIR, 'history.json'), 'utf-8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].endedAt, '2024-06-01T12:05:00Z');
    assert.equal(history[0].duration, 300);
  });

  it('updates only the most recent unfinished entry for the same video', async () => {
    await writeFile(join(DATA_DIR, 'history.json'), JSON.stringify([
      { videoId: 'v1', startedAt: '2024-06-01T10:00:00Z', endedAt: '2024-06-01T10:05:00Z', duration: 300 },
      { videoId: 'v1', startedAt: '2024-06-01T12:00:00Z', endedAt: null, duration: null },
    ]));

    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    await fetch('/api/watch/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({
        videoId: 'v1',
        timestamp: '2024-06-01T12:10:00Z',
        duration: 600,
      }),
    });

    const history = JSON.parse(await readFile(join(DATA_DIR, 'history.json'), 'utf-8'));
    assert.equal(history.length, 2);
    // First entry unchanged
    assert.equal(history[0].endedAt, '2024-06-01T10:05:00Z');
    assert.equal(history[0].duration, 300);
    // Second entry updated
    assert.equal(history[1].endedAt, '2024-06-01T12:10:00Z');
    assert.equal(history[1].duration, 600);
  });

  it('returns 400 when videoId is missing', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await fetch('/api/watch/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({ duration: 100 }),
    });
    assert.equal(res.status, 400);
  });

  it('succeeds even if no matching start entry exists', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    const res = await fetch('/api/watch/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({
        videoId: 'no-start-entry',
        timestamp: '2024-06-01T12:00:00Z',
        duration: 100,
      }),
    });
    // Should succeed — just doesn't update anything
    assert.equal(res.status, 200);
  });
});

describe('History entry structure', () => {
  it('has correct fields: videoId, startedAt, endedAt, duration', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);

    // Create start
    await fetch('/api/watch/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({
        videoId: 'structure-test',
        timestamp: '2024-06-01T12:00:00Z',
      }),
    });

    // Create end
    await fetch('/api/watch/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
      },
      body: JSON.stringify({
        videoId: 'structure-test',
        timestamp: '2024-06-01T12:03:00Z',
        duration: 180,
      }),
    });

    const history = JSON.parse(await readFile(join(DATA_DIR, 'history.json'), 'utf-8'));
    assert.equal(history.length, 1);

    const entry = history[0];
    assert.ok('videoId' in entry, 'has videoId');
    assert.ok('startedAt' in entry, 'has startedAt');
    assert.ok('endedAt' in entry, 'has endedAt');
    assert.ok('duration' in entry, 'has duration');
    assert.equal(Object.keys(entry).length, 4, 'has exactly 4 fields');
  });

  it('accumulates multiple watch entries', async () => {
    const loginRes = await login();
    const cookie = getSessionCookie(loginRes);
    const headers = {
      'Content-Type': 'application/json',
      Cookie: `session=${cookie}`,
    };

    // Watch video 1
    await fetch('/api/watch/start', {
      method: 'POST', headers,
      body: JSON.stringify({ videoId: 'v1', timestamp: '2024-06-01T12:00:00Z' }),
    });
    await fetch('/api/watch/end', {
      method: 'POST', headers,
      body: JSON.stringify({ videoId: 'v1', timestamp: '2024-06-01T12:05:00Z', duration: 300 }),
    });

    // Watch video 2
    await fetch('/api/watch/start', {
      method: 'POST', headers,
      body: JSON.stringify({ videoId: 'v2', timestamp: '2024-06-01T12:10:00Z' }),
    });
    await fetch('/api/watch/end', {
      method: 'POST', headers,
      body: JSON.stringify({ videoId: 'v2', timestamp: '2024-06-01T12:12:00Z', duration: 120 }),
    });

    const history = JSON.parse(await readFile(join(DATA_DIR, 'history.json'), 'utf-8'));
    assert.equal(history.length, 2);
    assert.equal(history[0].videoId, 'v1');
    assert.equal(history[1].videoId, 'v2');
  });
});

describe('Player HTML structure', () => {
  it('index.html contains player screen', async () => {
    const res = await fetch('/');
    const html = await res.text();
    assert.ok(html.includes('id="player-screen"'));
    assert.ok(html.includes('id="player-embed"'));
    assert.ok(html.includes('id="player-overlay"'));
    assert.ok(html.includes('id="back-btn"'));
    assert.ok(html.includes('id="replay-btn"'));
  });

  it('player.js is served correctly', async () => {
    const res = await fetch('/js/player.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript');
    const js = await res.text();
    assert.ok(js.includes('/api/watch/start'));
    assert.ok(js.includes('/api/watch/end'));
    assert.ok(js.includes('playsinline'));
    assert.ok(js.includes('onYouTubeIframeAPIReady'));
  });
});
