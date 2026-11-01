import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../lib/db.js';
import { createFamily } from '../lib/auth.js';
import { createKid } from '../lib/kid-token.js';
import { getCuratedVideos, getApprovedVideos } from '../lib/family-api.js';
import { injectCuratedVideos } from '../lib/family-api.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-curated-videos-test-'));
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

function insertVideo(db, opts) {
  db.prepare(`
    INSERT INTO curated_videos (video_id, title, channel_title, description, interests, age_min, age_max, source)
    VALUES (@video_id, @title, @channel_title, @description, @interests, @age_min, @age_max, @source)
  `).run({
    channel_title: null,
    description: null,
    source: 'curated',
    ...opts,
    interests: JSON.stringify(opts.interests),
  });
}

// --- getCuratedVideos ---

test('getCuratedVideos returns videos matching a single interest', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_sci', title: 'Science Vid', interests: ['science'], age_min: 5, age_max: 12 });
    insertVideo(db, { video_id: 'v_art', title: 'Art Vid', interests: ['art'], age_min: 5, age_max: 12 });

    const results = getCuratedVideos(db, ['science'], 8);
    assert.equal(results.length, 1);
    assert.equal(results[0].video_id, 'v_sci');
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos returns videos matching any of the given interests', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_sci', title: 'Science Vid', interests: ['science'], age_min: 5, age_max: 12 });
    insertVideo(db, { video_id: 'v_game', title: 'Gaming Vid', interests: ['gaming'], age_min: 5, age_max: 12 });
    insertVideo(db, { video_id: 'v_art', title: 'Art Vid', interests: ['art'], age_min: 5, age_max: 12 });

    const results = getCuratedVideos(db, ['science', 'gaming'], 8);
    assert.equal(results.length, 2);
    const ids = results.map(r => r.video_id).sort();
    assert.deepEqual(ids, ['v_game', 'v_sci']);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos filters out videos outside the age range', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_toddler', title: 'Toddler Science', interests: ['science'], age_min: 2, age_max: 5 });
    insertVideo(db, { video_id: 'v_tween', title: 'Tween Science', interests: ['science'], age_min: 8, age_max: 14 });
    insertVideo(db, { video_id: 'v_teen', title: 'Teen Science', interests: ['science'], age_min: 13, age_max: 16 });

    // Age 10 should match tween but not toddler or teen
    const results = getCuratedVideos(db, ['science'], 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].video_id, 'v_tween');
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos includes videos whose age range exactly matches the boundary', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_low', title: 'Exact Low', interests: ['science'], age_min: 10, age_max: 14 });
    insertVideo(db, { video_id: 'v_high', title: 'Exact High', interests: ['science'], age_min: 6, age_max: 10 });
    insertVideo(db, { video_id: 'v_out', title: 'Outside', interests: ['science'], age_min: 11, age_max: 16 });

    const results = getCuratedVideos(db, ['science'], 10);
    const ids = results.map(r => r.video_id).sort();
    assert.deepEqual(ids, ['v_high', 'v_low']);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos returns empty array for unknown interests', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_sci', title: 'Science Vid', interests: ['science'], age_min: 5, age_max: 12 });

    const results = getCuratedVideos(db, ['interpretive-dance'], 8);
    assert.deepEqual(results, []);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos returns empty array when no videos exist', () => {
  const { dir, db } = makeTempDb();
  try {
    const results = getCuratedVideos(db, ['science'], 8);
    assert.deepEqual(results, []);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos sorts by number of matching interests descending', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_one', title: 'One Match', interests: ['science'], age_min: 5, age_max: 16 });
    insertVideo(db, { video_id: 'v_three', title: 'Three Match', interests: ['science', 'gaming', 'math'], age_min: 5, age_max: 16 });
    insertVideo(db, { video_id: 'v_two', title: 'Two Match', interests: ['science', 'gaming'], age_min: 5, age_max: 16 });
    insertVideo(db, { video_id: 'v_zero', title: 'Zero Match', interests: ['art'], age_min: 5, age_max: 16 });

    const results = getCuratedVideos(db, ['science', 'gaming', 'math'], 10);
    assert.equal(results.length, 3, 'should exclude zero-match videos');
    assert.equal(results[0].video_id, 'v_three', 'best match should be first');
    assert.equal(results[0].match_count, 3);
    assert.equal(results[1].video_id, 'v_two');
    assert.equal(results[1].match_count, 2);
    assert.equal(results[2].video_id, 'v_one');
    assert.equal(results[2].match_count, 1);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos returns parsed interests array, not a JSON string', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_parsed', title: 'Parsed', interests: ['science', 'math'], age_min: 5, age_max: 16 });

    const results = getCuratedVideos(db, ['science'], 10);
    assert.equal(results.length, 1);
    assert.ok(Array.isArray(results[0].interests), 'interests should be an array, not a string');
    assert.deepEqual(results[0].interests, ['science', 'math']);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedVideos exposes match_count on each result', () => {
  const { dir, db } = makeTempDb();
  try {
    insertVideo(db, { video_id: 'v_multi', title: 'Multi', interests: ['science', 'math', 'gaming'], age_min: 5, age_max: 16 });

    const results = getCuratedVideos(db, ['science', 'math'], 10);
    assert.equal(results[0].match_count, 2);
  } finally {
    teardown(dir, db);
  }
});

