import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WORDS } from './words.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

let _db = null;

/**
 * Encode a Buffer as base64url (no padding, URL-safe chars).
 */
function toBase64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate a random URL-safe ID.
 * @param {number} bytes - Number of random bytes (default 12 produces 16 base64url chars)
 * @returns {string}
 */
export function generateId(bytes = 12) {
  return toBase64url(randomBytes(bytes));
}

/**
 * Generate a 3-word setup code (e.g. "apple-rocket-dinosaur").
 * Easy for a parent to read aloud and a kid to type.
 * @returns {string}
 */
export function generateSetupToken() {
  const pick = () => WORDS[randomBytes(2).readUInt16BE(0) % WORDS.length];
  return `${pick()}-${pick()}-${pick()}`;
}

/**
 * Open (or return cached) the SQLite database.
 * @param {string} [dbPath] - Path to database file. Defaults to data/yourtube.db next to server root.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb(dbPath) {
  if (_db) return _db;

  const resolvedPath = dbPath ?? join(__dirname, '..', 'data', 'yourtube.db');
  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

/**
 * Run all pending migrations from the migrations directory.
 * Tracks applied migrations in a _migrations table.
 * Idempotent - safe to call multiple times.
 * @param {import('better-sqlite3').Database} db
 */
export function runMigrations(db) {
  // Ensure migration tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

/**
 * Close and release the cached database connection.
 */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
