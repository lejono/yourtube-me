import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb, runMigrations, closeDb } from '../lib/db.js';
import { createFamily } from '../lib/auth.js';
import {
  createKid,
  getKidBySetupToken,
  getKidById,
  listKids,
  updateKid,
  deleteKid,
  regenerateSetupToken,
  revokeKidCookies,
  validateKidCookie,
  setKidCookie,
  getKidFromCookie,
} from '../lib/kid-token.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-kid-test-'));
  const dbPath = join(dir, 'test.db');
  const db = getDb(dbPath);
  runMigrations(db);
  return { dir, dbPath, db };
}

function teardown(dir) {
  closeDb();
  rmSync(dir, { recursive: true });
}

// --- createKid ---

test('createKid creates a kid with a 3-word setup code', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Alice', age: 8 });

    assert.ok(kid.id, 'should have an id');
    assert.equal(kid.name, 'Alice');
    assert.equal(kid.age, 8);
    assert.ok(kid.setup_token, 'should have a setup_token');
    const parts = kid.setup_token.split('-');
    assert.equal(parts.length, 3, 'setup_token should be 3 hyphenated words');

    const row = db.prepare('SELECT * FROM kids WHERE id = ?').get(kid.id);
    assert.ok(row, 'row should exist in DB');
    assert.equal(row.name, 'Alice');
    assert.equal(row.setup_token, kid.setup_token);
    assert.equal(row.cookie_generation, 1);
  } finally {
    teardown(dir);
  }
});

test('createKid stores family_id correctly', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent2@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Bob' });

    const row = db.prepare('SELECT * FROM kids WHERE id = ?').get(kid.id);
    assert.equal(row.family_id, family.id);
  } finally {
    teardown(dir);
  }
});

test('createKid generates unique setup_tokens across multiple kids', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent3@example.com', 'secret');
    const tokens = new Set();
    for (let i = 0; i < 10; i++) {
      const kid = createKid(db, family.id, { name: `Kid${i}` });
      tokens.add(kid.setup_token);
    }
    assert.equal(tokens.size, 10, 'all setup_tokens should be unique');
  } finally {
    teardown(dir);
  }
});

// --- getKidBySetupToken ---

test('getKidBySetupToken retrieves the correct kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p4@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Charlie', age: 10 });

    const found = getKidBySetupToken(db, kid.setup_token);
    assert.ok(found, 'should find the kid');
    assert.equal(found.id, kid.id);
    assert.equal(found.name, 'Charlie');
  } finally {
    teardown(dir);
  }
});

test('getKidBySetupToken returns null for unknown token', () => {
  const { dir, db } = makeTempDb();
  try {
    const result = getKidBySetupToken(db, 'unknowntoken1234');
    assert.equal(result, null);
  } finally {
    teardown(dir);
  }
});

// --- getKidById ---

test('getKidById retrieves kid by id', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p5@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Dana', age: 7 });

    const found = getKidById(db, kid.id);
    assert.ok(found, 'should find the kid');
    assert.equal(found.id, kid.id);
    assert.equal(found.name, 'Dana');
    assert.equal(found.age, 7);
  } finally {
    teardown(dir);
  }
});

test('getKidById returns null for unknown id', () => {
  const { dir, db } = makeTempDb();
  try {
    const result = getKidById(db, 'nonexistent-kid-id');
    assert.equal(result, null);
  } finally {
    teardown(dir);
  }
});

// --- listKids ---

test('listKids returns all kids for a family', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p6@example.com', 'secret');
    createKid(db, family.id, { name: 'Eli' });
    createKid(db, family.id, { name: 'Fiona' });
    createKid(db, family.id, { name: 'George' });

    const kids = listKids(db, family.id);
    assert.equal(kids.length, 3);
    const names = kids.map(k => k.name).sort();
    assert.deepEqual(names, ['Eli', 'Fiona', 'George']);
  } finally {
    teardown(dir);
  }
});

test('listKids returns empty array for family with no kids', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p7@example.com', 'secret');
    const kids = listKids(db, family.id);
    assert.deepEqual(kids, []);
  } finally {
    teardown(dir);
  }
});

test('listKids does not return kids from other families', () => {
  const { dir, db } = makeTempDb();
  try {
    const family1 = createFamily(db, 'p8a@example.com', 'secret');
    const family2 = createFamily(db, 'p8b@example.com', 'secret');
    createKid(db, family1.id, { name: 'Hana' });
    createKid(db, family2.id, { name: 'Ivan' });

    const kids = listKids(db, family1.id);
    assert.equal(kids.length, 1);
    assert.equal(kids[0].name, 'Hana');
  } finally {
    teardown(dir);
  }
});

// --- updateKid ---

