import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { generateId } from './db.js';

const SESSION_TTL_DAYS = 30;
const COOKIE_NAME = 'yt_session';

// --- Password hashing ---

/**
 * Hash a password using scrypt.
 * @param {string} password
 * @param {string} [salt] - Hex string. Generated randomly if omitted.
 * @returns {{ hash: string, salt: string }} Both values are hex strings.
 */
export function hashPassword(password, salt) {
  const saltBuf = salt ? Buffer.from(salt, 'hex') : randomBytes(32);
  const hashBuf = scryptSync(password, saltBuf, 64);
  return {
    hash: hashBuf.toString('hex'),
    salt: saltBuf.toString('hex'),
  };
}

/**
 * Verify a password against a stored hash + salt.
 * Uses constant-time comparison to prevent timing attacks.
 * @param {string} password
 * @param {string} storedHash - Hex string
 * @param {string} salt - Hex string
 * @returns {boolean}
 */
export function verifyPassword(password, storedHash, salt) {
  try {
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- Family (account) management ---

/**
 * Create a new family account.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @param {string} password
 * @returns {{ id: string, email: string }}
 */
export function createFamily(db, email, password) {
  const id = generateId();
  const { hash, salt } = hashPassword(password);

  db.prepare(
    `INSERT INTO families (id, email, password_hash, password_salt)
     VALUES (?, ?, ?, ?)`
  ).run(id, email, hash, salt);

  return { id, email };
}

/**
 * Authenticate a family by email + password.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @param {string} password
 * @returns {{ id: string, email: string } | null} null if credentials invalid
 */
export function authenticateFamily(db, email, password) {
  const row = db.prepare('SELECT * FROM families WHERE email = ?').get(email);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash, row.password_salt)) return null;
  return { id: row.id, email: row.email };
}

// --- Sessions ---

/**
 * Create a new session for a family.
 * @param {import('better-sqlite3').Database} db
 * @param {string} familyId
 * @returns {string} session ID
 */
export function createSession(db, familyId) {
  const id = generateId(24); // 32 base64url chars — more entropy for session tokens
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19); // SQLite datetime format: "YYYY-MM-DD HH:MM:SS"

  db.prepare(
    `INSERT INTO sessions (id, family_id, expires_at) VALUES (?, ?, ?)`
  ).run(id, familyId, expiresAt);

  return id;
}

/**
 * Validate a session ID.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @returns {{ id: string, family_id: string, expires_at: string } | null}
 */
export function validateSession(db, sessionId) {
  const row = db
    .prepare(`SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')`)
    .get(sessionId);
  return row ?? null;
}

/**
 * Destroy (delete) a session.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 */
export function destroySession(db, sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// --- Cookie helpers ---

/**
 * Read the session ID from the request cookie header.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
export function getSessionFromCookie(req) {
  const cookieHeader = req.headers.cookie ?? '';
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name.trim() === COOKIE_NAME) {
      return decodeURIComponent(rest.join('=').trim());
    }
  }
  return null;
}

/**
 * Set the session cookie on a response.
 * @param {import('node:http').ServerResponse} res
 * @param {string} sessionId
 */
export function setSessionCookie(res, sessionId) {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/${secure}`;
  res.setHeader('Set-Cookie', cookie);
}

/**
 * Clear the session cookie on a response.
 * @param {import('node:http').ServerResponse} res
 */
export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/${secure}`);
}
