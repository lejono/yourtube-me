import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb, runMigrations, closeDb } from '../lib/db.js';
import {
  hashPassword,
  verifyPassword,
  createFamily,
  authenticateFamily,
  createSession,
  validateSession,
  destroySession,
} from '../lib/auth.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-auth-test-'));
  const dbPath = join(dir, 'test.db');
  const db = getDb(dbPath);
  runMigrations(db);
  return { dir, dbPath, db };
}

function teardown(dir) {
  closeDb();
  rmSync(dir, { recursive: true });
}

// --- hashPassword / verifyPassword ---

test('correct password verifies successfully', () => {
  const { hash, salt } = hashPassword('hunter2');
  assert.equal(verifyPassword('hunter2', hash, salt), true);
});

test('wrong password does not verify', () => {
  const { hash, salt } = hashPassword('hunter2');
  assert.equal(verifyPassword('wrong-password', hash, salt), false);
});

test('different passwords produce different hashes (same salt)', () => {
  const { hash: h1, salt } = hashPassword('password1');
  const { hash: h2 } = hashPassword('password2', salt);
  assert.notEqual(h1, h2);
});

test('same password with different salts produces different hashes', () => {
  const { hash: h1, salt: s1 } = hashPassword('samepassword');
  const { hash: h2, salt: s2 } = hashPassword('samepassword');
  // Salts should differ (with overwhelming probability)
  assert.notEqual(s1, s2);
  assert.notEqual(h1, h2);
});

// --- createFamily ---

test('createFamily creates a row with id, email, password_salt', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'test@example.com', 'secret');
    assert.ok(family.id, 'should have an id');
    assert.equal(family.email, 'test@example.com');

    const row = db.prepare('SELECT * FROM families WHERE id = ?').get(family.id);
    assert.ok(row, 'row should exist in DB');
    assert.equal(row.email, 'test@example.com');
    assert.ok(row.password_hash, 'should have password_hash');
    assert.ok(row.password_salt, 'should have password_salt');
  } finally {
    teardown(dir);
  }
});

test('createFamily rejects duplicate email', () => {
  const { dir, db } = makeTempDb();
  try {
    createFamily(db, 'dupe@example.com', 'pass1');
    assert.throws(
      () => createFamily(db, 'dupe@example.com', 'pass2'),
      /UNIQUE constraint failed/
    );
  } finally {
    teardown(dir);
  }
});

// --- createSession / validateSession ---

test('createSession returns a session id and validateSession returns the family record', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'sess@example.com', 'pass');
    const sessionId = createSession(db, family.id);
    assert.equal(typeof sessionId, 'string');
    assert.ok(sessionId.length > 0);

    const result = validateSession(db, sessionId);
    assert.ok(result, 'session should be valid');
    assert.equal(result.family_id, family.id);
  } finally {
    teardown(dir);
  }
});

test('validateSession returns null for unknown session id', () => {
  const { dir, db } = makeTempDb();
  try {
    const result = validateSession(db, 'nonexistent-session-id');
    assert.equal(result, null);
  } finally {
    teardown(dir);
  }
});

test('validateSession returns null for expired session', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'expired@example.com', 'pass');
    const sessionId = createSession(db, family.id);

    // Backdate the expiry to the past
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(sessionId);

    const result = validateSession(db, sessionId);
    assert.equal(result, null);
  } finally {
    teardown(dir);
  }
});

// --- destroySession ---

test('destroySession makes the session no longer validate', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'destroy@example.com', 'pass');
    const sessionId = createSession(db, family.id);

    // Confirm it's valid first
    assert.ok(validateSession(db, sessionId));

    destroySession(db, sessionId);

    assert.equal(validateSession(db, sessionId), null);
  } finally {
    teardown(dir);
  }
});
