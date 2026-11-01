import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRSSEntries, fetchAndInsertVideos, _setFetchForTesting } from '../lib/rss-fetch.js';
import { getDb, runMigrations, closeDb } from '../lib/db.js';
import { createFamily } from '../lib/auth.js';
import { createKid } from '../lib/kid-token.js';

// --- Unit tests: parseRSSEntries ---

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <yt:videoId>abc123</yt:videoId>
    <title>Test Video &amp; More</title>
    <published>2024-01-15T10:00:00+00:00</published>
    <author><name>Test Channel</name></author>
    <media:thumbnail url="https://i.ytimg.com/vi/abc123/mqdefault.jpg"/>
  </entry>
  <entry>
    <yt:videoId>def456</yt:videoId>
    <title>Second Video</title>
    <published>2024-01-14T09:00:00+00:00</published>
    <author><name>Test Channel</name></author>
  </entry>
</feed>`;

test('parseRSSEntries returns correct number of entries', () => {
  const entries = parseRSSEntries(SAMPLE_XML);
  assert.equal(entries.length, 2);
});

test('parseRSSEntries extracts videoId', () => {
  const entries = parseRSSEntries(SAMPLE_XML);
  assert.equal(entries[0].videoId, 'abc123');
  assert.equal(entries[1].videoId, 'def456');
});

test('parseRSSEntries decodes HTML entities in title', () => {
  const entries = parseRSSEntries(SAMPLE_XML);
  assert.equal(entries[0].title, 'Test Video & More');
});

test('parseRSSEntries extracts publishedAt', () => {
  const entries = parseRSSEntries(SAMPLE_XML);
  assert.equal(entries[0].publishedAt, '2024-01-15T10:00:00+00:00');
});

test('parseRSSEntries extracts thumbnail from media:thumbnail', () => {
  const entries = parseRSSEntries(SAMPLE_XML);
  assert.equal(entries[0].thumbnail, 'https://i.ytimg.com/vi/abc123/mqdefault.jpg');
});

test('parseRSSEntries falls back to ytimg URL when no thumbnail attribute', () => {
  const entries = parseRSSEntries(SAMPLE_XML);
  assert.equal(entries[1].thumbnail, 'https://i.ytimg.com/vi/def456/hqdefault.jpg');
});

test('parseRSSEntries returns empty array for empty XML', () => {
  const entries = parseRSSEntries('<feed></feed>');
  assert.equal(entries.length, 0);
});

// --- Integration: fetchAndInsertVideos inserts into DB ---

let tmpDir;
let db;
let kidId;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'yourtube-rss-test-'));
  process.env.YOURTUBE_DB_PATH = join(tmpDir, 'test.db');
  db = getDb(process.env.YOURTUBE_DB_PATH);
  runMigrations(db);

  const family = createFamily(db, 'rss-test@example.com', 'testpass');
  const kid = createKid(db, family.id, { name: 'TestKid', age: 8 });
  kidId = kid.id;
});

after(() => {
  _setFetchForTesting(null);
  closeDb();
  rmSync(tmpDir, { recursive: true });
});

test('fetchAndInsertVideos inserts parsed videos into DB', async () => {
  _setFetchForTesting(async (_url, _opts) => ({
    ok: true,
    text: async () => SAMPLE_XML,
  }));

  const channels = [{ channel_id: 'UCtest', title: 'Test Channel' }];
  await fetchAndInsertVideos(db, kidId, channels);

  const rows = db.prepare('SELECT * FROM videos WHERE kid_id = ? ORDER BY video_id').all(kidId);
  assert.equal(rows.length, 2);

  const first = rows.find(r => r.video_id === 'abc123');
  assert.ok(first, 'should have video abc123');
  assert.equal(first.title, 'Test Video & More');
  assert.equal(first.channel_id, 'UCtest');
  assert.equal(first.channel_title, 'Test Channel');
  assert.equal(first.ai_approved, 0, 'videos should await worker review');
  assert.equal(first.ai_reason, 'Awaiting review');
});

test('fetchAndInsertVideos skips channels when fetch returns non-ok', async () => {
  _setFetchForTesting(async () => ({ ok: false, status: 404 }));

  db.prepare('DELETE FROM videos WHERE kid_id = ?').run(kidId);

  const channels = [{ channel_id: 'UCbad', title: 'Bad Channel' }];
  await fetchAndInsertVideos(db, kidId, channels);

  const rows = db.prepare('SELECT * FROM videos WHERE kid_id = ?').all(kidId);
  assert.equal(rows.length, 0, 'should insert no videos on 404');
});

test('fetchAndInsertVideos continues after a channel throws', async () => {
  let callCount = 0;
  _setFetchForTesting(async (_url) => {
    callCount++;
    if (callCount === 1) throw new Error('Network error');
    return { ok: true, text: async () => SAMPLE_XML };
  });

  db.prepare('DELETE FROM videos WHERE kid_id = ?').run(kidId);

  const channels = [
    { channel_id: 'UCerror', title: 'Error Channel' },
    { channel_id: 'UCgood', title: 'Good Channel' },
  ];
  await fetchAndInsertVideos(db, kidId, channels);

  const rows = db.prepare('SELECT * FROM videos WHERE kid_id = ?').all(kidId);
  assert.equal(rows.length, 2, 'should insert videos from second channel despite first failing');
});

// --- Cross-kid approval sharing ---

test('when a video has been approved for another kid, it gets auto-approved for the new kid', async () => {
  // Two families, two kids
  const family2 = createFamily(db, 'parent2@example.com', 'pass2');
  const kid1 = createKid(db, family2.id, { name: 'Kid1', age: 9 });
  const kid2 = createKid(db, family2.id, { name: 'Kid2', age: 9 });

  // Pre-insert a video for kid1 with ai_approved = 1
  db.prepare(`
    INSERT INTO videos (kid_id, video_id, title, channel_id, channel_title, published_at, thumbnail, ai_approved, ai_reason)
    VALUES (?, 'abc123', 'Test Video & More', 'UCtest', 'Test Channel', '2024-01-15T10:00:00+00:00', 'https://i.ytimg.com/vi/abc123/mqdefault.jpg', 1, 'Educational science')
  `).run(kid1.id);

  // Fetch the same channel for kid2 using the RSS feed that returns abc123 and def456
  _setFetchForTesting(async () => ({
    ok: true,
    text: async () => SAMPLE_XML,
  }));

  db.prepare('DELETE FROM videos WHERE kid_id = ?').run(kid2.id);

  const channels = [{ channel_id: 'UCtest', title: 'Test Channel' }];
  await fetchAndInsertVideos(db, kid2.id, channels);

  const rows = db.prepare('SELECT * FROM videos WHERE kid_id = ? ORDER BY video_id').all(kid2.id);
  assert.equal(rows.length, 2, 'should insert both videos for kid2');

  const approved = rows.find(r => r.video_id === 'abc123');
  assert.ok(approved, 'abc123 should be inserted for kid2');
  assert.equal(approved.ai_approved, 1, 'abc123 should be auto-approved since it was approved for kid1');
  assert.ok(approved.ai_reason.includes('Previously reviewed'), 'reason should mention previously reviewed');

  const pending = rows.find(r => r.video_id === 'def456');
  assert.ok(pending, 'def456 should be inserted for kid2');
  assert.equal(pending.ai_approved, 0, 'def456 should still be awaiting review');
  assert.equal(pending.ai_reason, 'Awaiting review');
});
