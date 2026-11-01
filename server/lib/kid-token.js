import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateId, generateSetupToken } from './db.js';

const KID_COOKIE_NAME = 'yt_kid';
const KID_COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

// --- Internal helpers ---

/**
 * Get the HMAC secret from the environment.
 * @returns {string}
 */
function getSecret() {
  const secret = process.env.YOURTUBE_SESSION_SECRET;
  if (!secret) throw new Error('YOURTUBE_SESSION_SECRET is not set');
  return secret;
}

/**
 * Compute HMAC-SHA256 over a message with the session secret.
 * Returns a hex string.
 * @param {string} message
 * @returns {string}
 */
function computeHmac(message) {
  return createHmac('sha256', getSecret()).update(message).digest('hex');
}

/**
 * Verify an HMAC in constant time.
 * @param {string} message
 * @param {string} candidate - hex string to verify
 * @returns {boolean}
 */
function verifyHmac(message, candidate) {
  try {
    const expected = computeHmac(message);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(candidate, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- Kid CRUD ---

/**
 * Create a new kid record for a family.
 * @param {import('better-sqlite3').Database} db
 * @param {string} familyId
 * @param {{ name: string, age?: number, guidelines?: string }} opts
 * @returns {{ id: string, family_id: string, name: string, age: number|null, setup_token: string, cookie_generation: number }}
 */
export function createKid(db, familyId, opts) {
  const { name, age = null, guidelines = null, interests = null } = opts;
  const id = generateId();
  const setup_token = generateSetupToken();
  const interestsJson = Array.isArray(interests) ? JSON.stringify(interests) : null;

  db.prepare(
    `INSERT INTO kids (id, family_id, name, setup_token, age, guidelines, interests)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, familyId, name, setup_token, age, guidelines, interestsJson);

  return { id, family_id: familyId, name, age, guidelines, interests, setup_token, cookie_generation: 1 };
}

/**
 * Look up a kid by their one-time setup token.
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {object|null}
 */
export function getKidBySetupToken(db, token) {
  const row = db.prepare('SELECT * FROM kids WHERE setup_token = ?').get(token);
  return row ?? null;
}

/**
 * Look up a kid by their primary key ID.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {object|null}
 */
export function getKidById(db, kidId) {
  const row = db.prepare('SELECT * FROM kids WHERE id = ?').get(kidId);
  return row ?? null;
}

/**
 * List all kids belonging to a family.
 * @param {import('better-sqlite3').Database} db
 * @param {string} familyId
 * @returns {object[]}
 */
export function listKids(db, familyId) {
  return db.prepare('SELECT * FROM kids WHERE family_id = ?').all(familyId);
}

/**
 * Update mutable fields on a kid record.
 * Only name, age, and guidelines can be changed here.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @param {{ name?: string, age?: number, guidelines?: string }} opts
 * @returns {object} updated kid row
 */
export function updateKid(db, kidId, opts) {
  const { name, age, guidelines, interests } = opts;

  const sets = [];
  const params = [];

  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (age !== undefined) { sets.push('age = ?'); params.push(age); }
  if (guidelines !== undefined) { sets.push('guidelines = ?'); params.push(guidelines); }
  if (interests !== undefined) { sets.push('interests = ?'); params.push(JSON.stringify(interests)); }

  if (sets.length > 0) {
    params.push(kidId);
    db.prepare(`UPDATE kids SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  return getKidById(db, kidId);
}

/**
 * Delete a kid and all their associated data (cascaded by FK constraints).
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 */
export function deleteKid(db, kidId) {
  db.prepare('DELETE FROM kids WHERE id = ?').run(kidId);
}

/**
 * Replace the kid's setup_token with a new random one.
 * The old token immediately stops working.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 * @returns {string} the new setup_token
 */
export function regenerateSetupToken(db, kidId) {
  const newToken = generateSetupToken();
  db.prepare('UPDATE kids SET setup_token = ? WHERE id = ?').run(newToken, kidId);
  return newToken;
}

/**
 * Increment the kid's cookie_generation, invalidating all existing signed cookies.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kidId
 */
export function revokeKidCookies(db, kidId) {
  db.prepare('UPDATE kids SET cookie_generation = cookie_generation + 1 WHERE id = ?').run(kidId);
}

// --- Cookie helpers ---

/**
 * Set a signed yt_kid cookie on the response.
 * Format: kid_id:generation:hmac(kid_id:generation)
 * @param {import('node:http').ServerResponse} res
 * @param {string} kidId
 * @param {number} generation
 */
export function setKidCookie(res, kidId, generation) {
  const payload = `${kidId}:${generation}`;
  const hmac = computeHmac(payload);
  const cookieValue = encodeURIComponent(`${payload}:${hmac}`);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${KID_COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Lax; Max-Age=${KID_COOKIE_MAX_AGE}; Path=/${secure}`;
  res.setHeader('Set-Cookie', cookie);
}

/**
 * Validate a yt_kid cookie value.
 * Checks HMAC integrity, then confirms the cookie_generation matches the DB.
 * @param {import('better-sqlite3').Database} db
 * @param {string} cookieValue - raw decoded cookie string (kid_id:generation:hmac)
 * @returns {object|null} the kid row, or null if invalid
 */
export async function validateKidCookie(db, cookieValue) {
  if (!cookieValue) return null;

  const parts = cookieValue.split(':');
  // Expect exactly 3 parts: kid_id, generation, hmac
  // Note: kid_id itself may not contain colons (it's base64url), generation is a number,
  // and hmac is a hex string — but to be safe, reconstruct from known positions.
  if (parts.length < 3) return null;

  // hmac is the last part; generation is second-to-last; kid_id is everything before that
  const hmac = parts[parts.length - 1];
  const generationStr = parts[parts.length - 2];
  const kidId = parts.slice(0, parts.length - 2).join(':');

  if (!kidId || !generationStr || !hmac) return null;

  const generation = parseInt(generationStr, 10);
  if (isNaN(generation)) return null;

  const payload = `${kidId}:${generationStr}`;
  if (!verifyHmac(payload, hmac)) return null;

  const kid = getKidById(db, kidId);
  if (!kid) return null;

  if (kid.cookie_generation !== generation) return null;

  return kid;
}

/**
 * Read and validate the yt_kid cookie from an incoming request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<object|null>} kid row or null
 */
export async function getKidFromCookie(req, db) {
  const cookieHeader = req.headers.cookie ?? '';
  let rawValue = null;

  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name.trim() === KID_COOKIE_NAME) {
      rawValue = decodeURIComponent(rest.join('=').trim());
      break;
    }
  }

  if (!rawValue) return null;
  return validateKidCookie(db, rawValue);
}
