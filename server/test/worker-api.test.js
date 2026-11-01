import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../lib/db.js';
import { createFamily } from '../lib/auth.js';
import { createKid } from '../lib/kid-token.js';
import { addChannel, upsertVideos } from '../lib/family-api.js';
import { recordWatch } from '../lib/kid-activity.js';
import { authenticateWorker, getWorkerManifest } from '../lib/worker-api.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-worker-api-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return { dir, dbPath, db };
}

function teardown(dir, db) {
  db.close();
  rmSync(dir, { recursive: true });
}

// --- authenticateWorker ---

test('authenticateWorker returns true for matching key', () => {
  const masterKey = 'super-secret-worker-key';
  assert.equal(authenticateWorker(masterKey, 'super-secret-worker-key'), true);
});

test('authenticateWorker returns false for wrong key', () => {
  const masterKey = 'super-secret-worker-key';
  assert.equal(authenticateWorker(masterKey, 'wrong-key'), false);
});

test('authenticateWorker returns false for empty provided key', () => {
  const masterKey = 'super-secret-worker-key';
  assert.equal(authenticateWorker(masterKey, ''), false);
});

test('authenticateWorker returns false for empty master key', () => {
  assert.equal(authenticateWorker('', 'some-key'), false);
});

test('authenticateWorker uses constant-time comparison (does not throw on length mismatch)', () => {
  // This test verifies that length mismatches are handled gracefully (not thrown)
  assert.doesNotThrow(() => authenticateWorker('short', 'a-much-longer-key-than-master'));
  assert.doesNotThrow(() => authenticateWorker('a-much-longer-master-key', 'short'));
});

// --- getWorkerManifest ---

test('getWorkerManifest returns empty array when no kids exist', () => {
  const { dir, db } = makeTempDb();
  try {
    const manifest = getWorkerManifest(db);
    assert.deepEqual(manifest, []);
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest returns kids with their channels grouped', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent@example.com', 'secret');
    const kid1 = createKid(db, family.id, { name: 'Alice', age: 9 });
    db.prepare('UPDATE kids SET interests = ? WHERE id = ?').run(JSON.stringify(['gaming', 'science']), kid1.id);
    const kid2 = createKid(db, family.id, { name: 'Bob', age: 12 });

    addChannel(db, kid1.id, { channel_id: 'UC_A1', title: 'Alice Chan 1' });
    addChannel(db, kid1.id, { channel_id: 'UC_A2', title: 'Alice Chan 2' });
    addChannel(db, kid2.id, { channel_id: 'UC_B1', title: 'Bob Chan 1' });

    const manifest = getWorkerManifest(db);
    assert.equal(manifest.length, 2);

    const alice = manifest.find(k => k.kid_name === 'Alice');
    assert.ok(alice, 'Alice should be in manifest');
    assert.equal(alice.channels.length, 2);
    const aliceChanIds = alice.channels.map(c => c.channel_id).sort();
    assert.deepEqual(aliceChanIds, ['UC_A1', 'UC_A2']);

    const bob = manifest.find(k => k.kid_name === 'Bob');
    assert.ok(bob, 'Bob should be in manifest');
    assert.equal(bob.channels.length, 1);
    assert.equal(bob.channels[0].channel_id, 'UC_B1');
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest parses interests from JSON string', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent2@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Carol' });
    db.prepare('UPDATE kids SET interests = ? WHERE id = ?').run(JSON.stringify(['art', 'music', 'coding']), kid.id);
    addChannel(db, kid.id, { channel_id: 'UC_C', title: 'Carol Chan' });

    const manifest = getWorkerManifest(db);
    const carol = manifest.find(k => k.kid_name === 'Carol');
    assert.ok(carol);
    assert.deepEqual(carol.interests, ['art', 'music', 'coding']);
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest handles null interests gracefully', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent3@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Dave' }); // no interests
    addChannel(db, kid.id, { channel_id: 'UC_D', title: 'Dave Chan' });

    const manifest = getWorkerManifest(db);
    const dave = manifest.find(k => k.kid_name === 'Dave');
    assert.ok(dave);
    assert.deepEqual(dave.interests, []);
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest includes channels_generated flag', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent4@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Eve' });
    addChannel(db, kid.id, { channel_id: 'UC_E', title: 'Eve Chan' });

    const manifest1 = getWorkerManifest(db);
    const eve1 = manifest1.find(k => k.kid_name === 'Eve');
    assert.equal(eve1.channels_generated, 0);

    db.prepare('UPDATE kids SET channels_generated = 1 WHERE id = ?').run(kid.id);

    const manifest2 = getWorkerManifest(db);
    const eve2 = manifest2.find(k => k.kid_name === 'Eve');
    assert.equal(eve2.channels_generated, 1);
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest includes kids without channels in manifest', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent5@example.com', 'secret');
    createKid(db, family.id, { name: 'Frank', age: 7 });

    const manifest = getWorkerManifest(db);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].kid_name, 'Frank');
    assert.deepEqual(manifest[0].channels, []);
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest includes kid_id in each entry', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent6@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Grace' });

    const manifest = getWorkerManifest(db);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].kid_id, kid.id);
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest includes channels_status for each kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent7@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Hank' });

    const manifest1 = getWorkerManifest(db);
    assert.equal(manifest1[0].channels_status, 'idle', 'default should be idle');

    db.prepare('UPDATE kids SET channels_status = ? WHERE id = ?').run('generating', kid.id);

    const manifest2 = getWorkerManifest(db);
    assert.equal(manifest2[0].channels_status, 'generating');
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest only includes approved channels for RSS polling', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'approved-only@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Ivy' });

    addChannel(db, kid.id, { channel_id: 'UC_OK', title: 'Approved' });
    addChannel(db, kid.id, { channel_id: 'UC_PENDING', title: 'Pending', status: 'pending' });
    addChannel(db, kid.id, { channel_id: 'UC_REJECTED', title: 'Rejected', status: 'rejected' });

    const manifest = getWorkerManifest(db);
    assert.deepEqual(manifest[0].channels.map(c => c.channel_id), ['UC_OK']);
  } finally {
    teardown(dir, db);
  }
});

