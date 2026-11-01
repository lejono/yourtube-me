/**
 * Tests for worker/lib/rss.js — RSS fetching and parsing.
 *
 * fetchRSS and resolveChannelBySearch are tested with an injected mock fetch.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { parseRSSEntries, fetchRSS, resolveChannelBySearch, _setFetchForTesting } from '../lib/rss.js';

afterEach(() => {
  _setFetchForTesting(null);
});

// --- Sample XML fixture ---

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <yt:videoId>abc123</yt:videoId>
    <title>Funny Cats &amp; Dogs</title>
    <author><name>CoolChannel</name></author>
    <published>2024-03-15T10:00:00+00:00</published>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/abc123/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>
  <entry>
    <yt:videoId>def456</yt:videoId>
    <title>Science &amp; Technology</title>
    <author><name>ScienceChannel</name></author>
    <published>2024-03-14T08:00:00+00:00</published>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/def456/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>
  <entry>
    <yt:videoId>ghi789</yt:videoId>
    <title>No Thumbnail Video</title>
    <author><name>AnotherChannel</name></author>
    <published>2024-03-13T06:00:00+00:00</published>
  </entry>
</feed>`;

// --- parseRSSEntries tests ---

describe('parseRSSEntries', () => {
  test('returns correct entry count', () => {
    const entries = parseRSSEntries(SAMPLE_XML);
    assert.equal(entries.length, 3);
  });

  test('decodes HTML entities in title (&amp; -> &)', () => {
    const entries = parseRSSEntries(SAMPLE_XML);
    assert.equal(entries[0].title, 'Funny Cats & Dogs');
    assert.equal(entries[1].title, 'Science & Technology');
  });

  test('extracts videoId correctly', () => {
    const entries = parseRSSEntries(SAMPLE_XML);
    assert.equal(entries[0].videoId, 'abc123');
    assert.equal(entries[1].videoId, 'def456');
    assert.equal(entries[2].videoId, 'ghi789');
  });

  test('extracts channelTitle from author/name', () => {
    const entries = parseRSSEntries(SAMPLE_XML);
    assert.equal(entries[0].channelTitle, 'CoolChannel');
    assert.equal(entries[1].channelTitle, 'ScienceChannel');
  });

  test('extracts publishedAt', () => {
    const entries = parseRSSEntries(SAMPLE_XML);
    assert.equal(entries[0].publishedAt, '2024-03-15T10:00:00+00:00');
    assert.equal(entries[1].publishedAt, '2024-03-14T08:00:00+00:00');
  });

  test('extracts thumbnail URL when present', () => {
    const entries = parseRSSEntries(SAMPLE_XML);
    assert.equal(entries[0].thumbnail, 'https://i.ytimg.com/vi/abc123/hqdefault.jpg');
  });

  test('provides fallback thumbnail when not in RSS', () => {
    const entries = parseRSSEntries(SAMPLE_XML);
    // ghi789 has no media:thumbnail
    const noThumb = entries[2];
    assert.ok(noThumb.thumbnail, 'should have a fallback thumbnail');
    assert.ok(noThumb.thumbnail.includes('ghi789'), 'fallback should include the videoId');
  });

  test('returns empty array for empty XML', () => {
    const entries = parseRSSEntries('<feed></feed>');
    assert.deepEqual(entries, []);
  });

  test('skips entries without videoId', () => {
    const xml = `<feed>
      <entry><title>No ID</title></entry>
      <entry><yt:videoId>valid1</yt:videoId><title>Valid</title></entry>
    </feed>`;
    const entries = parseRSSEntries(xml);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].videoId, 'valid1');
  });
});

// --- fetchRSS tests ---

describe('fetchRSS', () => {
  test('fetches from correct YouTube RSS URL', async () => {
    let calledUrl = '';
    _setFetchForTesting(async (url) => {
      calledUrl = url;
      return { ok: true, text: async () => SAMPLE_XML };
    });

    const entries = await fetchRSS('UC_test123');
    assert.ok(calledUrl.includes('channel_id=UC_test123'));
    assert.ok(calledUrl.includes('youtube.com/feeds/videos.xml'));
    assert.equal(entries.length, 3);
  });

  test('throws on non-OK HTTP response', async () => {
    _setFetchForTesting(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));

    await assert.rejects(
      () => fetchRSS('UC_nonexistent'),
      /404/
    );
  });
});

// --- resolveChannelBySearch tests ---

describe('resolveChannelBySearch', () => {
  test('extracts channelId from YouTube search page', async () => {
    const mockHtml = `
      <html><body>
      <script>var data = {"channelId":"UCxxx123abc","title":"Test Channel"}</script>
      </body></html>
    `;
    _setFetchForTesting(async () => ({ ok: true, text: async () => mockHtml }));

    const channelId = await resolveChannelBySearch('Test Channel');
    assert.equal(channelId, 'UCxxx123abc');
  });

  test('returns null when no channelId found', async () => {
    _setFetchForTesting(async () => ({ ok: true, text: async () => '<html><body>nothing here</body></html>' }));

    const channelId = await resolveChannelBySearch('nonexistent channel');
    assert.equal(channelId, null);
  });

  test('returns null on fetch failure', async () => {
    _setFetchForTesting(async () => { throw new Error('network error'); });

    const channelId = await resolveChannelBySearch('some channel');
    assert.equal(channelId, null);
  });
});
