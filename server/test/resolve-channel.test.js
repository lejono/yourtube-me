import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveChannel, _setFetchForTesting } from '../lib/resolve-channel.js';

beforeEach(() => {
  _setFetchForTesting(null); // reset to real fetch
});

// --- Already a UC* channel ID ---

test('resolveChannel returns UC* input as-is', async () => {
  const result = await resolveChannel('UC6E2mP01ZLH_kbAyeazCNdg');
  assert.equal(result.channel_id, 'UC6E2mP01ZLH_kbAyeazCNdg');
});

test('resolveChannel returns null for empty input', async () => {
  assert.equal(await resolveChannel(''), null);
  assert.equal(await resolveChannel(null), null);
  assert.equal(await resolveChannel(undefined), null);
});

// --- YouTube channel URL ---

test('resolveChannel extracts ID from youtube.com/channel/UC* URL', async () => {
  const result = await resolveChannel('https://www.youtube.com/channel/UC6E2mP01ZLH_kbAyeazCNdg');
  assert.equal(result.channel_id, 'UC6E2mP01ZLH_kbAyeazCNdg');
});

test('resolveChannel extracts ID from youtube.com/channel URL without www', async () => {
  const result = await resolveChannel('https://youtube.com/channel/UC6E2mP01ZLH_kbAyeazCNdg');
  assert.equal(result.channel_id, 'UC6E2mP01ZLH_kbAyeazCNdg');
});

// --- YouTube handle URL ---

test('resolveChannel resolves @handle URL via fetch', async () => {
  _setFetchForTesting(async () => ({
    text: async () => '"channelId":"UCfake123456789012345678" "title":"Fake Channel"',
  }));
  const result = await resolveChannel('https://www.youtube.com/@FakeHandle');
  assert.equal(result.channel_id, 'UCfake123456789012345678');
});

test('resolveChannel resolves bare @handle via fetch', async () => {
  _setFetchForTesting(async () => ({
    text: async () => '"channelId":"UCfake123456789012345678" "title":"Bare Handle"',
  }));
  const result = await resolveChannel('@FakeHandle');
  assert.equal(result.channel_id, 'UCfake123456789012345678');
});

// --- Bare name (search) ---

test('resolveChannel searches YouTube for bare channel name', async () => {
  _setFetchForTesting(async (url) => {
    assert.ok(url.includes('search_query='), 'should use search URL');
    assert.ok(url.includes('Chuff'), 'should include the channel name');
    return {
      text: async () => '"channelId":"UC7ABaoK3AFxuy_i4f6xV1tA"',
    };
  });
  const result = await resolveChannel('Chuff');
  assert.equal(result.channel_id, 'UC7ABaoK3AFxuy_i4f6xV1tA');
});

test('resolveChannel returns null when search finds nothing', async () => {
  _setFetchForTesting(async () => ({
    text: async () => '<html>no channels here</html>',
  }));
  const result = await resolveChannel('nonexistent_channel_xyz');
  assert.equal(result, null);
});

test('resolveChannel returns null when fetch fails', async () => {
  _setFetchForTesting(async () => { throw new Error('network error'); });
  const result = await resolveChannel('some channel');
  assert.equal(result, null);
});

// --- Whitespace handling ---

test('resolveChannel trims whitespace', async () => {
  const result = await resolveChannel('  UC6E2mP01ZLH_kbAyeazCNdg  ');
  assert.equal(result.channel_id, 'UC6E2mP01ZLH_kbAyeazCNdg');
});