test('getWorkerManifest includes feed pressure stats for refresh gating', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'feed-stats@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'June' });

    addChannel(db, kid.id, { channel_id: 'UC_OK', title: 'Approved' });
    addChannel(db, kid.id, { channel_id: 'UC_REJECTED', title: 'Rejected', status: 'rejected' });

    upsertVideos(db, kid.id, [
      { video_id: 'v1', title: 'One', channel_id: 'UC_OK', channel_title: 'Approved', published_at: '2024-01-01', thumbnail: null, ai_approved: 1, ai_reason: 'ok' },
      { video_id: 'v2', title: 'Two', channel_id: 'UC_OK', channel_title: 'Approved', published_at: '2024-01-02', thumbnail: null, ai_approved: 1, ai_reason: 'ok' },
      { video_id: 'v3', title: 'Three', channel_id: 'UC_OK', channel_title: 'Approved', published_at: '2024-01-03', thumbnail: null, ai_approved: 1, ai_reason: 'ok' },
      { video_id: 'v4', title: 'Rejected by AI', channel_id: 'UC_OK', channel_title: 'Approved', published_at: '2024-01-04', thumbnail: null, ai_approved: 0, ai_reason: 'bad' },
      { video_id: 'v5', title: 'Rejected Channel', channel_id: 'UC_REJECTED', channel_title: 'Rejected', published_at: '2024-01-05', thumbnail: null, ai_approved: 1, ai_reason: 'ok' },
    ]);
    recordWatch(db, kid.id, 'v1');
    recordWatch(db, kid.id, 'v2');

    const june = getWorkerManifest(db)[0];
    assert.equal(june.approved_video_count, 3);
    assert.equal(june.watched_video_count, 2);
    assert.equal(june.unwatched_video_count, 1);
    assert.ok(june.last_watched_at);
    assert.ok(june.last_pushed_at);
  } finally {
    teardown(dir, db);
  }
});
