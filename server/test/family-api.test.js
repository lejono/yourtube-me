import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../lib/db.js';
import { createFamily } from '../lib/auth.js';
import { createKid } from '../lib/kid-token.js';
import {
  addChannel,
  listChannels,
  removeChannel,
  upsertVideos,
  getApprovedVideos,
  getAllChannelsWithKidInfo,
  addPendingChannel,
  approveChannel,
  rejectChannel,
  getPendingChannels,
  addFeedback,
  getUnprocessedFeedback,
  markFeedbackProcessed,
  setKidChannelsStatus,
  getKidChannelsStatus,
} from '../lib/family-api.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-family-api-test-'));
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

// --- addChannel ---

test('addChannel adds a channel for a kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Alice', age: 8 });

    const channel = addChannel(db, kid.id, { channel_id: 'UC123', title: 'Cool Channel' });
    assert.ok(channel.id, 'should return an id');
    assert.equal(channel.channel_id, 'UC123');
    assert.equal(channel.title, 'Cool Channel');
    assert.equal(channel.kid_id, kid.id);

    const row = db.prepare('SELECT * FROM channels WHERE kid_id = ? AND channel_id = ?').get(kid.id, 'UC123');
    assert.ok(row, 'row should exist');
    assert.equal(row.title, 'Cool Channel');
  } finally {
    teardown(dir, db);
  }
});

test('addChannel rejects duplicate channel_id for same kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent2@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Bob' });

    addChannel(db, kid.id, { channel_id: 'UC456', title: 'Channel 1' });
    assert.throws(
      () => addChannel(db, kid.id, { channel_id: 'UC456', title: 'Channel 1 Dupe' }),
      /UNIQUE constraint failed/
    );
  } finally {
    teardown(dir, db);
  }
});

test('addChannel allows same channel_id for different kids', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent3@example.com', 'secret');
    const kid1 = createKid(db, family.id, { name: 'Carol' });
    const kid2 = createKid(db, family.id, { name: 'Dave' });

    assert.doesNotThrow(() => {
      addChannel(db, kid1.id, { channel_id: 'UC789', title: 'Shared Channel' });
      addChannel(db, kid2.id, { channel_id: 'UC789', title: 'Shared Channel' });
    });
  } finally {
    teardown(dir, db);
  }
});

// --- listChannels ---

test('listChannels returns all channels for a kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent4@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Eve' });

    addChannel(db, kid.id, { channel_id: 'UC001', title: 'Channel A' });
    addChannel(db, kid.id, { channel_id: 'UC002', title: 'Channel B' });
    addChannel(db, kid.id, { channel_id: 'UC003', title: 'Channel C' });

    const channels = listChannels(db, kid.id);
    assert.equal(channels.length, 3);
    const ids = channels.map(c => c.channel_id).sort();
    assert.deepEqual(ids, ['UC001', 'UC002', 'UC003']);
  } finally {
    teardown(dir, db);
  }
});

test('listChannels returns empty array for kid with no channels', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent5@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Frank' });

    const channels = listChannels(db, kid.id);
    assert.deepEqual(channels, []);
  } finally {
    teardown(dir, db);
  }
});

test('listChannels does not return channels from other kids', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent6@example.com', 'secret');
    const kid1 = createKid(db, family.id, { name: 'Grace' });
    const kid2 = createKid(db, family.id, { name: 'Hank' });

    addChannel(db, kid1.id, { channel_id: 'UC_GRACE', title: 'Grace Channel' });
    addChannel(db, kid2.id, { channel_id: 'UC_HANK', title: 'Hank Channel' });

    const channels = listChannels(db, kid1.id);
    assert.equal(channels.length, 1);
    assert.equal(channels[0].channel_id, 'UC_GRACE');
  } finally {
    teardown(dir, db);
  }
});

// --- removeChannel ---

test('removeChannel removes the channel record', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent7@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Iris' });

    addChannel(db, kid.id, { channel_id: 'UC_REMOVE', title: 'To Remove' });
    removeChannel(db, kid.id, 'UC_REMOVE');

    const row = db.prepare('SELECT * FROM channels WHERE kid_id = ? AND channel_id = ?').get(kid.id, 'UC_REMOVE');
    assert.equal(row, undefined, 'channel should be removed');
  } finally {
    teardown(dir, db);
  }
});

