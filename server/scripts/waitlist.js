#!/usr/bin/env node
/**
 * List waitlist emails, oldest first, plus signup-cap status.
 *
 * On production:
 *   ~/.fly/bin/flyctl ssh console --app yourtube-me -C 'node /app/scripts/waitlist.js'
 */
import Database from 'better-sqlite3';
import { getSignupStatus } from '../lib/signup-cap.js';

const db = new Database(process.env.YOURTUBE_DB_PATH || '/data/yourtube.sqlite', { readonly: true });
const rows = db.prepare('SELECT email, created_at FROM waitlist ORDER BY created_at').all();
const status = getSignupStatus(db);

console.log(`Signups: ${status.limited ? `${status.used}/${status.slots} new places used` : 'unlimited'}, ${status.open ? 'open' : 'FULL'}`);
console.log(`Waitlist: ${rows.length}`);
// Escape anything non-printable so stored text can't drive the terminal.
const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
for (const r of rows) console.log(`  ${safe(r.created_at)}  ${safe(r.email)}`);
