import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../lib/db.js';
import { getCuratedChannels } from '../lib/family-api.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-curated-test-'));
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

function insertChannel(db, opts) {
  db.prepare(`
    INSERT INTO curated_channels (channel_id, title, description, interests, age_min, age_max, quality, source)
    VALUES (@channel_id, @title, @description, @interests, @age_min, @age_max, @quality, @source)
  `).run({
    description: null,
    quality: 'researched',
    source: 'test',
    ...opts,
    interests: JSON.stringify(opts.interests),
  });
}

// --- getCuratedChannels ---

test('getCuratedChannels returns channels matching a single interest', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, { channel_id: 'UC_SCIENCE', title: 'Science Channel', interests: ['science'], age_min: 5, age_max: 12 });
    insertChannel(db, { channel_id: 'UC_ART', title: 'Art Channel', interests: ['art'], age_min: 5, age_max: 12 });

    const results = getCuratedChannels(db, ['science'], 8);
    assert.equal(results.length, 1);
    assert.equal(results[0].channel_id, 'UC_SCIENCE');
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels returns channels matching any of the given interests', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, { channel_id: 'UC_SCIENCE', title: 'Science Channel', interests: ['science'], age_min: 5, age_max: 12 });
    insertChannel(db, { channel_id: 'UC_GAMING', title: 'Gaming Channel', interests: ['gaming'], age_min: 5, age_max: 12 });
    insertChannel(db, { channel_id: 'UC_ART',    title: 'Art Channel',    interests: ['art'],    age_min: 5, age_max: 12 });

    const results = getCuratedChannels(db, ['science', 'gaming'], 8);
    assert.equal(results.length, 2);
    const ids = results.map(r => r.channel_id).sort();
    assert.deepEqual(ids, ['UC_GAMING', 'UC_SCIENCE']);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels filters out channels outside the age range', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, { channel_id: 'UC_TODDLER',  title: 'Toddler Science', interests: ['science'], age_min: 2,  age_max: 5  });
    insertChannel(db, { channel_id: 'UC_TWEEN',    title: 'Tween Science',   interests: ['science'], age_min: 8,  age_max: 14 });
    insertChannel(db, { channel_id: 'UC_TEEN',     title: 'Teen Science',    interests: ['science'], age_min: 13, age_max: 16 });

    // Age 10 should match tween but not toddler or teen
    const results = getCuratedChannels(db, ['science'], 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].channel_id, 'UC_TWEEN');
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels includes channels whose age range exactly matches the boundary', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, { channel_id: 'UC_EXACT_LOW',  title: 'Exact Low',  interests: ['science'], age_min: 10, age_max: 14 });
    insertChannel(db, { channel_id: 'UC_EXACT_HIGH', title: 'Exact High', interests: ['science'], age_min: 6,  age_max: 10 });
    insertChannel(db, { channel_id: 'UC_OUTSIDE',    title: 'Outside',    interests: ['science'], age_min: 11, age_max: 16 });

    const results = getCuratedChannels(db, ['science'], 10);
    const ids = results.map(r => r.channel_id).sort();
    assert.deepEqual(ids, ['UC_EXACT_HIGH', 'UC_EXACT_LOW']);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels returns empty array for unknown interests', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, { channel_id: 'UC_SCIENCE', title: 'Science Channel', interests: ['science'], age_min: 5, age_max: 12 });

    const results = getCuratedChannels(db, ['interpretive-dance'], 8);
    assert.deepEqual(results, []);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels returns empty array when no channels exist', () => {
  const { dir, db } = makeTempDb();
  try {
    const results = getCuratedChannels(db, ['science'], 8);
    assert.deepEqual(results, []);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels sorts by number of matching interests descending', () => {
  const { dir, db } = makeTempDb();
  try {
    // 1 match
    insertChannel(db, { channel_id: 'UC_ONE',   title: 'One Match',   interests: ['science'],                       age_min: 5, age_max: 16 });
    // 3 matches
    insertChannel(db, { channel_id: 'UC_THREE', title: 'Three Match', interests: ['science', 'gaming', 'math'],      age_min: 5, age_max: 16 });
    // 2 matches
    insertChannel(db, { channel_id: 'UC_TWO',   title: 'Two Match',   interests: ['science', 'gaming'],              age_min: 5, age_max: 16 });
    // 0 matches (art not requested)
    insertChannel(db, { channel_id: 'UC_ZERO',  title: 'Zero Match',  interests: ['art'],                           age_min: 5, age_max: 16 });

    const results = getCuratedChannels(db, ['science', 'gaming', 'math'], 10);
    assert.equal(results.length, 3, 'should exclude zero-match channels');
    assert.equal(results[0].channel_id, 'UC_THREE', 'best match should be first');
    assert.equal(results[0].match_count, 3);
    assert.equal(results[1].channel_id, 'UC_TWO');
    assert.equal(results[1].match_count, 2);
    assert.equal(results[2].channel_id, 'UC_ONE');
    assert.equal(results[2].match_count, 1);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels returns at most 20 results', () => {
  const { dir, db } = makeTempDb();
  try {
    for (let i = 0; i < 25; i++) {
      insertChannel(db, {
        channel_id: `UC_CHANNEL_${i}`,
        title: `Channel ${i}`,
        interests: ['science'],
        age_min: 5,
        age_max: 16,
      });
    }

    const results = getCuratedChannels(db, ['science'], 10);
    assert.equal(results.length, 20);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels returns parsed interests array, not a JSON string', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, { channel_id: 'UC_PARSED', title: 'Parsed', interests: ['science', 'math'], age_min: 5, age_max: 16 });

    const results = getCuratedChannels(db, ['science'], 10);
    assert.equal(results.length, 1);
    assert.ok(Array.isArray(results[0].interests), 'interests should be an array, not a string');
    assert.deepEqual(results[0].interests, ['science', 'math']);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels exposes match_count on each result', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, { channel_id: 'UC_MULTI', title: 'Multi', interests: ['science', 'math', 'gaming'], age_min: 5, age_max: 16 });

    const results = getCuratedChannels(db, ['science', 'math'], 10);
    assert.equal(results[0].match_count, 2);
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels prefers channels where kid age is mid-range over edge-of-range', () => {
  const { dir, db } = makeTempDb();
  try {
    // Both match 1 interest, but "Mid Range" has age 6-12 (kid age 8 is in the middle)
    // while "Edge" has age 3-8 (kid age 8 is at the very top edge)
    insertChannel(db, {
      channel_id: 'UC_MID', title: 'Mid Range',
      interests: ['dance'], age_min: 6, age_max: 12,
    });
    insertChannel(db, {
      channel_id: 'UC_EDGE', title: 'Edge Range',
      interests: ['dance'], age_min: 3, age_max: 8,
    });

    const results = getCuratedChannels(db, ['dance'], 8);
    assert.equal(results.length, 2);
    assert.equal(results[0].channel_id, 'UC_MID', 'mid-range channel should rank first');
    assert.equal(results[1].channel_id, 'UC_EDGE', 'edge-of-range channel should rank second');
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels interest count still takes priority over age fit', () => {
  const { dir, db } = makeTempDb();
  try {
    // 2 interest matches but edge-of-range age
    insertChannel(db, {
      channel_id: 'UC_MORE_INTERESTS', title: 'More Interests',
      interests: ['dance', 'music'], age_min: 3, age_max: 8,
    });
    // 1 interest match but perfect age fit
    insertChannel(db, {
      channel_id: 'UC_BETTER_AGE', title: 'Better Age',
      interests: ['dance'], age_min: 7, age_max: 10,
    });

    const results = getCuratedChannels(db, ['dance', 'music'], 8);
    assert.equal(results[0].channel_id, 'UC_MORE_INTERESTS', 'more interest matches should still win');
  } finally {
    teardown(dir, db);
  }
});

test('getCuratedChannels skips UNRESOLVED channel IDs', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, {
      channel_id: 'UCxxxxREAL', title: 'Real Channel',
      interests: ['science'], age_min: 5, age_max: 12,
    });
    insertChannel(db, {
      channel_id: 'UNRESOLVED-fake', title: 'Fake Channel',
      interests: ['science'], age_min: 5, age_max: 12,
    });

    const results = getCuratedChannels(db, ['science'], 8);
    assert.equal(results.length, 1);
    assert.equal(results[0].channel_id, 'UCxxxxREAL');
  } finally {
    teardown(dir, db);
  }
});
