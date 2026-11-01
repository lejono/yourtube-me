import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SESSION_SECRET, ADMIN_PASSWORD } from '../config.js';
import * as store from './store.js';

const SESSIONS_FILE = 'sessions.json';
const COOKIE_NAME = 'session';

export function hashPassword(password) {
  return createHmac('sha256', SESSION_SECRET).update(password).digest('hex');
}

export function verifyPassword(password, hash) {
  const candidate = hashPassword(password);
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function signValue(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

export async function createSession(res, username) {
  const sessionId = randomBytes(16).toString('hex');
  const sessions = await store.read(SESSIONS_FILE, {});
  sessions[sessionId] = { createdAt: new Date().toISOString(), username: username || null };
  await store.write(SESSIONS_FILE, sessions);

  const signature = signValue(sessionId);
  const cookie = `${COOKIE_NAME}=${sessionId}.${signature}; HttpOnly; Path=/; SameSite=Lax`;
  res.setHeader('Set-Cookie', cookie);
  return sessionId;
}

export async function validateSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;

  const dotIndex = raw.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const sessionId = raw.slice(0, dotIndex);
  const signature = raw.slice(dotIndex + 1);
  const expected = signValue(sessionId);

  if (signature !== expected) return null;

  const sessions = await store.read(SESSIONS_FILE, {});
  if (!sessions[sessionId]) return null;

  return sessionId;
}

export async function getSessionUser(req) {
  const sessionId = await validateSession(req);
  if (!sessionId) return null;
  const sessions = await store.read(SESSIONS_FILE, {});
  return sessions[sessionId]?.username || null;
}

export async function destroySession(req, res) {
  const sessionId = await validateSession(req);
  if (sessionId) {
    const sessions = await store.read(SESSIONS_FILE, {});
    delete sessions[sessionId];
    await store.write(SESSIONS_FILE, sessions);
  }
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export async function requireAdmin(req, res) {
  const sessionId = await validateSession(req);
  if (!sessionId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}
