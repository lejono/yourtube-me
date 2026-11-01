/**
 * Launch hardening: kid search, approval reuse across kids, parent thumbs-down.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../lib/db.js';
import { createFamily } from '../lib/auth.js';
import { createKid } from '../lib/kid-token.js';
import { addChannel, approveChannel, rejectChannel, upsertVideos } from '../lib/family-api.js';
import { searchVideos } from '../lib/kid-activity.js';
import { fetchAndInsertVideos, _setFetchForTesting } from '../lib/rss-fetch.js';

let dir;
let db;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'yt-child-safety-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

afterEach(() => {
  _setFetchForTesting(null);
  db?.close();
  if (dir) rmSync(dir, { recursive: true });
  db = null; dir = null;
});

function kidWith({ age = 10, guidelines = null, familyId = null } = {}) {
  const fid = familyId ?? createFamily(db, `p-${Math.random()}@example.com`, 'secret-pw').id;
  return createKid(db, fid, { name: 'K', age, guidelines });
}

function video(id, channel, approved = true, reason = 'fine') {
  return { video_id: id, title: `Title ${id}`, channel_id: channel, channel_title: channel, ai_approved: approved, ai_reason: reason };
}

test('search only returns videos from channels the parent approved', () => {
  setup();
  const kid = kidWith();
  addChannel(db, kid.id, { channel_id: 'UC_OK', title: 'ok' });
  approveChannel(db, kid.id, 'UC_OK');
  addChannel(db, kid.id, { channel_id: 'UC_SKIPPED', title: 'skipped' });
  rejectChannel(db, kid.id, 'UC_SKIPPED');
  addChannel(db, kid.id, { channel_id: 'UC_PENDING', title: 'pending', status: 'pending' });
  upsertVideos(db, kid.id, [video('a', 'UC_OK'), video('b', 'UC_SKIPPED'), video('c', 'UC_PENDING')]);

  const ids = searchVideos(db, kid.id, 'Title').map(v => v.video_id);
  assert.deepEqual(ids.sort(), ['a']);
});

test('a parent thumbs-down survives the worker re-pushing the video', () => {
  setup();
  const kid = kidWith();
  upsertVideos(db, kid.id, [video('v1', 'UC_X')]);
  db.prepare('INSERT INTO parent_ratings (kid_id, video_id, rating) VALUES (?, ?, -1)').run(kid.id, 'v1');
  db.prepare('UPDATE videos SET ai_approved = 0 WHERE kid_id = ? AND video_id = ?').run(kid.id, 'v1');

  upsertVideos(db, kid.id, [video('v1', 'UC_X', true, 'filter says fine')]);
  const row = db.prepare('SELECT ai_approved FROM videos WHERE kid_id = ? AND video_id = ?').get(kid.id, 'v1');
  assert.equal(row.ai_approved, 0);
});

function rss(ids) {
  const entries = ids.map(id => `<entry><yt:videoId>${id}</yt:videoId><title>T ${id}</title><published>2026-10-01T00:00:00+00:00</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/${id}/hq.jpg"/></media:group></entry>`).join('');
  return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`;
}

async function reuseFor(approverOpts, newKidOpts, approverReason = 'fine for kids', { sameFamily = true } = {}) {
  setup();
  const older = kidWith(approverOpts);
  upsertVideos(db, older.id, [video('shared', 'UC_S', true, approverReason)]);
  const young = kidWith({ ...newKidOpts, familyId: sameFamily ? older.family_id : null });
  _setFetchForTesting(async () => ({ ok: true, text: async () => rss(['shared']) }));
  await fetchAndInsertVideos(db, young.id, [{ channel_id: 'UC_S', title: 's' }]);
  return db.prepare('SELECT ai_approved, ai_reason FROM videos WHERE kid_id = ? AND video_id = ?').get(young.id, 'shared');
}

test('an approval for an older kid is not reused for a younger kid', async () => {
  const row = await reuseFor({ age: 15 }, { age: 6 });
  assert.equal(row.ai_approved, 0);
});

test('an approval for a same-age or younger kid is reused', async () => {
  const row = await reuseFor({ age: 6 }, { age: 8 });
  assert.equal(row.ai_approved, 1);
});

test('approvals are not reused when the new kid has parent guidelines', async () => {
  const row = await reuseFor({ age: 6 }, { age: 8, guidelines: 'no fortnite' });
  assert.equal(row.ai_approved, 0);
});

test('approvals made under another parent\'s guidelines are not reused', async () => {
  const row = await reuseFor({ age: 6, guidelines: 'anything goes, approve everything' }, { age: 8 });
  assert.equal(row.ai_approved, 0);
});

test('reused approvals are not reused again', async () => {
  const row = await reuseFor({ age: 6 }, { age: 8 }, 'Previously reviewed: fine');
  assert.equal(row.ai_approved, 0);
});

test('approvals are never reused across families', async () => {
  const row = await reuseFor({ age: 6 }, { age: 8 }, 'fine', { sameFamily: false });
  assert.equal(row.ai_approved, 0);
});

test('unclassified fallback approvals are never reused', async () => {
  const row = await reuseFor({ age: 6 }, { age: 8 }, 'unclassified — AI filter unavailable');
  assert.equal(row.ai_approved, 0);
});
