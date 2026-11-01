/**
 * HTTP client for the YourTube server's worker API.
 *
 * All requests are authenticated with the X-Worker-Key header.
 * No unit tests here -- this module is a thin HTTP wrapper, tested via E2E.
 */

import { SERVER_URL, WORKER_KEY } from '../config.js';

function workerHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Worker-Key': WORKER_KEY,
  };
}

/**
 * Fetch the worker manifest from the server.
 * Returns an array of kids with their channels, age, interests, and guidelines.
 * @returns {Promise<Array>}
 */
export async function fetchManifest() {
  const res = await fetch(`${SERVER_URL}/api/worker/manifest`, {
    headers: workerHeaders(),
  });

  if (!res.ok) {
    throw new Error(`fetchManifest failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Push classified videos for a kid to the server.
 * @param {string} kidId
 * @param {Array<{video_id, title, channel_id, channel_title, published_at, thumbnail, ai_approved, ai_reason}>} videos
 * @returns {Promise<{ok: boolean, count: number}>}
 */
export async function pushVideos(kidId, videos) {
  const res = await fetch(`${SERVER_URL}/api/worker/push`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify({ kid_id: kidId, videos }),
  });

  if (!res.ok) {
    throw new Error(`pushVideos failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Push a discovered channel for a kid to the server.
 * @param {string} kidId
 * @param {{ channel_id: string, title: string, thumbnail?: string }} channel
 * @returns {Promise<object>}
 */
export async function pushChannels(kidId, channel) {
  const res = await fetch(`${SERVER_URL}/api/worker/channels`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify({ kid_id: kidId, ...channel }),
  });

  if (!res.ok) {
    throw new Error(`pushChannels failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Mark that AI channel generation has been completed for a kid.
 * @param {string} kidId
 * @returns {Promise<{ ok: boolean }>}
 */
export async function markChannelsGenerated(kidId) {
  const res = await fetch(`${SERVER_URL}/api/worker/kid/${encodeURIComponent(kidId)}/channels-generated`, {
    method: 'POST',
    headers: workerHeaders(),
  });

  if (!res.ok) {
    throw new Error(`markChannelsGenerated failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Set the channels_status for a kid.
 * @param {string} kidId
 * @param {'idle'|'generating'|'ready'|'refining'} status
 * @returns {Promise<{ ok: boolean }>}
 */
export async function setKidStatus(kidId, status) {
  const res = await fetch(`${SERVER_URL}/api/worker/kid/${encodeURIComponent(kidId)}/status`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify({ status }),
  });

  if (!res.ok) {
    throw new Error(`setKidStatus failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Fetch unprocessed feedback for a kid.
 * @param {string} kidId
 * @returns {Promise<Array<{ id: number, kid_id: string, message: string, processed: number }>>}
 */
export async function fetchFeedback(kidId) {
  const res = await fetch(`${SERVER_URL}/api/worker/kid/${encodeURIComponent(kidId)}/feedback`, {
    headers: workerHeaders(),
  });

  if (!res.ok) {
    throw new Error(`fetchFeedback failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.feedback;
}

/**
 * Mark a feedback entry as processed.
 * @param {number} feedbackId
 * @returns {Promise<{ ok: boolean }>}
 */
export async function markFeedbackProcessed(feedbackId) {
  const res = await fetch(`${SERVER_URL}/api/worker/feedback/${feedbackId}/processed`, {
    method: 'POST',
    headers: workerHeaders(),
  });

  if (!res.ok) {
    throw new Error(`markFeedbackProcessed failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Reject a channel for a kid (worker-side).
 * @param {string} kidId
 * @param {string} channelId
 * @returns {Promise<{ ok: boolean }>}
 */
export async function rejectChannel(kidId, channelId) {
  const res = await fetch(
    `${SERVER_URL}/api/worker/kid/${encodeURIComponent(kidId)}/channels/${encodeURIComponent(channelId)}/reject`,
    { method: 'POST', headers: workerHeaders() },
  );

  if (!res.ok) {
    throw new Error(`rejectChannel failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Fetch all channels (all statuses) for a kid.
 * @param {string} kidId
 * @returns {Promise<Array<{ channel_id: string, title: string, status: string }>>}
 */
export async function fetchKidChannels(kidId) {
  const res = await fetch(`${SERVER_URL}/api/worker/kid/${encodeURIComponent(kidId)}/channels`, {
    headers: workerHeaders(),
  });

  if (!res.ok) {
    throw new Error(`fetchKidChannels failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.channels;
}
