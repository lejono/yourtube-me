import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  parseRSSEntries,
  fetchRSS,
  getVideoDetails,
  getChannelUploads,
  getSubscriptions,
  getLikedVideos,
  searchVideos,
  resolveChannel,
  getQuotaUsed,
  incrementQuota,
  isQuotaAvailable,
  _resetQuota,
  _setFetchForTesting,
} from "../lib/youtube.js";

// --- Helpers ---

function makeFetch(responses) {
  const queue = [...responses];
  return async (url) => {
    if (!queue.length) throw new Error(`Unexpected fetch: ${url}`);
    const item = queue.shift();
    if (item instanceof Error) throw item;
    const body = typeof item === "string" ? item : JSON.stringify(item);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => body,
      json: async () => (typeof item === "string" ? JSON.parse(body) : item),
    };
  };
}

function makeErrorFetch(status, statusText) {
  return async (_url) => ({
    ok: false,
    status,
    statusText,
    text: async () => `Error ${status}`,
    json: async () => ({ error: { code: status, message: statusText } }),
  });
}

// Sample RSS feed XML
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <title>Never Gonna Give You Up</title>
    <published>2009-10-25T06:57:33+00:00</published>
    <media:thumbnail url="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
  </entry>
  <entry>
    <yt:videoId>kffacxfA7G4</yt:videoId>
    <title>Baby &amp; Me</title>
    <published>2012-10-01T00:00:00+00:00</published>
    <media:thumbnail url="https://i.ytimg.com/vi/kffacxfA7G4/hqdefault.jpg" width="480" height="360"/>
  </entry>
  <entry>
    <yt:videoId>noThumb</yt:videoId>
    <title>No Thumbnail</title>
    <published>2020-01-01T00:00:00+00:00</published>
  </entry>
