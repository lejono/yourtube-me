import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateId, generateSetupToken, getDb, runMigrations, closeDb } from '../lib/db.js';

// --- generateId ---

test('generateId returns a string', () => {
  const id = generateId();
  assert.equal(typeof id, 'string');
});

test('generateId returns unique values', () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateId()));
  assert.equal(ids.size, 100);
});

test('generateId default length is 16 chars (12 bytes base64url)', () => {
  const id = generateId();
  assert.equal(id.length, 16);
});

test('generateId with custom bytes produces correct length', () => {
  // 6 bytes = 8 base64url chars
  const id = generateId(6);
  assert.equal(id.length, 8);
});

test('generateId output is URL-safe (no +, /, or = chars)', () => {
  for (let i = 0; i < 50; i++) {
    const id = generateId();
    assert.doesNotMatch(id, /[+/=]/);
  }
});

// --- generateSetupToken ---

test('generateSetupToken returns a string', () => {
  const token = generateSetupToken();
  assert.equal(typeof token, 'string');
});

test('generateSetupToken returns a 3-word hyphenated code', () => {
  const token = generateSetupToken();
  const parts = token.split('-');
  assert.equal(parts.length, 3, `expected 3 words, got: ${token}`);
  for (const word of parts) {
    assert.ok(word.length >= 2, `word too short: ${word}`);
    assert.match(word, /^[a-z]+$/, `word should be lowercase alpha: ${word}`);
  }
});

test('generateSetupToken returns unique values', () => {
  const tokens = new Set(Array.from({ length: 50 }, () => generateSetupToken()));
  assert.ok(tokens.size >= 45, 'expected mostly unique tokens');
});

test('generateSetupToken returns unique values', () => {
  const tokens = new Set(Array.from({ length: 100 }, () => generateSetupToken()));
  assert.equal(tokens.size, 100);
});

// --- runMigrations ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-test-'));
  const dbPath = join(dir, 'test.db');
  return { dir, dbPath };
}

test('runMigrations creates all expected tables', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = getDb(dbPath);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_migrations%' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(r => r.name)
      .sort();

    assert.deepEqual(tables, ['channels', 'curated_channels', 'curated_videos', 'families', 'feedback', 'kids', 'likes', 'parent_ratings', 'sessions', 'videos', 'waitlist', 'watches']);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true });
  }
});

test('runMigrations is idempotent (safe to run twice)', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = getDb(dbPath);
    runMigrations(db);
    // Should not throw
    assert.doesNotThrow(() => runMigrations(db));
  } finally {
    closeDb();
    rmSync(dir, { recursive: true });
  }
});

test('foreign keys are enforced: inserting kid with nonexistent family_id throws', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = getDb(dbPath);
    runMigrations(db);

    assert.throws(() => {
      db.prepare(
        `INSERT INTO kids (id, family_id, name, setup_token)
         VALUES ('kid1', 'nonexistent-family', 'Alice', 'sometoken12345ab')`
      ).run();
    }, /FOREIGN KEY constraint failed/);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true });
  }
});
