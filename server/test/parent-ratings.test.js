import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../lib/db.js';
import { createFamily } from '../lib/auth.js';
import { createKid } from '../lib/kid-token.js';
import { upsertVideos } from '../lib/family-api.js';
import { rateVideo, getParentRatings } from '../lib/family-api.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-ratings-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return { dir, db };
}

function teardown(dir, db) {
  db.close();
  rmSync(dir, { recursive: true });
}

function setupKidWithVideos(db) {
  const family = createFamily(db, `ratings-${Math.random()}@example.com`, 'secret');
  const kid = createKid(db, family.id, { name: 'RatingKid', age: 10 });

  upsertVideos(db, kid.id, [
    { video_id: 'vid1', title: 'Good Video', channel_id: 'UC1', channel_title: 'Chan1', published_at: '2024-01-01', thumbnail: null, ai_approved: 1, ai_reason: null },
    { video_id: 'vid2', title: 'Bad Video', channel_id: 'UC1', channel_title: 'Chan1', published_at: '2024-01-02', thumbnail: null, ai_approved: 1, ai_reason: null },
    { video_id: 'vid3', title: 'Another Video', channel_id: 'UC1', channel_title: 'Chan1', published_at: '2024-01-03', thumbnail: null, ai_approved: 1, ai_reason: null },
  ]);

  return { family, kid };
}

// --- rateVideo ---

test('rateVideo inserts a new rating', () => {
  const { dir, db } = makeTempDb();
  try {
    const { kid } = setupKidWithVideos(db);

    rateVideo(db, kid.id, 'vid1', 1);

    const row = db.prepare('SELECT * FROM parent_ratings WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid1');
    assert.ok(row, 'rating row should exist');
    assert.equal(row.rating, 1);
  } finally {
    teardown(dir, db);
  }
});

test('rateVideo updates an existing rating (upsert)', () => {
  const { dir, db } = makeTempDb();
  try {
    const { kid } = setupKidWithVideos(db);

    rateVideo(db, kid.id, 'vid1', 1);
    rateVideo(db, kid.id, 'vid1', -1);

    const row = db.prepare('SELECT * FROM parent_ratings WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid1');
    assert.equal(row.rating, -1, 'rating should be updated to -1');

    // Only one row should exist
    const count = db.prepare('SELECT COUNT(*) AS n FROM parent_ratings WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid1').n;
    assert.equal(count, 1, 'should not create duplicates');
  } finally {
    teardown(dir, db);
  }
});

test('rateVideo with -1 sets ai_approved=0 on the video', () => {
  const { dir, db } = makeTempDb();
  try {
    const { kid } = setupKidWithVideos(db);

    // vid1 starts as ai_approved=1
    const before = db.prepare('SELECT ai_approved FROM videos WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid1');
    assert.equal(before.ai_approved, 1);

    rateVideo(db, kid.id, 'vid1', -1);

    const after = db.prepare('SELECT ai_approved FROM videos WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid1');
    assert.equal(after.ai_approved, 0, 'ai_approved should be 0 after thumbs down');
  } finally {
    teardown(dir, db);
  }
});

test('rateVideo with 1 does not change ai_approved', () => {
  const { dir, db } = makeTempDb();
  try {
    const { kid } = setupKidWithVideos(db);

    rateVideo(db, kid.id, 'vid1', 1);

    const row = db.prepare('SELECT ai_approved FROM videos WHERE kid_id = ? AND video_id = ?').get(kid.id, 'vid1');
    assert.equal(row.ai_approved, 1, 'ai_approved should remain 1 for thumbs up');
  } finally {
    teardown(dir, db);
  }
});

test('rateVideo works even if video is not in the videos table', () => {
  const { dir, db } = makeTempDb();
  try {
    const { kid } = setupKidWithVideos(db);

    // Rate a video that does not exist in the videos table
    assert.doesNotThrow(() => rateVideo(db, kid.id, 'nonexistent_vid', 1));

    const row = db.prepare('SELECT * FROM parent_ratings WHERE kid_id = ? AND video_id = ?').get(kid.id, 'nonexistent_vid');
    assert.ok(row, 'rating should still be stored');
    assert.equal(row.rating, 1);
  } finally {
    teardown(dir, db);
  }
});

// --- getParentRatings ---

test('getParentRatings returns a Map of video_id to rating', () => {
  const { dir, db } = makeTempDb();
  try {
    const { kid } = setupKidWithVideos(db);

    rateVideo(db, kid.id, 'vid1', 1);
    rateVideo(db, kid.id, 'vid2', -1);

    const ratings = getParentRatings(db, kid.id);
    assert.ok(ratings instanceof Map, 'should return a Map');
    assert.equal(ratings.get('vid1'), 1);
    assert.equal(ratings.get('vid2'), -1);
    assert.equal(ratings.has('vid3'), false, 'unrated video should not be in map');
  } finally {
    teardown(dir, db);
  }
});

test('getParentRatings returns empty Map when no ratings exist', () => {
  const { dir, db } = makeTempDb();
  try {
    const { kid } = setupKidWithVideos(db);

    const ratings = getParentRatings(db, kid.id);
    assert.ok(ratings instanceof Map);
    assert.equal(ratings.size, 0);
  } finally {
    teardown(dir, db);
  }
});

test('getParentRatings only returns ratings for the specified kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'multi-kid-rate@example.com', 'secret');
    const kid1 = createKid(db, family.id, { name: 'Kid1', age: 8 });
    const kid2 = createKid(db, family.id, { name: 'Kid2', age: 10 });

    upsertVideos(db, kid1.id, [
      { video_id: 'v1', title: 'V1', channel_id: 'UC1', channel_title: 'C1', published_at: null, thumbnail: null, ai_approved: 1, ai_reason: null },
    ]);
    upsertVideos(db, kid2.id, [
      { video_id: 'v1', title: 'V1', channel_id: 'UC1', channel_title: 'C1', published_at: null, thumbnail: null, ai_approved: 1, ai_reason: null },
    ]);

    rateVideo(db, kid1.id, 'v1', 1);
    rateVideo(db, kid2.id, 'v1', -1);

    const ratings1 = getParentRatings(db, kid1.id);
    assert.equal(ratings1.get('v1'), 1);

    const ratings2 = getParentRatings(db, kid2.id);
    assert.equal(ratings2.get('v1'), -1);
  } finally {
    teardown(dir, db);
  }
});
