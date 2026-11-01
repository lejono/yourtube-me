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
import {
  recordWatch,
  getWatchedVideoIds,
  toggleLike,
  getLikedVideoIds,
  searchVideos,
} from '../lib/kid-activity.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-kid-activity-test-'));
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

function seedKid(db) {
  const family = createFamily(db, `parent-${Math.random()}@example.com`, 'secret');
  const kid = createKid(db, family.id, { name: 'TestKid', age: 10 });
  addChannel(db, kid.id, { channel_id: 'UC_TEST', title: 'Test Channel' });
  return kid;
}

function makeVideo(overrides = {}) {
  return {
    video_id: `vid_${Math.random().toString(36).slice(2)}`,
    title: 'Test Video',
    channel_id: 'UC_TEST',
    channel_title: 'Test Channel',
    published_at: '2024-01-01',
    thumbnail: null,
    ai_approved: 1,
    ai_reason: null,
    ...overrides,
  };
}

// --- recordWatch ---

test('recordWatch inserts a new watch record', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    recordWatch(db, kid.id, 'vid_abc');

    const row = db.prepare('SELECT * FROM watches WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid_abc');
    assert.ok(row, 'watch record should exist');
    assert.equal(row.video_id, 'vid_abc');
    assert.ok(row.started_at, 'started_at should be set');
  } finally {
    teardown(dir, db);
  }
});

test('recordWatch upserts on duplicate (kid_id, video_id)', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    recordWatch(db, kid.id, 'vid_dup');
    // Second call should not throw
    recordWatch(db, kid.id, 'vid_dup');

    const rows = db.prepare('SELECT * FROM watches WHERE kid_id = ? AND video_id = ?').all(kid.id, 'vid_dup');
    assert.equal(rows.length, 1, 'should only have one record after upsert');
  } finally {
    teardown(dir, db);
  }
});

// --- getWatchedVideoIds ---

test('getWatchedVideoIds returns array of watched video IDs', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    recordWatch(db, kid.id, 'vid_1');
    recordWatch(db, kid.id, 'vid_2');

    const ids = getWatchedVideoIds(db, kid.id);
    assert.ok(Array.isArray(ids), 'should be an array');
    assert.equal(ids.length, 2);
    assert.ok(ids.includes('vid_1'));
    assert.ok(ids.includes('vid_2'));
  } finally {
    teardown(dir, db);
  }
});

test('getWatchedVideoIds returns empty array for kid with no watches', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    const ids = getWatchedVideoIds(db, kid.id);
    assert.deepEqual(ids, []);
  } finally {
    teardown(dir, db);
  }
});

// --- toggleLike ---

test('toggleLike adds a like when not yet liked', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    const result = toggleLike(db, kid.id, { video_id: 'vid_like', title: 'Cool Video', channel_title: 'Cool Channel' });
    assert.equal(result.liked, true);

    const row = db.prepare('SELECT * FROM likes WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid_like');
    assert.ok(row, 'like record should exist');
    assert.equal(row.title, 'Cool Video');
    assert.equal(row.channel_title, 'Cool Channel');
  } finally {
    teardown(dir, db);
  }
});

test('toggleLike removes a like when already liked', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    toggleLike(db, kid.id, { video_id: 'vid_unlike', title: 'Video', channel_title: 'Chan' });
    const result = toggleLike(db, kid.id, { video_id: 'vid_unlike', title: 'Video', channel_title: 'Chan' });
    assert.equal(result.liked, false);

    const row = db.prepare('SELECT * FROM likes WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid_unlike');
    assert.equal(row, undefined, 'like record should be deleted');
  } finally {
    teardown(dir, db);
  }
});

test('toggleLike can re-like after unliking', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    toggleLike(db, kid.id, { video_id: 'vid_re', title: 'V', channel_title: 'C' });
    toggleLike(db, kid.id, { video_id: 'vid_re', title: 'V', channel_title: 'C' });
    const result = toggleLike(db, kid.id, { video_id: 'vid_re', title: 'V', channel_title: 'C' });
    assert.equal(result.liked, true);
  } finally {
    teardown(dir, db);
  }
});

// --- getLikedVideoIds ---

test('getLikedVideoIds returns array of liked video IDs', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    toggleLike(db, kid.id, { video_id: 'vid_a', title: 'A', channel_title: 'C' });
    toggleLike(db, kid.id, { video_id: 'vid_b', title: 'B', channel_title: 'C' });

    const ids = getLikedVideoIds(db, kid.id);
    assert.ok(Array.isArray(ids));
    assert.equal(ids.length, 2);
    assert.ok(ids.includes('vid_a'));
    assert.ok(ids.includes('vid_b'));
  } finally {
    teardown(dir, db);
  }
});

test('getLikedVideoIds returns empty array when no likes', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    const ids = getLikedVideoIds(db, kid.id);
    assert.deepEqual(ids, []);
  } finally {
    teardown(dir, db);
  }
});

// --- searchVideos ---

test('searchVideos finds videos by title (case-insensitive)', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'v1', title: 'Amazing Parkour Run', ai_approved: 1 }),
      makeVideo({ video_id: 'v2', title: 'Cool Minecraft Build', ai_approved: 1 }),
      makeVideo({ video_id: 'v3', title: 'Parkour World Record', ai_approved: 1 }),
    ]);

    const results = searchVideos(db, kid.id, 'parkour');
    assert.equal(results.length, 2);
    const ids = results.map(v => v.video_id).sort();
    assert.deepEqual(ids, ['v1', 'v3']);
  } finally {
    teardown(dir, db);
  }
});

test('searchVideos only returns approved videos', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'v_ok', title: 'Good Parkour', ai_approved: 1 }),
      makeVideo({ video_id: 'v_bad', title: 'Bad Parkour', ai_approved: 0 }),
    ]);

    const results = searchVideos(db, kid.id, 'parkour');
    assert.equal(results.length, 1);
    assert.equal(results[0].video_id, 'v_ok');
  } finally {
    teardown(dir, db);
  }
});

test('searchVideos returns empty array for no matches', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'v1', title: 'Minecraft Build', ai_approved: 1 }),
    ]);

    const results = searchVideos(db, kid.id, 'hockey');
    assert.deepEqual(results, []);
  } finally {
    teardown(dir, db);
  }
});

test('searchVideos respects limit parameter', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid = seedKid(db);
    const videos = Array.from({ length: 10 }, (_, i) =>
      makeVideo({ video_id: `sv_${i}`, title: `Test Video ${i}`, ai_approved: 1 })
    );
    upsertVideos(db, kid.id, videos);

    const results = searchVideos(db, kid.id, 'Test', 3);
    assert.equal(results.length, 3);
  } finally {
    teardown(dir, db);
  }
});

test('searchVideos only searches this kid\'s videos', () => {
  const { dir, db } = makeTempDb();
  try {
    const kid1 = seedKid(db);
    const kid2 = seedKid(db);

    upsertVideos(db, kid1.id, [makeVideo({ video_id: 'k1v', title: 'Unique Title', ai_approved: 1 })]);
    upsertVideos(db, kid2.id, [makeVideo({ video_id: 'k2v', title: 'Unique Title', ai_approved: 1 })]);

    const results = searchVideos(db, kid1.id, 'Unique');
    assert.equal(results.length, 1);
    assert.equal(results[0].video_id, 'k1v');
  } finally {
    teardown(dir, db);
  }
});