test('removeChannel also removes associated videos for that channel', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent8@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Jake' });

    addChannel(db, kid.id, { channel_id: 'UC_VID', title: 'Video Channel' });
    upsertVideos(db, kid.id, [
      { video_id: 'vid1', title: 'Video 1', channel_id: 'UC_VID', channel_title: 'Video Channel', published_at: '2024-01-01', thumbnail: null, ai_approved: 1, ai_reason: null },
      { video_id: 'vid2', title: 'Video 2', channel_id: 'UC_VID', channel_title: 'Video Channel', published_at: '2024-01-02', thumbnail: null, ai_approved: 1, ai_reason: null },
    ]);

    // Confirm videos exist
    const before = db.prepare('SELECT * FROM videos WHERE kid_id = ? AND channel_id = ?').all(kid.id, 'UC_VID');
    assert.equal(before.length, 2);

    removeChannel(db, kid.id, 'UC_VID');

    const after = db.prepare('SELECT * FROM videos WHERE kid_id = ? AND channel_id = ?').all(kid.id, 'UC_VID');
    assert.equal(after.length, 0, 'videos should be removed with channel');
  } finally {
    teardown(dir, db);
  }
});

// --- upsertVideos ---

test('upsertVideos inserts new videos', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent9@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Karen' });

    upsertVideos(db, kid.id, [
      { video_id: 'v1', title: 'Vid 1', channel_id: 'UC_K', channel_title: 'K Chan', published_at: '2024-01-01', thumbnail: 'http://thumb1', ai_approved: 1, ai_reason: 'looks fine' },
      { video_id: 'v2', title: 'Vid 2', channel_id: 'UC_K', channel_title: 'K Chan', published_at: '2024-01-02', thumbnail: null, ai_approved: 0, ai_reason: 'too scary' },
    ]);

    const rows = db.prepare('SELECT * FROM videos WHERE kid_id = ?').all(kid.id);
    assert.equal(rows.length, 2);
  } finally {
    teardown(dir, db);
  }
});

test('upsertVideos updates existing videos on conflict', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent10@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Liam' });

    upsertVideos(db, kid.id, [
      { video_id: 'v_upsert', title: 'Original Title', channel_id: 'UC_L', channel_title: 'L Chan', published_at: '2024-01-01', thumbnail: null, ai_approved: 1, ai_reason: null },
    ]);

    // Upsert same video_id with updated fields
    upsertVideos(db, kid.id, [
      { video_id: 'v_upsert', title: 'Updated Title', channel_id: 'UC_L', channel_title: 'L Chan', published_at: '2024-01-01', thumbnail: 'http://new-thumb', ai_approved: 0, ai_reason: 'updated reason' },
    ]);

    const rows = db.prepare('SELECT * FROM videos WHERE kid_id = ? AND video_id = ?').all(kid.id, 'v_upsert');
    assert.equal(rows.length, 1, 'should not create duplicate');
    assert.equal(rows[0].title, 'Updated Title');
    assert.equal(rows[0].ai_approved, 0);
    assert.equal(rows[0].ai_reason, 'updated reason');
    assert.equal(rows[0].thumbnail, 'http://new-thumb');
  } finally {
    teardown(dir, db);
  }
});

test('upsertVideos updates last_pushed_at on the kid record', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent11@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Mia' });

    const before = db.prepare('SELECT last_pushed_at FROM kids WHERE id = ?').get(kid.id);
    assert.equal(before.last_pushed_at, null, 'last_pushed_at should start null');

    upsertVideos(db, kid.id, [
      { video_id: 'v_push', title: 'Push Video', channel_id: 'UC_M', channel_title: 'M Chan', published_at: '2024-01-01', thumbnail: null, ai_approved: 1, ai_reason: null },
    ]);

    const after = db.prepare('SELECT last_pushed_at FROM kids WHERE id = ?').get(kid.id);
    assert.ok(after.last_pushed_at, 'last_pushed_at should be set after upsert');
  } finally {
    teardown(dir, db);
  }
});

test('upsertVideos handles empty array gracefully', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent12@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Noah' });

    assert.doesNotThrow(() => upsertVideos(db, kid.id, []));
  } finally {
    teardown(dir, db);
  }
});