test('updateKid updates name, age, and guidelines', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p9@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Jen', age: 6 });

    const updated = updateKid(db, kid.id, { name: 'Jenny', age: 7, guidelines: 'No scary stuff' });
    assert.equal(updated.name, 'Jenny');
    assert.equal(updated.age, 7);
    assert.equal(updated.guidelines, 'No scary stuff');

    const row = db.prepare('SELECT * FROM kids WHERE id = ?').get(kid.id);
    assert.equal(row.name, 'Jenny');
    assert.equal(row.age, 7);
    assert.equal(row.guidelines, 'No scary stuff');
  } finally {
    teardown(dir);
  }
});

test('updateKid does not change setup_token or cookie_generation', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p10@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Kira' });
    const originalToken = kid.setup_token;

    updateKid(db, kid.id, { name: 'Kira Updated' });

    const row = db.prepare('SELECT * FROM kids WHERE id = ?').get(kid.id);
    assert.equal(row.setup_token, originalToken, 'setup_token should not change on update');
    assert.equal(row.cookie_generation, 1, 'cookie_generation should not change on update');
  } finally {
    teardown(dir);
  }
});

// --- deleteKid ---

test('deleteKid removes the kid from the database', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p11@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Leo' });

    deleteKid(db, kid.id);

    const row = db.prepare('SELECT * FROM kids WHERE id = ?').get(kid.id);
    assert.equal(row, undefined, 'kid should be removed');
  } finally {
    teardown(dir);
  }
});

test('deleteKid cascades to child records (channels, videos)', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p12@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Mia' });

    // Insert a channel and video for the kid
    db.prepare(
      `INSERT INTO channels (kid_id, channel_id, title) VALUES (?, ?, ?)`
    ).run(kid.id, 'UC123', 'Test Channel');

    db.prepare(
      `INSERT INTO videos (kid_id, video_id, title, channel_id, channel_title)
       VALUES (?, ?, ?, ?, ?)`
    ).run(kid.id, 'vid1', 'Test Video', 'UC123', 'Test Channel');

    deleteKid(db, kid.id);

    const channels = db.prepare('SELECT * FROM channels WHERE kid_id = ?').all(kid.id);
    const videos = db.prepare('SELECT * FROM videos WHERE kid_id = ?').all(kid.id);
    assert.equal(channels.length, 0, 'channels should be cascaded');
    assert.equal(videos.length, 0, 'videos should be cascaded');
  } finally {
    teardown(dir);
  }
});

// --- regenerateSetupToken ---

test('regenerateSetupToken returns a new 3-word code', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p13@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Nora' });
    const oldToken = kid.setup_token;

    const newToken = regenerateSetupToken(db, kid.id);
    assert.equal(typeof newToken, 'string');
    assert.equal(newToken.split('-').length, 3, 'should be 3 hyphenated words');
    assert.notEqual(newToken, oldToken, 'new token should differ from old token');
  } finally {
    teardown(dir);
  }
});

test('regenerateSetupToken: old token no longer resolves', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p14@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Oscar' });
    const oldToken = kid.setup_token;

    regenerateSetupToken(db, kid.id);

    const found = getKidBySetupToken(db, oldToken);
    assert.equal(found, null, 'old setup_token should no longer resolve');
  } finally {
    teardown(dir);
  }
});

test('regenerateSetupToken: new token resolves to correct kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p15@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Pam' });

    const newToken = regenerateSetupToken(db, kid.id);
    const found = getKidBySetupToken(db, newToken);
    assert.ok(found, 'new token should resolve');
    assert.equal(found.id, kid.id);
  } finally {
    teardown(dir);
  }
});

// --- revokeKidCookies ---

test('revokeKidCookies increments cookie_generation', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p16@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Quinn' });

    assert.equal(kid.cookie_generation, 1);
    revokeKidCookies(db, kid.id);

    const row = db.prepare('SELECT cookie_generation FROM kids WHERE id = ?').get(kid.id);
    assert.equal(row.cookie_generation, 2);
  } finally {
    teardown(dir);
  }
});

test('revokeKidCookies can be called multiple times', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'p17@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Riley' });

    revokeKidCookies(db, kid.id);
    revokeKidCookies(db, kid.id);
    revokeKidCookies(db, kid.id);

    const row = db.prepare('SELECT cookie_generation FROM kids WHERE id = ?').get(kid.id);
    assert.equal(row.cookie_generation, 4);
  } finally {
    teardown(dir);
  }
});

// --- validateKidCookie ---

