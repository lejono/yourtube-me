export const SERVER_URL = process.env.YOURTUBE_SERVER_URL || 'https://yourtube.me';
export const WORKER_KEY = process.env.YOURTUBE_WORKER_KEY || '';
export const POLL_INTERVAL_MS = parseInt(process.env.YOURTUBE_POLL_INTERVAL || '1800000');
export const AI_FILTER_ENABLED = process.env.YOURTUBE_AI_FILTER_ENABLED !== 'false';

// Liveness signal for an external watchdog. When set, the worker touches
// <dir>/fast.heartbeat after each successful (authenticated) manifest fetch
// in the fast loop, and <dir>/slow.heartbeat at the end of each completed
// slow pass. Both matter: the worker never exits on failure — a bad key
// 401s forever, and a hung RSS fetch stalls only the slow loop — so process
// state alone says nothing about health. Unset = no heartbeat files.
export const HEARTBEAT_DIR = process.env.YOURTUBE_WORKER_HEARTBEAT_DIR || '';
