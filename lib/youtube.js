/**
 * YouTube Data API v3 client with RSS support and quota management.
 *
 * All API functions require an OAuth access token. RSS fetching is public.
 * Quota tracking is in-memory and resets daily.
 */

// --- Fetch injection for testing ---
let _fetch = globalThis.fetch;

export function _setFetchForTesting(fn) {
  _fetch = fn;
}

// --- Constants ---
const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const YT_RSS_URL = "https://www.youtube.com/feeds/videos.xml";
const DAILY_QUOTA_LIMIT = 10000;
const SEARCH_COST = 100;

// --- Quota tracking (in-memory, resets daily) ---
let _quotaState = { date: "", used: 0 };

function _resetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (_quotaState.date !== today) {
    _quotaState = { date: today, used: 0 };
  }
}

export function getQuotaUsed() {
  _resetIfNewDay();
  return _quotaState.used;
}

export function incrementQuota(cost) {
  _resetIfNewDay();
  _quotaState.used += cost;
}

export function isQuotaAvailable(cost) {
  _resetIfNewDay();
  return _quotaState.used + cost <= DAILY_QUOTA_LIMIT;
}

// For testing
export function _resetQuota() {
  _quotaState = { date: "", used: 0 };
}

// --- XML helpers (regex-based, no parser dependency) ---

function decodeXMLEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}>([^<]*)</${escaped}>`);
  const m = xml.match(re);
  return m ? decodeXMLEntities(m[1]) : null;
}

function extractAttr(xml, tagName, attrName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}[^>]*?\\s${attrName}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? decodeXMLEntities(m[1]) : null;
}

// --- Internal API helper ---

async function ytApiFetch(endpoint, accessToken, params = {}) {
  const url = new URL(`${YT_API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const res = await _fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const data = await res.json();
  if (data.error) {
    const err = new Error(
      `YouTube API error ${data.error.code}: ${data.error.message}`,
    );
    err.code = data.error.code;
    throw err;
  }

  return data;
}

// --- 1. resolveChannel ---

export async function resolveChannel(input, accessToken) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Empty channel input");

  // Try to parse as URL
  let pathname = null;
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtube.com")) {
      pathname = url.pathname;
    }
  } catch {
    // Not a URL
  }

  if (pathname) {
    // /channel/UCxxx — direct ID
    const channelMatch = pathname.match(/^\/channel\/(UC[\w-]+)/);
    if (channelMatch) return channelMatch[1];

    // /@handle
    const handleMatch = pathname.match(/^\/@([\w.-]+)/);
    if (handleMatch) {
      return _resolveHandle(handleMatch[1], accessToken);
    }

    // /c/customname
    const customMatch = pathname.match(/^\/c\/([\w.-]+)/);
    if (customMatch) {
      return _resolveHandle(customMatch[1], accessToken);
    }

    // /user/username (legacy)
    const userMatch = pathname.match(/^\/user\/([\w.-]+)/);
    if (userMatch) {
      return _resolveByUsername(userMatch[1], accessToken);
    }

    // Bare path like /MrBeast — try as handle
    const bareMatch = pathname.match(/^\/([\w.-]+)$/);
    if (bareMatch) {
      return _resolveHandle(bareMatch[1], accessToken);
    }
  }

  // Bare @handle
  if (trimmed.startsWith("@")) {
    return _resolveHandle(trimmed.slice(1), accessToken);
  }

  // Bare channel ID (starts with UC)
  if (/^UC[\w-]+$/.test(trimmed)) {
    return trimmed;
  }

  // Fall back: try as handle
  return _resolveHandle(trimmed, accessToken);
}

async function _resolveHandle(handle, accessToken) {
  const forHandle = handle.startsWith("@") ? handle : `@${handle}`;
  const data = await ytApiFetch("channels", accessToken, {
    part: "snippet",
    forHandle,
  });
  incrementQuota(1);

  if (data.items?.length > 0) {
    return data.items[0].id;
  }
  throw new Error(`Channel not found for handle: ${forHandle}`);
}

async function _resolveByUsername(username, accessToken) {
  const data = await ytApiFetch("channels", accessToken, {
    part: "snippet",
    forUsername: username,
  });
  incrementQuota(1);

  if (data.items?.length > 0) {
    return data.items[0].id;
  }
  // Fall back to handle resolution
  return _resolveHandle(username, accessToken);
}

