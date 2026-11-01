/**
 * Tests for lib/scraper.js
 *
 * All tests run with SCRAPER_ENABLED unset (defaults to false), so they pass
 * without playwright installed.  Playwright-dependent paths (timeout, navigation
 * errors) are tested in the conditional block below when playwright IS present.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The scraper reads SCRAPER_ENABLED from config.js at import time.
// With no env var set the module treats scraping as disabled, so every call
// returns [] immediately — matching the "disabled" and "not available" tests.
import { isAvailable, scrapeRelatedVideos } from '../lib/scraper.js';

// ---------------------------------------------------------------------------
// Always-passing tests (no playwright required)
// ---------------------------------------------------------------------------

describe('scraper — disabled by default', () => {
  test('isAvailable() returns false when SCRAPER_ENABLED is not set', async () => {
    const result = await isAvailable();
    assert.equal(result, false);
  });

  test('scrapeRelatedVideos returns empty array when scraper is disabled', async () => {
    const result = await scrapeRelatedVideos('dQw4w9WgXcQ');
    assert.deepEqual(result, []);
  });

  test('returns empty array for empty string videoId', async () => {
    const result = await scrapeRelatedVideos('');
    assert.deepEqual(result, []);
  });

  test('returns empty array for null videoId — does not throw', async () => {
    const result = await scrapeRelatedVideos(null);
    assert.deepEqual(result, []);
  });

  test('returns empty array for undefined videoId — does not throw', async () => {
    const result = await scrapeRelatedVideos(undefined);
    assert.deepEqual(result, []);
  });

  test('returns empty array for garbage input — does not throw', async () => {
    const result = await scrapeRelatedVideos({ not: 'a string' });
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// Playwright integration tests — skipped when playwright is not installed
// ---------------------------------------------------------------------------

let playwrightAvailable = false;
try {
  await import('playwright');
  playwrightAvailable = true;
} catch { /* not installed */ }

describe('scraper — with playwright (skipped if not installed)', { skip: !playwrightAvailable }, () => {
  // These tests need SCRAPER_ENABLED=true to exercise the playwright code paths.
  // Run with:  SCRAPER_ENABLED=true node --test test/scraper.test.js
  const scraperEnabled = process.env.SCRAPER_ENABLED === 'true';

  test('returns empty array on navigation timeout', { skip: !scraperEnabled }, async () => {
    // Use a video ID that is very unlikely to exist so we get a quick failure,
    // but rely on the module's own error handling to catch it.
    const result = await scrapeRelatedVideos('__invalid_id_that_should_fail__');
    assert.deepEqual(result, []);
  });

  test('returns empty array for completely invalid URL', { skip: !scraperEnabled }, async () => {
    const result = await scrapeRelatedVideos('!!!');
    assert.deepEqual(result, []);
  });

  test('does not throw when playwright is available but video is invalid', { skip: !scraperEnabled }, async () => {
    let threw = false;
    try {
      await scrapeRelatedVideos(null);
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });
});