// --- getApprovedVideos ---

test('getApprovedVideos returns only ai_approved=1 videos', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent13@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Olivia' });

    upsertVideos(db, kid.id, [
      { video_id: 'approved1', title: 'Approved 1', channel_id: 'UC_O', channel_title: 'O Chan', published_at: '2024-01-03', thumbnail: null, ai_approved: 1, ai_reason: null },
      { video_id: 'approved2', title: 'Approved 2', channel_id: 'UC_O', channel_title: 'O Chan', published_at: '2024-01-02', thumbnail: null, ai_approved: 1, ai_reason: null },
      { video_id: 'rejected1', title: 'Rejected 1', channel_id: 'UC_O', channel_title: 'O Chan', published_at: '2024-01-01', thumbnail: null, ai_approved: 0, ai_reason: 'bad' },
    ]);

    const videos = getApprovedVideos(db, kid.id);
    assert.equal(videos.length, 2);
    assert.ok(videos.every(v => v.ai_approved === 1), 'all returned videos should be approved');
  } finally {
    teardown(dir, db);
  }
});

test('getApprovedVideos returns videos sorted by published_at DESC', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent14@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Pete' });

    upsertVideos(db, kid.id, [
      { video_id: 'old', title: 'Old Video', channel_id: 'UC_P', channel_title: 'P Chan', published_at: '2023-01-01', thumbnail: null, ai_approved: 1, ai_reason: null },
      { video_id: 'new', title: 'New Video', channel_id: 'UC_P', channel_title: 'P Chan', published_at: '2024-06-01', thumbnail: null, ai_approved: 1, ai_reason: null },
      { video_id: 'mid', title: 'Mid Video', channel_id: 'UC_P', channel_title: 'P Chan', published_at: '2023-12-01', thumbnail: null, ai_approved: 1, ai_reason: null },
    ]);

    const videos = getApprovedVideos(db, kid.id);
    assert.equal(videos[0].video_id, 'new');
    assert.equal(videos[1].video_id, 'mid');
    assert.equal(videos[2].video_id, 'old');
  } finally {
    teardown(dir, db);
  }
});

test('getApprovedVideos returns empty array when no approved videos exist', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent15@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Quinn' });

    upsertVideos(db, kid.id, [
      { video_id: 'r1', title: 'Rejected', channel_id: 'UC_Q', channel_title: 'Q Chan', published_at: '2024-01-01', thumbnail: null, ai_approved: 0, ai_reason: 'nope' },
    ]);

    const videos = getApprovedVideos(db, kid.id);
    assert.deepEqual(videos, []);
  } finally {
    teardown(dir, db);
  }
});

// --- getAllChannelsWithKidInfo ---

test('getAllChannelsWithKidInfo returns channels joined with kid and family info', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent16@example.com', 'secret');
    const kid1 = createKid(db, family.id, { name: 'Rose', age: 9 });
    db.prepare('UPDATE kids SET interests = ? WHERE id = ?').run(JSON.stringify(['gaming', 'art']), kid1.id);
    const kid2 = createKid(db, family.id, { name: 'Sam', age: 11 });

    addChannel(db, kid1.id, { channel_id: 'UC_R1', title: 'Rose Chan 1' });
    addChannel(db, kid1.id, { channel_id: 'UC_R2', title: 'Rose Chan 2' });
    addChannel(db, kid2.id, { channel_id: 'UC_S1', title: 'Sam Chan 1' });

    const rows = getAllChannelsWithKidInfo(db);
    assert.equal(rows.length, 3);

    // Each row should have channel + kid info
    const roseChannels = rows.filter(r => r.kid_id === kid1.id);
    assert.equal(roseChannels.length, 2);
    assert.ok(roseChannels[0].kid_name === 'Rose');
    assert.ok(roseChannels[0].family_id === family.id);

    const samChannels = rows.filter(r => r.kid_id === kid2.id);
    assert.equal(samChannels.length, 1);
    assert.equal(samChannels[0].channel_id, 'UC_S1');
  } finally {
    teardown(dir, db);
  }
});