</feed>`;

// --- Tests ---

describe("parseRSSEntries", () => {
  test("parses all entries from sample XML", () => {
    const entries = parseRSSEntries(SAMPLE_RSS);
    assert.equal(entries.length, 3);
  });

  test("extracts videoId and title", () => {
    const entries = parseRSSEntries(SAMPLE_RSS);
    assert.equal(entries[0].videoId, "dQw4w9WgXcQ");
    assert.equal(entries[0].title, "Never Gonna Give You Up");
  });

  test("decodes XML entities in title", () => {
    const entries = parseRSSEntries(SAMPLE_RSS);
    assert.equal(entries[1].title, "Baby & Me");
  });

  test("extracts thumbnail URL", () => {
    const entries = parseRSSEntries(SAMPLE_RSS);
    assert.equal(
      entries[0].thumbnail,
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
  });

  test("extracts published date", () => {
    const entries = parseRSSEntries(SAMPLE_RSS);
    assert.equal(entries[0].published, "2009-10-25T06:57:33+00:00");
  });

  test("returns empty string for missing thumbnail", () => {
    const entries = parseRSSEntries(SAMPLE_RSS);
    assert.equal(entries[2].thumbnail, "");
  });

  test("returns empty array for empty feed", () => {
    const entries = parseRSSEntries("<feed></feed>");
    assert.deepEqual(entries, []);
  });

  test("skips entries without videoId", () => {
    const xml = `<feed>
      <entry><title>No ID</title></entry>
      <entry><yt:videoId>abc123</yt:videoId><title>Has ID</title></entry>
    </feed>`;
    const entries = parseRSSEntries(xml);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].videoId, "abc123");
  });
});

describe("fetchRSS", () => {
  beforeEach(() => _resetQuota());

  test("fetches and parses RSS feed", async () => {
    _setFetchForTesting(makeFetch([SAMPLE_RSS]));
    const entries = await fetchRSS("UCxxxxxx");
    assert.equal(entries.length, 3);
    assert.equal(entries[0].videoId, "dQw4w9WgXcQ");
  });

  test("throws on HTTP error", async () => {
    _setFetchForTesting(makeErrorFetch(404, "Not Found"));
    await assert.rejects(fetchRSS("UCbad"), /RSS fetch failed: 404/);
  });
});

describe("quota tracking", () => {
  beforeEach(() => _resetQuota());

  test("starts at zero after reset", () => {
    assert.equal(getQuotaUsed(), 0);
  });

  test("incrementQuota adds cost", () => {
    incrementQuota(5);
    assert.equal(getQuotaUsed(), 5);
    incrementQuota(10);
    assert.equal(getQuotaUsed(), 15);
  });

  test("isQuotaAvailable returns true when under limit", () => {
    incrementQuota(100);
    assert.equal(isQuotaAvailable(100), true);
  });

  test("isQuotaAvailable returns false when at limit", () => {
    incrementQuota(10000);
    assert.equal(isQuotaAvailable(1), false);
  });

  test("isQuotaAvailable returns false when adding cost would exceed limit", () => {
    incrementQuota(9950);
    assert.equal(isQuotaAvailable(100), false);
  });

  test("isQuotaAvailable returns true when exact budget remains", () => {
    incrementQuota(9900);
    assert.equal(isQuotaAvailable(100), true);
  });
});

describe("getVideoDetails", () => {
  beforeEach(() => _resetQuota());

  test("returns empty array for empty input", async () => {
    _setFetchForTesting(makeFetch([]));
    const result = await getVideoDetails([], "token");
    assert.deepEqual(result, []);
  });

  test("fetches video details for a single chunk (<= 50 IDs)", async () => {
    const mockItem = {
      id: "vid1",
      snippet: {
        title: "Test Video",
        description: "Desc",
        tags: ["a"],
        categoryId: "10",
        channelId: "UC123",
        channelTitle: "Test Channel",
        publishedAt: "2024-01-01T00:00:00Z",
        thumbnails: {},
      },
      contentDetails: { duration: "PT3M" },
    };
    _setFetchForTesting(makeFetch([{ items: [mockItem] }]));

    const result = await getVideoDetails(["vid1"], "token");
    assert.equal(result.length, 1);
    assert.equal(result[0].videoId, "vid1");
    assert.equal(result[0].title, "Test Video");
    assert.equal(result[0].duration, "PT3M");
    assert.equal(result[0].channelId, "UC123");
  });

  test("batches requests in chunks of 50 for > 50 IDs", async () => {
    const ids = Array.from({ length: 75 }, (_, i) => `vid${i}`);
    const calls = [];

    _setFetchForTesting(async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
        text: async () => "{}",
      };
    });

    await getVideoDetails(ids, "token");
    assert.equal(calls.length, 2, "should make 2 API calls for 75 IDs");
  });

  test("collects results from all chunks", async () => {
    const makeItem = (id) => ({
      id,
      snippet: {
        title: `Video ${id}`,
        description: "",
        tags: [],
        categoryId: "1",
        channelId: "UC1",
        channelTitle: "Ch",
        publishedAt: "2024-01-01T00:00:00Z",
        thumbnails: {},
      },
      contentDetails: { duration: "PT1M" },
    });

    const chunk1Items = Array.from({ length: 50 }, (_, i) =>
      makeItem(`id${i}`),
    );
    const chunk2Items = Array.from({ length: 10 }, (_, i) =>
      makeItem(`id${i + 50}`),
    );

    _setFetchForTesting(
      makeFetch([{ items: chunk1Items }, { items: chunk2Items }]),
    );

    const ids = Array.from({ length: 60 }, (_, i) => `id${i}`);
    const result = await getVideoDetails(ids, "token");
    assert.equal(result.length, 60);
  });
});

describe("getSubscriptions", () => {
  beforeEach(() => _resetQuota());

  test("returns all subscriptions from a single page", async () => {
    const mockSub = (id) => ({
      snippet: {
        resourceId: { channelId: id },
        title: `Channel ${id}`,
        description: "Desc",
        thumbnails: { default: { url: "http://thumb.jpg" } },
      },
    });

    _setFetchForTesting(
      makeFetch([{ items: [mockSub("UC1"), mockSub("UC2")] }]),
    );

    const subs = await getSubscriptions("token");
    assert.equal(subs.length, 2);
    assert.equal(subs[0].channelId, "UC1");
    assert.equal(subs[1].channelId, "UC2");
  });

  test("follows pagination to collect all subscriptions", async () => {
    const makeSub = (id) => ({
      snippet: {
        resourceId: { channelId: id },
        title: `Ch ${id}`,
        description: "",
        thumbnails: { default: { url: "" } },
      },
    });

    const page1 = {
      items: [makeSub("UC1"), makeSub("UC2")],
      nextPageToken: "token-page-2",
    };
    const page2 = {
      items: [makeSub("UC3")],
    };

    _setFetchForTesting(makeFetch([page1, page2]));

    const subs = await getSubscriptions("token");
    assert.equal(subs.length, 3);
    assert.equal(subs[2].channelId, "UC3");
  });

  test("returns empty array when no subscriptions", async () => {
    _setFetchForTesting(makeFetch([{ items: [] }]));
    const subs = await getSubscriptions("token");
    assert.deepEqual(subs, []);
  });
});

describe("getLikedVideos", () => {
  beforeEach(() => _resetQuota());

  const makeLike = (id) => ({
    id,
    snippet: {
      title: `Like ${id}`,
      channelId: "UC1",
      channelTitle: "Ch",
      publishedAt: "2024-01-01T00:00:00Z",
      thumbnails: { default: { url: "" } },
    },
    contentDetails: { duration: "PT2M" },
  });

  test("returns liked videos from a single page", async () => {
    _setFetchForTesting(makeFetch([{ items: [makeLike("v1"), makeLike("v2")] }]));
    const likes = await getLikedVideos("token");
    assert.equal(likes.length, 2);
    assert.equal(likes[0].videoId, "v1");
  });

  test("respects maxVideos cap at 200", async () => {
    // Generate 5 pages of 50 items = 250 total, but cap at 200
    const makePageOf50 = (offset) => ({
      items: Array.from({ length: 50 }, (_, i) => makeLike(`v${offset + i}`)),
      nextPageToken: `page-${offset + 50}`,
    });

    // Page 4 (last fetched before cap) should stop pagination
    const responses = [
      makePageOf50(0),
      makePageOf50(50),
      makePageOf50(100),
      makePageOf50(150),
      { items: Array.from({ length: 50 }, (_, i) => makeLike(`v${200 + i}`)) },
    ];

    _setFetchForTesting(makeFetch(responses));
    const likes = await getLikedVideos("token", 200);
    assert.equal(likes.length, 200);
  });
});

describe("searchVideos", () => {
  beforeEach(() => _resetQuota());

  const mockSearchResponse = {
    items: [
      {
        id: { videoId: "sv1" },
        snippet: {
          title: "Search Result",
          channelId: "UC1",
          channelTitle: "Ch",
          publishedAt: "2024-01-01T00:00:00Z",
          description: "Desc",
          thumbnails: { default: { url: "" } },
        },
      },
    ],
  };

  test("returns search results", async () => {
    _setFetchForTesting(makeFetch([mockSearchResponse]));
    const results = await searchVideos("cats", "token");
    assert.equal(results.length, 1);
    assert.equal(results[0].videoId, "sv1");
    assert.equal(results[0].title, "Search Result");
  });

  test("increments quota by 100 after search", async () => {
    _setFetchForTesting(makeFetch([mockSearchResponse]));
    await searchVideos("dogs", "token");
    assert.equal(getQuotaUsed(), 100);
  });

  test("throws when quota is exhausted", async () => {
    incrementQuota(10000);
    _setFetchForTesting(makeFetch([]));
    await assert.rejects(
      searchVideos("query", "token"),
      /Daily API quota exceeded/,
    );
  });

  test("does not make API call when quota is exhausted", async () => {
    incrementQuota(10000);
    let called = false;
    _setFetchForTesting(async () => {
      called = true;
      return { ok: true, json: async () => ({ items: [] }), text: async () => "{}" };
    });
    await assert.rejects(searchVideos("query", "token"));
    assert.equal(called, false);
  });
});

describe("resolveChannel", () => {
  beforeEach(() => _resetQuota());

  test("returns UCxxx ID directly without API call", async () => {
    let called = false;
    _setFetchForTesting(async () => {
      called = true;
      return { ok: true, json: async () => ({}), text: async () => "{}" };
    });

    const id = await resolveChannel("UCxxxxabcdefghij12345", "token");
    assert.equal(id, "UCxxxxabcdefghij12345");
    assert.equal(called, false, "should not call API for bare UC ID");
  });

  test("extracts channel ID from /channel/UCxxx URL", async () => {
    let called = false;
    _setFetchForTesting(async () => {
      called = true;
      return { ok: true, json: async () => ({}), text: async () => "{}" };
    });

    const id = await resolveChannel(
      "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
      "token",
    );
    assert.equal(id, "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    assert.equal(called, false, "should not call API for /channel/ URL");
  });

  test("resolves @handle via API", async () => {
    _setFetchForTesting(
      makeFetch([{ items: [{ id: "UChandle123" }] }]),
    );
    const id = await resolveChannel("@MrBeast", "token");
    assert.equal(id, "UChandle123");
  });

  test("resolves @handle URL via API", async () => {
    _setFetchForTesting(
      makeFetch([{ items: [{ id: "UChandleUrl" }] }]),
    );
    const id = await resolveChannel(
      "https://www.youtube.com/@SomeChannel",
      "token",
    );
    assert.equal(id, "UChandleUrl");
  });

  test("resolves /c/customname URL via API", async () => {
    _setFetchForTesting(
      makeFetch([{ items: [{ id: "UCcustom456" }] }]),
    );
    const id = await resolveChannel(
      "https://www.youtube.com/c/PewDiePie",
      "token",
    );
    assert.equal(id, "UCcustom456");
  });

  test("resolves bare handle string via API", async () => {
    _setFetchForTesting(
      makeFetch([{ items: [{ id: "UCbare789" }] }]),
    );
    const id = await resolveChannel("SomeChannel", "token");
    assert.equal(id, "UCbare789");
  });

  test("throws for empty input", async () => {
    _setFetchForTesting(makeFetch([]));
    await assert.rejects(resolveChannel("", "token"), /Empty channel input/);
  });

  test("throws when handle not found", async () => {
    _setFetchForTesting(makeFetch([{ items: [] }]));
    await assert.rejects(resolveChannel("@NotExist", "token"), /Channel not found/);
  });
});

describe("getChannelUploads", () => {
  beforeEach(() => _resetQuota());

  test("fetches uploads playlist and returns videos", async () => {
    const channelsResponse = {
      items: [
        {
          contentDetails: {
            relatedPlaylists: { uploads: "UUxxx" },
          },
        },
      ],
    };

    const playlistResponse = {
      items: [
        {
          snippet: {
            resourceId: { videoId: "v1" },
            title: "Upload 1",
            publishedAt: "2024-01-01T00:00:00Z",
            channelId: "UC1",
            channelTitle: "Ch",
            thumbnails: {},
          },
        },
      ],
    };

    _setFetchForTesting(makeFetch([channelsResponse, playlistResponse]));

    const videos = await getChannelUploads("UC1", "token");
    assert.equal(videos.length, 1);
    assert.equal(videos[0].videoId, "v1");
    assert.equal(videos[0].title, "Upload 1");
  });

  test("throws when channel not found", async () => {
    _setFetchForTesting(makeFetch([{ items: [] }]));
    await assert.rejects(
      getChannelUploads("UCbad", "token"),
      /Channel not found/,
    );
  });
});
