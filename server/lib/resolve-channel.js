/**
 * Resolve a user-provided channel identifier to a YouTube channel ID.
 *
 * Handles:
 *   - Already a UC* channel ID → return as-is
 *   - YouTube channel URL (youtube.com/channel/UC*) → extract ID
 *   - YouTube handle URL (youtube.com/@handle) → fetch page, extract ID
 *   - Bare name/handle → search YouTube, extract first channel ID
 *
 * Returns { channel_id, title } or null if unresolvable.
 */

const CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]+$/;
const CHANNEL_URL_RE = /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/;
const HANDLE_URL_RE = /youtube\.com\/@([a-zA-Z0-9_.-]+)/;

// Allow injection for testing
let _fetch = globalThis.fetch;
export function _setFetchForTesting(fn) {
  _fetch = fn ?? globalThis.fetch;
}

/**
 * Try to resolve user input to a { channel_id, title }.
 * @param {string} input - UC* ID, YouTube URL, @handle, or channel name
 * @returns {Promise<{ channel_id: string, title: string | null } | null>}
 */
export async function resolveChannel(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  // Already a valid channel ID
  if (CHANNEL_ID_RE.test(trimmed)) {
    return { channel_id: trimmed, title: null };
  }

  // YouTube channel URL: youtube.com/channel/UC...
  const channelMatch = trimmed.match(CHANNEL_URL_RE);
  if (channelMatch) {
    return { channel_id: channelMatch[1], title: null };
  }

  // YouTube handle URL: youtube.com/@handle — or bare @handle
  const handleMatch = trimmed.match(HANDLE_URL_RE) || trimmed.match(/^@([a-zA-Z0-9_.-]+)$/);
  if (handleMatch) {
    return fetchChannelIdFromHandle(handleMatch[1]);
  }

  // Bare name — try YouTube search
  return searchForChannel(trimmed);
}

/**
 * Fetch a YouTube handle page and extract the channel ID.
 */
async function fetchChannelIdFromHandle(handle) {
  try {
    const url = `https://www.youtube.com/@${encodeURIComponent(handle)}`;
    const res = await _fetch(url, { redirect: 'follow' });
    const html = await res.text();
    const m = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
    if (!m) return null;
    // Try to extract channel name too
    const nameMatch = html.match(/"title"\s*:\s*"([^"]+)"/);
    return { channel_id: m[1], title: nameMatch?.[1] || null };
  } catch {
    return null;
  }
}

/**
 * Search YouTube for a channel by name and extract the first channel ID.
 */
async function searchForChannel(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + ' youtube channel')}&sp=EgIQAg%3D%3D`;
    const res = await _fetch(url, { redirect: 'follow' });
    const html = await res.text();
    const m = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
    if (!m) return null;
    return { channel_id: m[1], title: null };
  } catch {
    return null;
  }
}
