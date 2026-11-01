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
import { getKidFeed } from '../lib/feed-api.js';
import { recordWatch, toggleLike } from '../lib/kid-activity.js';

// --- helpers ---

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yourtube-feed-api-test-'));
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

// --- getKidFeed ---

test('getKidFeed returns only approved videos (20 approved + 5 rejected = 20 in feed)', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Alice', age: 8 });
    addChannel(db, kid.id, { channel_id: 'UC_TEST', title: 'Test Channel' });

    const approved = Array.from({ length: 20 }, (_, i) =>
      makeVideo({ video_id: `approved_${i}`, ai_approved: 1, published_at: `2024-01-${String(i + 1).padStart(2, '0')}` })
    );
    const rejected = Array.from({ length: 5 }, (_, i) =>
      makeVideo({ video_id: `rejected_${i}`, ai_approved: 0 })
    );

    upsertVideos(db, kid.id, [...approved, ...rejected]);

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 20, 'should return only the 20 approved videos');
    assert.ok(feed.videos.every(v => v.ai_approved === 1), 'all returned videos should be approved');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed includes channel list for kid', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent2@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Bob' });

    addChannel(db, kid.id, { channel_id: 'UC_A', title: 'Channel A' });
    addChannel(db, kid.id, { channel_id: 'UC_B', title: 'Channel B' });

    const feed = getKidFeed(db, kid.id, {});
    assert.ok(Array.isArray(feed.channels), 'channels should be an array');
    assert.equal(feed.channels.length, 2);
    const channelIds = feed.channels.map(c => c.channel_id).sort();
    assert.deepEqual(channelIds, ['UC_A', 'UC_B']);
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed includes kid_name in response', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent3@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Carol', age: 10 });

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.kid_name, 'Carol');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed filters by channel_id when param provided', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent4@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Dave' });

    addChannel(db, kid.id, { channel_id: 'UC_X', title: 'Channel X' });
    addChannel(db, kid.id, { channel_id: 'UC_Y', title: 'Channel Y' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'vx1', channel_id: 'UC_X', channel_title: 'Channel X', ai_approved: 1 }),
      makeVideo({ video_id: 'vx2', channel_id: 'UC_X', channel_title: 'Channel X', ai_approved: 1 }),
      makeVideo({ video_id: 'vy1', channel_id: 'UC_Y', channel_title: 'Channel Y', ai_approved: 1 }),
    ]);

    const feed = getKidFeed(db, kid.id, { channel: 'UC_X' });
    assert.equal(feed.videos.length, 2);
    assert.ok(feed.videos.every(v => v.channel_id === 'UC_X'), 'should only return UC_X videos');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed respects limit param', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent5@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Eve' });
    addChannel(db, kid.id, { channel_id: 'UC_E', title: 'Eve Chan' });

    const videos = Array.from({ length: 15 }, (_, i) =>
      makeVideo({ video_id: `ev_${i}`, channel_id: 'UC_E', channel_title: 'Eve Chan', ai_approved: 1, published_at: `2024-01-${String(i + 1).padStart(2, '0')}` })
    );
    upsertVideos(db, kid.id, videos);

    const feed = getKidFeed(db, kid.id, { limit: 5 });
    assert.equal(feed.videos.length, 5);
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed returns videos sorted by published_at DESC', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent6@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Frank' });
    addChannel(db, kid.id, { channel_id: 'UC_F', title: 'Frank Chan' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'old', channel_id: 'UC_F', channel_title: 'Frank Chan', published_at: '2022-01-01', ai_approved: 1 }),
      makeVideo({ video_id: 'newest', channel_id: 'UC_F', channel_title: 'Frank Chan', published_at: '2024-12-01', ai_approved: 1 }),
      makeVideo({ video_id: 'middle', channel_id: 'UC_F', channel_title: 'Frank Chan', published_at: '2023-06-01', ai_approved: 1 }),
    ]);

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos[0].video_id, 'newest');
    assert.equal(feed.videos[1].video_id, 'middle');
    assert.equal(feed.videos[2].video_id, 'old');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed returns empty videos array for kid with no approved videos', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent7@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Grace' });

    const feed = getKidFeed(db, kid.id, {});
    assert.deepEqual(feed.videos, []);
    assert.deepEqual(feed.channels, []);
    assert.equal(feed.kid_name, 'Grace');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed channel filter + limit work together', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'parent8@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Hank' });
    addChannel(db, kid.id, { channel_id: 'UC_H', title: 'Hank Chan' });
    addChannel(db, kid.id, { channel_id: 'UC_I', title: 'Other Chan' });

    const hankVids = Array.from({ length: 10 }, (_, i) =>
      makeVideo({ video_id: `hv_${i}`, channel_id: 'UC_H', channel_title: 'Hank Chan', ai_approved: 1, published_at: `2024-01-${String(i + 1).padStart(2, '0')}` })
    );
    const otherVids = Array.from({ length: 5 }, (_, i) =>
      makeVideo({ video_id: `ov_${i}`, channel_id: 'UC_I', channel_title: 'Other Chan', ai_approved: 1 })
    );

    upsertVideos(db, kid.id, [...hankVids, ...otherVids]);

    const feed = getKidFeed(db, kid.id, { channel: 'UC_H', limit: 3 });
    assert.equal(feed.videos.length, 3);
    assert.ok(feed.videos.every(v => v.channel_id === 'UC_H'));
  } finally {
    teardown(dir, db);
  }
});

