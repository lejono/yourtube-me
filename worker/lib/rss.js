/**
 * RSS fetching and parsing for YouTube channel feeds.
 *
 * Uses YouTube's public RSS endpoint (no API key needed).
 * Includes a search-based channel resolver as a fallback when only a
 * channel name/handle is known.
 */

// Allow tests to inject a fake fetch implementation
let _fetch = globalThis.fetch;

export function _setFetchForTesting(fn) {
  _fetch = fn ?? globalThis.fetch;
}

const YT_RSS_URL = 'https://www.youtube.com/feeds/videos.xml';

// --- XML helpers (regex-based, no parser dependency) ---

function decodeXMLEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}>([^<]*)</${escaped}>`);
  const m = xml.match(re);
  return m ? decodeXMLEntities(m[1]) : null;
}

function extractAttr(xml, tagName, attrName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}[^>]*?\\s${attrName}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? decodeXMLEntities(m[1]) : null;
}

// --- RSS parsing ---

/**
 * Parse YouTube RSS XML into an array of video entries.
 * @param {string} xml
 * @returns {Array<{videoId, title, channelTitle, publishedAt, thumbnail}>}
 */
export function parseRSSEntries(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const videoId = extractTag(block, 'yt:videoId');
    if (!videoId) continue;

    // channelTitle lives in <author><name>...</name></author>
    const authorBlock = block.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? '';
    const channelTitle = extractTag(authorBlock, 'name') || '';

    // Thumbnail from media:thumbnail url attribute; fallback to ytimg URL
    const thumbnail =
      extractAttr(block, 'media:thumbnail', 'url') ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    entries.push({
      videoId,
      title: extractTag(block, 'title') || '',
      channelTitle,
      publishedAt: extractTag(block, 'published') || '',
      thumbnail,
    });
  }

  return entries;
}

/**
 * Fetch and parse a YouTube channel's RSS feed.
 * @param {string} channelId  UC... channel ID
 * @returns {Promise<Array>}
 */
export async function fetchRSS(channelId) {
  const url = `${YT_RSS_URL}?channel_id=${encodeURIComponent(channelId)}`;
  const res = await _fetch(url);

  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  return parseRSSEntries(xml);
}

/**
 * Attempt to resolve a channel ID by scraping the YouTube search page.
 * This is a best-effort fallback -- it parses the first "channelId":"UC..."
 * pattern from the HTML. Returns null if nothing is found or on any error.
 *
 * @param {string} query  Channel name or handle to search for
 * @returns {Promise<string|null>}
 */
export async function resolveChannelBySearch(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%253D%253D`;
    const res = await _fetch(url);
    const html = await res.text();

    // Extract first "channelId":"UC..." pattern from the page's JSON data
    const m = html.match(/"channelId"\s*:\s*"(UC[^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