test('validateKidCookie returns kid for a valid cookie', async () => {
  const { dir, db } = makeTempDb();
  try {
    process.env.YOURTUBE_SESSION_SECRET = 'test-secret-for-kid-token';
    const family = createFamily(db, 'p18@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Sam', age: 9 });

    const row = db.prepare('SELECT * FROM kids WHERE id = ?').get(kid.id);
    // Build a valid cookie value: kid_id:generation:hmac
    const mockRes = { setHeader: () => {} };
    setKidCookie(mockRes, kid.id, row.cookie_generation);

    // Capture what setKidCookie would produce
    let cookieValue;
    const captureRes = {
      setHeader: (name, value) => {
        // Extract cookie value from Set-Cookie header
        const match = value.match(/^yt_kid=([^;]+)/);
        if (match) cookieValue = decodeURIComponent(match[1]);
      },
    };
    setKidCookie(captureRes, kid.id, row.cookie_generation);

    const result = await validateKidCookie(db, cookieValue);
    assert.ok(result, 'should return kid');
    assert.equal(result.id, kid.id);
    assert.equal(result.name, 'Sam');
  } finally {
    teardown(dir);
  }
});

test('validateKidCookie returns null for unknown kid_id', async () => {
  const { dir, db } = makeTempDb();
  try {
    process.env.YOURTUBE_SESSION_SECRET = 'test-secret-for-kid-token';
    const result = await validateKidCookie(db, 'nonexistent:1:badhmacsignature');
    assert.equal(result, null);
  } finally {
    teardown(dir);
  }
});

test('validateKidCookie returns null for tampered HMAC', async () => {
  const { dir, db } = makeTempDb();
  try {
    process.env.YOURTUBE_SESSION_SECRET = 'test-secret-for-kid-token';
    const family = createFamily(db, 'p19@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Tara' });

    // Construct a cookie with a bad HMAC
    const tampered = `${kid.id}:1:invalidhmacvalue`;
    const result = await validateKidCookie(db, tampered);
    assert.equal(result, null);
  } finally {
    teardown(dir);
  }
});

test('validateKidCookie returns null after revokeKidCookies', async () => {
  const { dir, db } = makeTempDb();
  try {
    process.env.YOURTUBE_SESSION_SECRET = 'test-secret-for-kid-token';
    const family = createFamily(db, 'p20@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Uma' });

    let cookieValue;
    const captureRes = {
      setHeader: (name, value) => {
        const match = value.match(/^yt_kid=([^;]+)/);
        if (match) cookieValue = decodeURIComponent(match[1]);
      },
    };
    setKidCookie(captureRes, kid.id, 1);

    // Revoke: bumps cookie_generation to 2
    revokeKidCookies(db, kid.id);

    // Cookie with generation=1 should now be invalid
    const result = await validateKidCookie(db, cookieValue);
    assert.equal(result, null, 'revoked cookie should not validate');
  } finally {
    teardown(dir);
  }
});

test('validateKidCookie returns null for malformed cookie string', async () => {
  const { dir, db } = makeTempDb();
  try {
    process.env.YOURTUBE_SESSION_SECRET = 'test-secret-for-kid-token';
    assert.equal(await validateKidCookie(db, ''), null);
    assert.equal(await validateKidCookie(db, 'justone'), null);
    assert.equal(await validateKidCookie(db, 'only:two'), null);
  } finally {
    teardown(dir);
  }
});

// --- getKidFromCookie (integration) ---

test('getKidFromCookie returns kid_id for valid cookie in request', async () => {
  const { dir, db } = makeTempDb();
  try {
    process.env.YOURTUBE_SESSION_SECRET = 'test-secret-for-kid-token';
    const family = createFamily(db, 'p21@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Vera', age: 11 });

    let cookieHeader;
    const captureRes = {
      setHeader: (name, value) => {
        if (name === 'Set-Cookie') {
          // Convert Set-Cookie header value into a Cookie header value
          const match = value.match(/^(yt_kid=[^;]+)/);
          if (match) cookieHeader = match[1];
        }
      },
    };
    const row = db.prepare('SELECT cookie_generation FROM kids WHERE id = ?').get(kid.id);
    setKidCookie(captureRes, kid.id, row.cookie_generation);

    const mockReq = { headers: { cookie: cookieHeader } };
    const result = await getKidFromCookie(mockReq, db);
    assert.ok(result, 'should return a kid');
    assert.equal(result.id, kid.id);
  } finally {
    teardown(dir);
  }
});

test('getKidFromCookie returns null when no yt_kid cookie present', async () => {
  const { dir, db } = makeTempDb();
  try {
    process.env.YOURTUBE_SESSION_SECRET = 'test-secret-for-kid-token';
    const mockReq = { headers: { cookie: 'some_other_cookie=value' } };
    const result = await getKidFromCookie(mockReq, db);
    assert.equal(result, null);
  } finally {
    teardown(dir);
  }
});