// --- feed channel list only includes status='approved' channels ---

test('getKidFeed channel list excludes pending and rejected channels', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'feedstatus@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Iris' });

    // approved via default addChannel
    addChannel(db, kid.id, { channel_id: 'UC_APP', title: 'Approved' });
    // pending channel
    addChannel(db, kid.id, { channel_id: 'UC_PND', title: 'Pending', status: 'pending' });
    // rejected channel
    addChannel(db, kid.id, { channel_id: 'UC_REJ', title: 'Rejected', status: 'rejected' });

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.channels.length, 1, 'only approved channel should appear');
    assert.equal(feed.channels[0].channel_id, 'UC_APP');
  } finally {
    teardown(dir, db);
  }
});

// --- videos from rejected channels are excluded from feed ---

test('getKidFeed excludes approved videos from parent-rejected channels', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'rejected-vids@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'Sam' });

    addChannel(db, kid.id, { channel_id: 'UC_GOOD', title: 'Good Channel' });
    addChannel(db, kid.id, { channel_id: 'UC_BAD', title: 'Bad Channel', status: 'rejected' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'good1', channel_id: 'UC_GOOD', channel_title: 'Good Channel', ai_approved: 1 }),
      makeVideo({ video_id: 'good2', channel_id: 'UC_GOOD', channel_title: 'Good Channel', ai_approved: 1 }),
      makeVideo({ video_id: 'bad1', channel_id: 'UC_BAD', channel_title: 'Bad Channel', ai_approved: 1 }),
      makeVideo({ video_id: 'bad2', channel_id: 'UC_BAD', channel_title: 'Bad Channel', ai_approved: 1 }),
    ]);

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 2, 'should only return videos from non-rejected channels');
    assert.ok(feed.videos.every(v => v.channel_id === 'UC_GOOD'), 'all videos should be from good channel');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed excludes watched videos from rejected channels too', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'rejected-watched@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'TestKid' });

    addChannel(db, kid.id, { channel_id: 'UC_OK', title: 'OK Channel' });
    addChannel(db, kid.id, { channel_id: 'UC_NOPE', title: 'Nope Channel', status: 'rejected' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'ok1', channel_id: 'UC_OK', channel_title: 'OK Channel', ai_approved: 1, published_at: '2024-01-01' }),
      makeVideo({ video_id: 'nope1', channel_id: 'UC_NOPE', channel_title: 'Nope Channel', ai_approved: 1, published_at: '2024-01-02' }),
    ]);

    // Watch both
    recordWatch(db, kid.id, 'ok1');
    recordWatch(db, kid.id, 'nope1');

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 1, 'watched video from rejected channel should still be excluded');
    assert.equal(feed.videos[0].video_id, 'ok1');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed excludes videos from pending channels', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'pending-vids@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'PendingKid' });

    addChannel(db, kid.id, { channel_id: 'UC_OK', title: 'Approved Chan' });
    addChannel(db, kid.id, { channel_id: 'UC_PEND', title: 'Pending Chan', status: 'pending' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'ok1', channel_id: 'UC_OK', channel_title: 'Approved Chan', ai_approved: 1 }),
      makeVideo({ video_id: 'pend1', channel_id: 'UC_PEND', channel_title: 'Pending Chan', ai_approved: 1 }),
    ]);

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 1, 'only approved-channel videos should appear');
    assert.equal(feed.videos[0].video_id, 'ok1');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed shows pending channel videos after channel is approved', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'approve-pending@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'ApproveKid' });

    addChannel(db, kid.id, { channel_id: 'UC_P', title: 'Was Pending', status: 'pending' });
    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'p1', channel_id: 'UC_P', channel_title: 'Was Pending', ai_approved: 1 }),
    ]);

    let feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 0);

    db.prepare("UPDATE channels SET status = 'approved' WHERE kid_id = ? AND channel_id = ?").run(kid.id, 'UC_P');
    feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 1);
    assert.equal(feed.videos[0].video_id, 'p1');
  } finally {
    teardown(dir, db);
  }
});