// --- injectCuratedVideos ---

test('injectCuratedVideos inserts matching curated videos as approved for a kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'inject@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Alice', age: 10, interests: ['science', 'engineering'] });

    insertVideo(db, { video_id: 'v_sci', title: 'Science Vid', channel_title: 'Science Chan', interests: ['science'], age_min: 5, age_max: 12 });
    insertVideo(db, { video_id: 'v_eng', title: 'Engineering Vid', channel_title: 'Eng Chan', interests: ['engineering'], age_min: 8, age_max: 14 });
    insertVideo(db, { video_id: 'v_art', title: 'Art Vid', channel_title: 'Art Chan', interests: ['art'], age_min: 5, age_max: 12 });

    const count = injectCuratedVideos(db, kid.id, ['science', 'engineering'], 10);
    assert.equal(count, 2, 'should inject 2 matching videos');

    const approved = getApprovedVideos(db, kid.id);
    assert.equal(approved.length, 2);
    const ids = approved.map(v => v.video_id).sort();
    assert.deepEqual(ids, ['v_eng', 'v_sci']);

    // Verify they are marked as approved with hand-picked reason
    for (const v of approved) {
      assert.equal(v.ai_approved, 1);
      assert.equal(v.ai_reason, 'Hand-picked');
    }
  } finally {
    teardown(dir, db);
  }
});

test('injectCuratedVideos returns 0 when no curated videos match', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'nomatch@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Bob', age: 10, interests: ['gaming'] });

    insertVideo(db, { video_id: 'v_art', title: 'Art Vid', channel_title: 'Art Chan', interests: ['art'], age_min: 5, age_max: 12 });

    const count = injectCuratedVideos(db, kid.id, ['gaming'], 10);
    assert.equal(count, 0);

    const approved = getApprovedVideos(db, kid.id);
    assert.equal(approved.length, 0);
  } finally {
    teardown(dir, db);
  }
});

test('injectCuratedVideos does not duplicate videos on repeated calls', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'nodup@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Carol', age: 8, interests: ['science'] });

    insertVideo(db, { video_id: 'v_sci', title: 'Science Vid', channel_title: 'Science Chan', interests: ['science'], age_min: 5, age_max: 12 });

    injectCuratedVideos(db, kid.id, ['science'], 8);
    // Call again - should not crash or duplicate
    const count = injectCuratedVideos(db, kid.id, ['science'], 8);
    assert.equal(count, 1, 'should still report 1 (upsert)');

    const approved = getApprovedVideos(db, kid.id);
    assert.equal(approved.length, 1, 'should not duplicate');
  } finally {
    teardown(dir, db);
  }
});

test('injectCuratedVideos skips videos with no matching interests', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'no-match@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'NoMatchKid' });

    insertVideo(db, {
      video_id: 'v_sci', title: 'Science Vid',
      interests: ['science'], age_min: 5, age_max: 12,
    });
    insertVideo(db, {
      video_id: 'v_chess', title: 'Chess Vid',
      interests: ['chess'], age_min: 5, age_max: 12,
    });

    // Kid only likes dance — neither video should be injected
    const count = injectCuratedVideos(db, kid.id, ['dance'], 8);
    assert.equal(count, 0);

    const videos = db.prepare('SELECT * FROM videos WHERE kid_id = ?').all(kid.id);
    assert.equal(videos.length, 0);
  } finally {
    teardown(dir, db);
  }
});