// --- 2. fetchRSS ---

export async function fetchRSS(channelId) {
  const url = `${YT_RSS_URL}?channel_id=${encodeURIComponent(channelId)}`;
  const res = await _fetch(url);

  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  return parseRSSEntries(xml);
}

// Exported for direct testing
export function parseRSSEntries(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const videoId = extractTag(block, "yt:videoId");
    if (!videoId) continue;

    entries.push({
      videoId,
      title: extractTag(block, "title") || "",
      published: extractTag(block, "published") || "",
      thumbnail: extractAttr(block, "media:thumbnail", "url") || "",
    });
  }

  return entries;
}

// --- 3. getVideoDetails ---

export async function getVideoDetails(videoIds, accessToken) {
  if (!videoIds.length) return [];

  const results = [];
  // YouTube allows max 50 IDs per request
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await ytApiFetch("videos", accessToken, {
      part: "snippet,contentDetails",
      id: chunk.join(","),
    });
    incrementQuota(1);

    for (const item of data.items || []) {
      results.push({
        videoId: item.id,
        title: item.snippet.title,
        description: item.snippet.description,
        tags: item.snippet.tags || [],
        categoryId: item.snippet.categoryId,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
        thumbnails: item.snippet.thumbnails,
        duration: item.contentDetails?.duration,
        ageRestricted: item.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
      });
    }
  }

  return results;
}

// --- 4. getChannelUploads ---

export async function getChannelUploads(
  channelId,
  accessToken,
  maxResults = 50,
) {
  // Get uploads playlist ID via channels.list
  const chData = await ytApiFetch("channels", accessToken, {
    part: "contentDetails",
    id: channelId,
  });
  incrementQuota(1);

  if (!chData.items?.length) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  const uploadsId =
    chData.items[0].contentDetails.relatedPlaylists.uploads;

  const data = await ytApiFetch("playlistItems", accessToken, {
    part: "snippet",
    playlistId: uploadsId,
    maxResults: Math.min(maxResults, 50),
  });
  incrementQuota(1);

  return (data.items || []).map((item) => ({
    videoId: item.snippet.resourceId.videoId,
    title: item.snippet.title,
    publishedAt: item.snippet.publishedAt,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    thumbnails: item.snippet.thumbnails,
  }));
}

// --- 5. getSubscriptions ---

export async function getSubscriptions(accessToken) {
  const all = [];
  let pageToken = null;

  do {
    const params = {
      part: "snippet",
      mine: "true",
      maxResults: 50,
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await ytApiFetch("subscriptions", accessToken, params);
    incrementQuota(1);

    for (const item of data.items || []) {
      all.push({
        channelId: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails?.default?.url,
      });
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return all;
}

// --- 6. getLikedVideos ---

export async function getLikedVideos(accessToken, maxVideos = 200) {
  const all = [];
  let pageToken = null;

  do {
    const params = {
      part: "snippet,contentDetails",
      myRating: "like",
      maxResults: 50,
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await ytApiFetch("videos", accessToken, params);
    incrementQuota(1);

    for (const item of data.items || []) {
      all.push({
        videoId: item.id,
        title: item.snippet.title,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
        duration: item.contentDetails?.duration,
        thumbnail: item.snippet.thumbnails?.default?.url,
      });
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken && all.length < maxVideos);

  return all.slice(0, maxVideos);
}

// --- 7. searchVideos ---

export async function searchVideos(query, accessToken, options = {}) {
  if (!isQuotaAvailable(SEARCH_COST)) {
    throw new Error("Daily API quota exceeded — cannot perform search");
  }

  const params = {
    part: "snippet",
    q: query,
    type: "video",
    maxResults: options.maxResults || 10,
    safeSearch: options.safeSearch || "moderate",
  };
  if (options.channelId) params.channelId = options.channelId;
  if (options.order) params.order = options.order;

  const data = await ytApiFetch("search", accessToken, params);
  incrementQuota(SEARCH_COST);

  return (data.items || []).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
    description: item.snippet.description,
    thumbnail: item.snippet.thumbnails?.default?.url,
  }));
}