// --- watched_video_ids and liked_video_ids in feed ---

test('getKidFeed includes watched_video_ids array', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'watched-feed@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'WatchKid' });
    addChannel(db, kid.id, { channel_id: 'UC_W', title: 'Watch Chan' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'w1', channel_id: 'UC_W', channel_title: 'Watch Chan', ai_approved: 1 }),
      makeVideo({ video_id: 'w2', channel_id: 'UC_W', channel_title: 'Watch Chan', ai_approved: 1 }),
      makeVideo({ video_id: 'w3', channel_id: 'UC_W', channel_title: 'Watch Chan', ai_approved: 1 }),
    ]);

    recordWatch(db, kid.id, 'w1');
    recordWatch(db, kid.id, 'w3');

    const feed = getKidFeed(db, kid.id, {});
    assert.ok(Array.isArray(feed.watched_video_ids), 'should have watched_video_ids');
    assert.equal(feed.watched_video_ids.length, 2);
    assert.ok(feed.watched_video_ids.includes('w1'));
    assert.ok(feed.watched_video_ids.includes('w3'));
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed includes liked_video_ids array', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'liked-feed@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'LikeKid' });
    addChannel(db, kid.id, { channel_id: 'UC_L', title: 'Like Chan' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'l1', channel_id: 'UC_L', channel_title: 'Like Chan', ai_approved: 1 }),
      makeVideo({ video_id: 'l2', channel_id: 'UC_L', channel_title: 'Like Chan', ai_approved: 1 }),
    ]);

    toggleLike(db, kid.id, { video_id: 'l2', title: 'L2', channel_title: 'Like Chan' });

    const feed = getKidFeed(db, kid.id, {});
    assert.ok(Array.isArray(feed.liked_video_ids), 'should have liked_video_ids');
    assert.equal(feed.liked_video_ids.length, 1);
    assert.ok(feed.liked_video_ids.includes('l2'));
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed sorts unwatched videos before watched, within each group by published_at DESC', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'sort-feed@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'SortKid' });
    addChannel(db, kid.id, { channel_id: 'UC_S', title: 'Sort Chan' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'unwatched_old', channel_id: 'UC_S', channel_title: 'Sort Chan', ai_approved: 1, published_at: '2024-01-01' }),
      makeVideo({ video_id: 'watched_new', channel_id: 'UC_S', channel_title: 'Sort Chan', ai_approved: 1, published_at: '2024-06-01' }),
      makeVideo({ video_id: 'unwatched_new', channel_id: 'UC_S', channel_title: 'Sort Chan', ai_approved: 1, published_at: '2024-12-01' }),
      makeVideo({ video_id: 'watched_old', channel_id: 'UC_S', channel_title: 'Sort Chan', ai_approved: 1, published_at: '2024-03-01' }),
    ]);

    recordWatch(db, kid.id, 'watched_new');
    recordWatch(db, kid.id, 'watched_old');

    const feed = getKidFeed(db, kid.id, {});
    const ids = feed.videos.map(v => v.video_id);
    // Unwatched first (newest first), then watched (newest first)
    assert.deepEqual(ids, ['unwatched_new', 'unwatched_old', 'watched_new', 'watched_old']);
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed interleaves videos from different channels', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'diversity@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'DiverseKid' });

    addChannel(db, kid.id, { channel_id: 'UC_A', title: 'Channel A' });
    addChannel(db, kid.id, { channel_id: 'UC_B', title: 'Channel B' });
    addChannel(db, kid.id, { channel_id: 'UC_C', title: 'Channel C' });

    const videos = [];
    for (let i = 0; i < 6; i++) {
      videos.push(makeVideo({
        video_id: `a${i}`, channel_id: 'UC_A', channel_title: 'Channel A',
        ai_approved: 1, published_at: `2024-06-${String(10 + i).padStart(2, '0')}`,
      }));
    }
    for (let i = 0; i < 3; i++) {
      videos.push(makeVideo({
        video_id: `b${i}`, channel_id: 'UC_B', channel_title: 'Channel B',
        ai_approved: 1, published_at: `2024-06-${String(10 + i).padStart(2, '0')}`,
      }));
    }
    for (let i = 0; i < 3; i++) {
      videos.push(makeVideo({
        video_id: `c${i}`, channel_id: 'UC_C', channel_title: 'Channel C',
        ai_approved: 1, published_at: `2024-06-${String(10 + i).padStart(2, '0')}`,
      }));
    }
    upsertVideos(db, kid.id, videos);

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 12);

    // The first 3 videos should be from 3 different channels
    const firstThreeChannels = new Set(feed.videos.slice(0, 3).map(v => v.channel_id));
    assert.equal(firstThreeChannels.size, 3, 'first 3 videos should each be from a different channel');

    // While all 3 channels still have videos (first 9 positions), no 2 consecutive
    // should be from the same channel
    for (let i = 0; i < 8; i++) {
      assert.notEqual(
        feed.videos[i].channel_id,
        feed.videos[i + 1].channel_id,
        `videos ${i} and ${i+1} should not both be from ${feed.videos[i].channel_id}`
      );
    }
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed diversity still puts unwatched before watched', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'diversity-watched@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'DivWatchKid' });

    addChannel(db, kid.id, { channel_id: 'UC_X', title: 'Channel X' });
    addChannel(db, kid.id, { channel_id: 'UC_Y', title: 'Channel Y' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'x1', channel_id: 'UC_X', channel_title: 'Channel X', ai_approved: 1, published_at: '2024-06-01' }),
      makeVideo({ video_id: 'y1', channel_id: 'UC_Y', channel_title: 'Channel Y', ai_approved: 1, published_at: '2024-06-02' }),
      makeVideo({ video_id: 'x2', channel_id: 'UC_X', channel_title: 'Channel X', ai_approved: 1, published_at: '2024-06-03' }),
    ]);

    recordWatch(db, kid.id, 'x2');

    const feed = getKidFeed(db, kid.id, {});
    const watchedIdx = feed.videos.findIndex(v => v.watched === 1);
    const unwatchedAfter = feed.videos.slice(watchedIdx).filter(v => v.watched === 0);
    assert.equal(unwatchedAfter.length, 0, 'no unwatched videos should appear after watched section');
  } finally {
    teardown(dir, db);
  }
});
