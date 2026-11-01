/**
 * Import orchestration for YouTube subscriptions and liked videos.
 *
 * Calls the YouTube API client (lib/youtube.js) and persists results
 * to the JSON store (lib/store.js). Tracks import progress in memory
 * so the admin UI can poll GET /api/import/status.
 */

import { getValidToken } from './oauth.js';
import { getSubscriptions, getLikedVideos, getVideoDetails } from './youtube.js';
import { getChannels, setChannels, getVideos, setVideos } from './store.js';

// --- In-memory import status ---

let importStatus = {
  importing: false,
  type: null,
  progress: 0,
  total: 0,
  error: null,
  lastImport: null,
};

export function getImportStatus() {
  return { ...importStatus };
}

// For testing
export function _resetImportStatus() {
  importStatus = {
    importing: false,
    type: null,
    progress: 0,
    total: 0,
    error: null,
    lastImport: null,
  };
}

// --- Subscription import ---

export async function importSubscriptions() {
  if (importStatus.importing) {
    throw new Error('Import already in progress');
  }

  importStatus = { importing: true, type: 'subscriptions', progress: 0, total: 0, error: null, lastImport: null };

  let token;
  try {
    token = await getValidToken();
  } catch {
    importStatus.importing = false;
    importStatus.error = 'YouTube not connected. Please connect your YouTube account first.';
    throw new Error(importStatus.error);
  }

  let subs;
  try {
    subs = await getSubscriptions(token);
  } catch (err) {
    importStatus.importing = false;
    importStatus.error = `Failed to fetch subscriptions: ${err.message}`;
    throw err;
  }

  importStatus.total = subs.length;

  // Merge into channels.json by channelId — don't overwrite existing entries
  const existing = await getChannels();
  const byId = new Map(existing.map(ch => [ch.channelId, ch]));

  let added = 0;
  for (const sub of subs) {
    if (!byId.has(sub.channelId)) {
      byId.set(sub.channelId, {
        channelId: sub.channelId,
        title: sub.title,
        description: sub.description || '',
        thumbnail: sub.thumbnail || '',
        source: 'oauth',
        approved: false,
      });
      added++;
    }
    importStatus.progress++;
  }

  await setChannels([...byId.values()]);

  importStatus.importing = false;
  importStatus.lastImport = new Date().toISOString();

  return { total: subs.length, added, skipped: subs.length - added };
}

// --- Liked video import ---

export async function importLikedVideos() {
  if (importStatus.importing) {
    throw new Error('Import already in progress');
  }

  importStatus = { importing: true, type: 'liked', progress: 0, total: 0, error: null, lastImport: null };

  let token;
  try {
    token = await getValidToken();
  } catch {
    importStatus.importing = false;
    importStatus.error = 'YouTube not connected. Please connect your YouTube account first.';
    throw new Error(importStatus.error);
  }

  let liked;
  try {
    liked = await getLikedVideos(token, 200);
  } catch (err) {
    importStatus.importing = false;
    importStatus.error = `Failed to fetch liked videos: ${err.message}`;
    throw err;
  }

  importStatus.total = liked.length;

  // Get full details via getVideoDetails
  const videoIds = liked.map(v => v.videoId);
  let details;

  try {
    details = await getVideoDetails(videoIds, token);
  } catch (err) {
    // Partial failure: save basic info from getLikedVideos
    const existing = await getVideos();
    let added = 0;
    for (const v of liked) {
      if (!existing[v.videoId]) {
        existing[v.videoId] = { ...v, source: 'liked' };
        added++;
      }
      importStatus.progress++;
    }
    await setVideos(existing);

    importStatus.importing = false;
    importStatus.error = `Partial import (basic info only): ${err.message}`;
    importStatus.lastImport = new Date().toISOString();
    return { total: liked.length, added, error: err.message };
  }

  // Save full details keyed by videoId — don't overwrite existing entries
  const existing = await getVideos();
  let added = 0;
  for (const v of details) {
    if (!existing[v.videoId]) {
      existing[v.videoId] = { ...v, source: 'liked' };
      added++;
    }
    importStatus.progress++;
  }
  await setVideos(existing);

  importStatus.importing = false;
  importStatus.lastImport = new Date().toISOString();

  return { total: liked.length, added, skipped: liked.length - added };
}
