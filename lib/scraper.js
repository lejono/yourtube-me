/**
 * Optional Playwright scraper for YouTube related-video sidebar.
 *
 * This module is best-effort only. Every function returns an empty array on
 * any error and never throws. Callers should treat results as "nice to have".
 *
 * Enabled only when SCRAPER_ENABLED=true in the environment.
 */

import { SCRAPER_ENABLED, SCRAPER_TIMEOUT_MS } from '../config.js';

// Log the "playwright not installed" warning at most once per process
let _warnedMissing = false;

/**
 * Return true if the scraper is enabled in config AND playwright is installed.
 *
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
  if (!SCRAPER_ENABLED) return false;
  try {
    await import('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * Scrape YouTube's related-video sidebar for the given video.
 *
 * Returns an array of candidate objects with shape:
 *   { id: string, title: string, channel: string, thumbnail: string }
 *
 * Returns [] on any failure — never throws.
 *
 * @param {string} videoId
 * @returns {Promise<Array<{id:string, title:string, channel:string, thumbnail:string}>>}
 */
export async function scrapeRelatedVideos(videoId) {
  if (!SCRAPER_ENABLED) return [];

  // Ensure we have a usable videoId
  if (!videoId) return [];

  let pw;
  try {
    pw = await import('playwright');
  } catch {
    if (!_warnedMissing) {
      console.warn('[scraper] playwright is not installed — scraping disabled');
      _warnedMissing = true;
    }
    return [];
  }

  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Suppress unnecessary network requests to speed things up
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort());

    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      timeout: SCRAPER_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });

    // Wait for at least one related-video item
    await page.waitForSelector('ytd-compact-video-renderer', {
      timeout: SCRAPER_TIMEOUT_MS,
    });

    const candidates = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('ytd-compact-video-renderer');

      for (const item of items) {
        try {
          const titleEl = item.querySelector('a#video-title');
          if (!titleEl) continue;

          const href = titleEl.getAttribute('href') || '';
          const match = href.match(/[?&]v=([A-Za-z0-9_-]+)/);
          if (!match) continue;

          const id = match[1];
          const title = titleEl.textContent?.trim() || '';
          if (!id || !title) continue;

          const channelEl = item.querySelector('ytd-channel-name a, #channel-name a, yt-formatted-string.ytd-channel-name');
          const channel = channelEl?.textContent?.trim() || '';

          const thumbEl = item.querySelector('#thumbnail img, img.yt-img-shadow');
          // YouTube lazy-loads thumbnails; prefer data-src if src is a placeholder
          const thumbnail = thumbEl?.getAttribute('data-src') || thumbEl?.src || '';

          results.push({ id, title, channel, thumbnail });
        } catch {
          // skip malformed item
        }
      }

      return results;
    });

    return candidates;
  } catch (err) {
    console.warn('[scraper] scrapeRelatedVideos failed:', err.message);
    return [];
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore close errors */ }
    }
  }
}
