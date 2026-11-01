#!/usr/bin/env node
/**
 * Seed the curated_channels table from data/seed-channels.json.
 * Idempotent: uses INSERT OR IGNORE so re-running is safe.
 *
 * Usage:
 *   node scripts/seed-curated.js [--db path/to/yourtube.db]
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, '..');

// Allow overriding the db path via --db flag
const dbFlagIndex = process.argv.indexOf('--db');
const dbPath = dbFlagIndex !== -1
  ? process.argv[dbFlagIndex + 1]
  : join(SERVER_ROOT, 'data', 'yourtube.db');

const seedPath = join(SERVER_ROOT, 'migrations', 'seed-channels.json');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ensure all migrations (including 004-curated-channels) are applied
runMigrations(db);

const channels = JSON.parse(readFileSync(seedPath, 'utf8'));

const insert = db.prepare(`
  INSERT OR IGNORE INTO curated_channels
    (channel_id, title, description, interests, age_min, age_max, quality, source)
  VALUES
    (@channel_id, @title, @description, @interests, @age_min, @age_max, @quality, @source)
`);

const seedAll = db.transaction((rows) => {
  let inserted = 0;
  for (const row of rows) {
    const result = insert.run({
      ...row,
      interests: JSON.stringify(row.interests),
    });
    inserted += result.changes;
  }
  return inserted;
});

const inserted = seedAll(channels);
console.log(`Seeded ${inserted} new rows (${channels.length - inserted} already present).`);

db.close();