test('getAllChannelsWithKidInfo returns channels_generated flag from kids table', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent17@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Tess' });

    addChannel(db, kid.id, { channel_id: 'UC_T', title: 'Tess Chan' });

    // Default channels_generated should be 0
    const rows = getAllChannelsWithKidInfo(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channels_generated, 0);

    // Update to 1
    db.prepare('UPDATE kids SET channels_generated = 1 WHERE id = ?').run(kid.id);
    const rows2 = getAllChannelsWithKidInfo(db);
    assert.equal(rows2[0].channels_generated, 1);
  } finally {
    teardown(dir, db);
  }
});

test('getAllChannelsWithKidInfo returns empty array when no channels exist', () => {
  const { dir, db } = makeTempDb();
  try {
    const rows = getAllChannelsWithKidInfo(db);
    assert.deepEqual(rows, []);
  } finally {
    teardown(dir, db);
  }
});

// --- addChannel with status/source/reason params ---

test('addChannel defaults to status=approved, source=manual, reason=null', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'statusdefault@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Alice' });

    addChannel(db, kid.id, { channel_id: 'UC_DEF', title: 'Default Status Chan' });
    const row = db.prepare('SELECT * FROM channels WHERE kid_id = ? AND channel_id = ?').get(kid.id, 'UC_DEF');
    assert.equal(row.status, 'approved');
    assert.equal(row.source, 'manual');
    assert.equal(row.reason, null);
  } finally {
    teardown(dir, db);
  }
});

test('addChannel accepts optional status, source, reason params', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'statuscustom@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Bob' });

    addChannel(db, kid.id, { channel_id: 'UC_CUST', title: 'Custom Status Chan', status: 'pending', source: 'opus', reason: 'kid requested it' });
    const row = db.prepare('SELECT * FROM channels WHERE kid_id = ? AND channel_id = ?').get(kid.id, 'UC_CUST');
    assert.equal(row.status, 'pending');
    assert.equal(row.source, 'opus');
    assert.equal(row.reason, 'kid requested it');
  } finally {
    teardown(dir, db);
  }
});

// --- listChannels with status filter ---

test('listChannels returns all channels when no status filter given', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'listall@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Carol' });

    addChannel(db, kid.id, { channel_id: 'UC_APP', title: 'Approved', status: 'approved' });
    addChannel(db, kid.id, { channel_id: 'UC_PND', title: 'Pending', status: 'pending' });
    addChannel(db, kid.id, { channel_id: 'UC_REJ', title: 'Rejected', status: 'rejected' });

    const all = listChannels(db, kid.id);
    assert.equal(all.length, 3);
  } finally {
    teardown(dir, db);
  }
});

test('listChannels filters by status when opts.status provided', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'listfilter@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Dave' });

    addChannel(db, kid.id, { channel_id: 'UC_APP', title: 'Approved', status: 'approved' });
    addChannel(db, kid.id, { channel_id: 'UC_PND', title: 'Pending', status: 'pending' });
    addChannel(db, kid.id, { channel_id: 'UC_REJ', title: 'Rejected', status: 'rejected' });

    const pending = listChannels(db, kid.id, { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].channel_id, 'UC_PND');

    const approved = listChannels(db, kid.id, { status: 'approved' });
    assert.equal(approved.length, 1);
    assert.equal(approved[0].channel_id, 'UC_APP');
  } finally {
    teardown(dir, db);
  }
});

// --- addPendingChannel ---

test('addPendingChannel inserts channel with status=pending and source=opus', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'pending@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Eve' });

    const ch = addPendingChannel(db, kid.id, { channel_id: 'UC_PEND', title: 'Pending Chan', reason: 'auto suggestion', thumbnail: null });
    assert.ok(ch.id);
    assert.equal(ch.channel_id, 'UC_PEND');

    const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(ch.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.source, 'opus');
    assert.equal(row.reason, 'auto suggestion');
  } finally {
    teardown(dir, db);
  }
});

// --- approveChannel ---

test('approveChannel sets status to approved', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'approve@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Frank' });

    addPendingChannel(db, kid.id, { channel_id: 'UC_APP2', title: 'To Approve', reason: null, thumbnail: null });
    approveChannel(db, kid.id, 'UC_APP2');

    const row = db.prepare('SELECT * FROM channels WHERE kid_id = ? AND channel_id = ?').get(kid.id, 'UC_APP2');
    assert.equal(row.status, 'approved');
  } finally {
    teardown(dir, db);
  }
});

// --- rejectChannel ---

test('rejectChannel sets status to rejected', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'reject@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Grace' });

    addPendingChannel(db, kid.id, { channel_id: 'UC_REJ2', title: 'To Reject', reason: null, thumbnail: null });
    rejectChannel(db, kid.id, 'UC_REJ2');

    const row = db.prepare('SELECT * FROM channels WHERE kid_id = ? AND channel_id = ?').get(kid.id, 'UC_REJ2');
    assert.equal(row.status, 'rejected');
  } finally {
    teardown(dir, db);
  }
});

// --- getPendingChannels ---

test('getPendingChannels returns only channels with status=pending', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'getpending@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Hank' });

    addChannel(db, kid.id, { channel_id: 'UC_A', title: 'Approved' });
    addPendingChannel(db, kid.id, { channel_id: 'UC_P1', title: 'Pending 1', reason: null, thumbnail: null });
    addPendingChannel(db, kid.id, { channel_id: 'UC_P2', title: 'Pending 2', reason: null, thumbnail: null });

    const pending = getPendingChannels(db, kid.id);
    assert.equal(pending.length, 2);
    assert.ok(pending.every(c => c.status === 'pending'));
  } finally {
    teardown(dir, db);
  }
});

test('getPendingChannels returns empty array when none pending', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'nopending@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Iris' });

    addChannel(db, kid.id, { channel_id: 'UC_A', title: 'Approved' });

    const pending = getPendingChannels(db, kid.id);
    assert.deepEqual(pending, []);
  } finally {
    teardown(dir, db);
  }
});

// --- addFeedback ---

test('addFeedback inserts a feedback row for kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'feedback@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Jake' });

    const fb = addFeedback(db, kid.id, 'I want more Minecraft channels');
    assert.ok(fb.id);
    assert.equal(fb.kid_id, kid.id);
    assert.equal(fb.message, 'I want more Minecraft channels');

    const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(fb.id);
    assert.equal(row.processed, 0);
    assert.equal(row.message, 'I want more Minecraft channels');
  } finally {
    teardown(dir, db);
  }
});

// --- getUnprocessedFeedback ---

test('getUnprocessedFeedback returns only unprocessed rows', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'unfeedback@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Karen' });

    const fb1 = addFeedback(db, kid.id, 'More gaming');
    const fb2 = addFeedback(db, kid.id, 'Less cooking');
    addFeedback(db, kid.id, 'Already processed');

    // Manually mark the third as processed
    db.prepare('UPDATE feedback SET processed = 1 WHERE id = ?').run(
      db.prepare('SELECT id FROM feedback WHERE message = ?').get('Already processed').id
    );

    const unprocessed = getUnprocessedFeedback(db, kid.id);
    assert.equal(unprocessed.length, 2);
    const msgs = unprocessed.map(r => r.message).sort();
    assert.deepEqual(msgs, ['Less cooking', 'More gaming']);
  } finally {
    teardown(dir, db);
  }
});

// --- markFeedbackProcessed ---

test('markFeedbackProcessed sets processed=1', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'markfb@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Liam' });

    const fb = addFeedback(db, kid.id, 'Some feedback');
    assert.equal(fb.processed, 0);

    markFeedbackProcessed(db, fb.id);

    const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(fb.id);
    assert.equal(row.processed, 1);
  } finally {
    teardown(dir, db);
  }
});

// --- setKidChannelsStatus / getKidChannelsStatus ---

test('getKidChannelsStatus returns idle by default', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'kidstatus@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Mia' });

    const status = getKidChannelsStatus(db, kid.id);
    assert.equal(status, 'idle');
  } finally {
    teardown(dir, db);
  }
});

test('setKidChannelsStatus updates channels_status', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'setstatus@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Noah' });

    setKidChannelsStatus(db, kid.id, 'generating');
    assert.equal(getKidChannelsStatus(db, kid.id), 'generating');

    setKidChannelsStatus(db, kid.id, 'ready');
    assert.equal(getKidChannelsStatus(db, kid.id), 'ready');

    setKidChannelsStatus(db, kid.id, 'idle');
    assert.equal(getKidChannelsStatus(db, kid.id), 'idle');
  } finally {
    teardown(dir, db);
  }
});
