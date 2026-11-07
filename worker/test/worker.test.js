/**
 * Tests for worker/worker.js — main polling loop.
 *
 * Dependencies (fetchRSS, classifyVideos, fetchManifest, pushVideos) are
 * injected via _setDeps() so no network or Claude CLI calls occur.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { processKid, runFastLoop, runSlowLoop, shouldRefreshKidFeed, _setDeps } from '../worker.js';
import { refineChannels, _setExecForTesting } from '../lib/channel-gen.js';

afterEach(() => {
  _setDeps(null);
  _setExecForTesting(null);
});

// --- Fixtures ---

const KID = {
  kid_id: 'kid-abc',
  kid_name: 'Alice',
  age: 9,
  guidelines: 'No scary stuff',
  channels: [
    { channel_id: 'UC_ch1', title: 'Channel One' },
    { channel_id: 'UC_ch2', title: 'Channel Two' },
  ],
};

function makeEntry(videoId, channelTitle = 'SomeChannel') {
  return {
    videoId,
    title: `Video ${videoId}`,
    channelTitle,
    publishedAt: '2024-03-15T10:00:00+00:00',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

// --- processKid tests ---

describe('processKid', () => {
  test('fetches RSS for all channels and returns push-ready video array', async () => {
    const fetchedChannels = [];
    _setDeps({
      fetchRSS: async (channelId) => {
        fetchedChannels.push(channelId);
        return [makeEntry(`${channelId}_v1`), makeEntry(`${channelId}_v2`)];
      },
      classifyVideos: async (videos) => {
        return videos.map(v => ({ videoId: v.videoId, approved: true, reason: 'ok' }));
      },
    });

    const result = await processKid(KID);

    assert.deepEqual(fetchedChannels.sort(), ['UC_ch1', 'UC_ch2']);
    assert.equal(result.length, 4); // 2 channels x 2 videos
  });

  test('videos have correct push-ready shape', async () => {
    _setDeps({
      fetchRSS: async (channelId) => [makeEntry('vid1', 'MyChannel')],
      classifyVideos: async (videos) => [{ videoId: 'vid1', approved: true, reason: 'great' }],
    });

    const kid = { ...KID, channels: [{ channel_id: 'UC_ch1', title: 'Channel One' }] };
    const result = await processKid(kid);

    assert.equal(result.length, 1);
    const v = result[0];

    // Required fields
    assert.ok('video_id' in v, 'should have video_id');
    assert.ok('title' in v, 'should have title');
    assert.ok('channel_id' in v, 'should have channel_id');
    assert.ok('channel_title' in v, 'should have channel_title');
    assert.ok('published_at' in v, 'should have published_at');
    assert.ok('thumbnail' in v, 'should have thumbnail');
    assert.ok('ai_approved' in v, 'should have ai_approved');
    assert.ok('ai_reason' in v, 'should have ai_reason');

    // Field types
    assert.equal(typeof v.ai_approved, 'boolean');
    assert.equal(typeof v.ai_reason, 'string');

    // Correct values
    assert.equal(v.video_id, 'vid1');
    assert.equal(v.channel_id, 'UC_ch1');
    assert.equal(v.ai_approved, true);
    assert.equal(v.ai_reason, 'great');
  });

  test('handles RSS fetch failure for one channel gracefully — other channels still processed', async () => {
    _setDeps({
      fetchRSS: async (channelId) => {
        if (channelId === 'UC_ch1') throw new Error('Network timeout');
        return [makeEntry(`${channelId}_v1`)];
      },
      classifyVideos: async (videos) => {
        return videos.map(v => ({ videoId: v.videoId, approved: true, reason: 'ok' }));
      },
    });

    const result = await processKid(KID);

    // UC_ch1 failed, UC_ch2 succeeded with 1 video
    assert.equal(result.length, 1);
    assert.ok(result[0].channel_id === 'UC_ch2');
  });

  test('returns empty array for kid with no channels', async () => {
    _setDeps({
      fetchRSS: async () => [],
      classifyVideos: async () => [],
    });

    const kid = { ...KID, channels: [] };
    const result = await processKid(kid);
    assert.deepEqual(result, []);
  });

  test('passes age and guidelines to classifyVideos', async () => {
    let capturedContext = null;
    _setDeps({
      fetchRSS: async () => [makeEntry('v1')],
      classifyVideos: async (videos, context) => {
        capturedContext = context;
        return [{ videoId: 'v1', approved: true, reason: 'ok' }];
      },
    });

    await processKid(KID);

    assert.ok(capturedContext, 'classifyVideos should have been called');
    assert.equal(capturedContext.age, KID.age);
    assert.equal(capturedContext.guidelines, KID.guidelines);
  });

  test('channel_id in result comes from channels list, not RSS channelTitle', async () => {
    _setDeps({
      fetchRSS: async (channelId) => [makeEntry('v1', 'RSS Channel Name')],
      classifyVideos: async (videos) => [{ videoId: 'v1', approved: true, reason: 'ok' }],
    });

    const kid = { ...KID, channels: [{ channel_id: 'UC_exact_id', title: 'My Channel' }] };
    const result = await processKid(kid);

    assert.equal(result[0].channel_id, 'UC_exact_id');
  });
});

// --- runFastLoop tests ---

describe('runFastLoop', () => {
  test('only processes kids needing initial channel generation (channels_generated=0, channels_status=idle)', async () => {
    const processedKids = [];
    _setDeps({
      fetchManifest: async () => [
        // Needs generation: no channels yet, not generated, status idle
        {
          kid_id: 'kid-needs-gen',
          kid_name: 'Needs Gen',
          age: 9,
          interests: ['gaming'],
          guidelines: null,
          channels: [],
          channels_generated: 0,
          channels_status: 'idle',
        },
        // Already generated
        {
          kid_id: 'kid-already-done',
          kid_name: 'Already Done',
          age: 10,
          interests: ['science'],
          guidelines: null,
          channels: [{ channel_id: 'UC_x', title: 'Some Channel' }],
          channels_generated: 1,
          channels_status: 'ready',
        },
        // Server set 'generating' because custom interests need Opus — worker should process
        {
          kid_id: 'kid-generating',
          kid_name: 'Generating',
          age: 8,
          interests: ['art'],
          guidelines: null,
          channels: [],
          channels_generated: 0,
          channels_status: 'generating',
        },
      ],
      setKidStatus: async (kidId, status) => { processedKids.push({ kidId, status }); },
      generateChannels: async () => [],
      resolveChannelBySearch: async () => null,
      pushChannels: async () => {},
    });

    await runFastLoop();

    // Both 'idle' and 'generating' kids should be processed (generating means
    // the server flagged custom interests for Opus). Already-done kid is skipped.
    const generatedFor = processedKids.map(p => p.kidId);
    assert.ok(generatedFor.includes('kid-needs-gen'), 'should process kid needing generation');
    assert.ok(!generatedFor.includes('kid-already-done'), 'should skip already done kid');
    assert.ok(generatedFor.includes('kid-generating'), 'should process kid with status=generating (server flagged custom interests)');
  });

  test('sets channels_status to generating before starting and ready when done', async () => {
    const statusCalls = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-1',
          kid_name: 'Kid One',
          age: 9,
          interests: ['lego'],
          guidelines: null,
          channels: [],
          channels_generated: 0,
          channels_status: 'idle',
        },
      ],
      setKidStatus: async (kidId, status) => { statusCalls.push({ kidId, status }); },
      generateChannels: async () => [{ name: 'Lego Channel', reason: 'fun', searchQuery: 'Lego YT', description: 'Lego content' }],
      resolveChannelBySearch: async () => 'UC_lego',
      pushChannels: async () => {},
    });

    await runFastLoop();

    assert.equal(statusCalls[0]?.status, 'generating', 'first call should set status to generating');
    assert.equal(statusCalls[statusCalls.length - 1]?.status, 'ready', 'last call should set status to ready');
    assert.ok(statusCalls.every(c => c.kidId === 'kid-1'), 'all status calls should be for kid-1');
  });

  test('pushes channels as pending via pushChannels with reason field', async () => {
    const pushedChannels = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-2',
          kid_name: 'Kid Two',
          age: 8,
          interests: ['minecraft'],
          guidelines: null,
          channels: [],
          channels_generated: 0,
          channels_status: 'idle',
        },
      ],
      setKidStatus: async () => {},
      generateChannels: async () => [
        { name: 'Dream', reason: 'Popular Minecraft', searchQuery: 'Dream Minecraft', description: 'Minecraft speedrunner.' },
      ],
      resolveChannelBySearch: async (query) => 'UC_dream',
      pushChannels: async (kidId, channel) => { pushedChannels.push({ kidId, ...channel }); },
    });

    await runFastLoop();

    assert.equal(pushedChannels.length, 1);
    assert.equal(pushedChannels[0].kidId, 'kid-2');
    assert.equal(pushedChannels[0].channel_id, 'UC_dream');
    assert.equal(pushedChannels[0].title, 'Dream');
    assert.ok(pushedChannels[0].status === 'pending', 'channel should be pushed as pending');
  });

  test('still sets ready status even if channel resolution fails for all suggestions', async () => {
    const statusCalls = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-3',
          kid_name: 'Kid Three',
          age: 7,
          interests: ['drawing'],
          guidelines: null,
          channels: [],
          channels_generated: 0,
          channels_status: 'idle',
        },
      ],
      setKidStatus: async (kidId, status) => { statusCalls.push(status); },
      generateChannels: async () => [{ name: 'ArtChannel', reason: 'art', searchQuery: 'art', description: 'Art' }],
      resolveChannelBySearch: async () => null,
      pushChannels: async () => {},
    });

    await runFastLoop();

    assert.ok(statusCalls.includes('ready'), 'should still set ready even if no channels resolved');
  });
});

// --- runSlowLoop tests ---

describe('runSlowLoop', () => {
  test('only processes kids with at least one approved channel', async () => {
    const processedKidIds = [];
    _setDeps({
      fetchManifest: async () => [
        // Has approved channels — should be processed
        {
          kid_id: 'kid-with-channels',
          kid_name: 'With Channels',
          age: 9,
          guidelines: null,
          channels: [{ channel_id: 'UC_a', title: 'Chan A' }],
          channels_generated: 1,
          channels_status: 'ready',
          approved_video_count: 0,
          watched_video_count: 0,
          unwatched_video_count: 0,
          last_pushed_at: null,
        },
        // No channels — should be skipped
        {
          kid_id: 'kid-no-channels',
          kid_name: 'No Channels',
          age: 7,
          guidelines: null,
          channels: [],
          channels_generated: 0,
          channels_status: 'idle',
        },
      ],
      fetchRSS: async (channelId) => {
        processedKidIds.push(channelId);
        return [];
      },
      classifyVideos: async () => [],
      pushVideos: async () => {},
    });

    await runSlowLoop();

    assert.ok(processedKidIds.includes('UC_a'), 'should process kid with channels');
    assert.ok(!processedKidIds.includes('kid-no-channels'), 'should skip kid with no channels');
  });

  test('pushes processed videos to server', async () => {
    const pushed = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-rss',
          kid_name: 'RSS Kid',
          age: 10,
          guidelines: 'safe content',
          channels: [{ channel_id: 'UC_rss', title: 'RSS Channel' }],
          channels_generated: 1,
          channels_status: 'ready',
          approved_video_count: 0,
          watched_video_count: 0,
          unwatched_video_count: 0,
          last_pushed_at: null,
        },
      ],
      fetchRSS: async () => [makeEntry('v-rss-1')],
      classifyVideos: async (videos) => videos.map(v => ({ videoId: v.videoId, approved: true, reason: 'ok' })),
      pushVideos: async (kidId, videos) => { pushed.push({ kidId, count: videos.length }); },
    });

    await runSlowLoop();

    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].kidId, 'kid-rss');
    assert.equal(pushed[0].count, 1);
  });

  test('records empty refresh attempts for a feed that already has videos', async () => {
    const pushed = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-empty-rss',
          kid_name: 'Empty RSS',
          channels: [{ channel_id: 'UC_empty', title: 'Empty Channel' }],
          approved_video_count: 10,
          watched_video_count: 6,
          unwatched_video_count: 4,
          last_watched_at: new Date().toISOString(),
          last_pushed_at: null,
        },
      ],
      fetchRSS: async () => [],
      classifyVideos: async () => [],
      pushVideos: async (kidId, videos) => { pushed.push({ kidId, count: videos.length }); },
    });

    await runSlowLoop();

    assert.deepEqual(pushed, [{ kidId: 'kid-empty-rss', count: 0 }]);
  });

  test('an EMPTY feed whose refresh finds nothing is not recorded, and is retried after 2h, not 24h', async () => {
    const pushed = [];
    let fetches = 0;
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-empty-feed',
          kid_name: 'Empty Feed',
          channels: [{ channel_id: 'UC_flaky', title: 'Flaky Channel' }],
          approved_video_count: 0,
          watched_video_count: 0,
          unwatched_video_count: 0,
          last_pushed_at: null,
        },
      ],
      fetchRSS: async () => { fetches++; return []; },
      classifyVideos: async () => [],
      pushVideos: async (kidId, videos) => { pushed.push({ kidId, count: videos.length }); },
    });

    await runSlowLoop();
    assert.deepEqual(pushed, [], 'empty result must not mark the feed as filled');
    assert.equal(fetches, 1);

    // Next loop (30 min later in production): still inside the 2h back-off
    await runSlowLoop();
    assert.equal(fetches, 1, 'no retry within 2 hours');
  });

  test('skips kids whose approved feed is still healthy', async () => {
    let fetchCalled = false;
    // Dates are relative to now: a fixed past date would trip the staleness
    // rule and skip for the wrong reason, hiding the ratio branch under test.
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-healthy',
          kid_name: 'Healthy',
          channels: [{ channel_id: 'UC_healthy', title: 'Healthy Channel' }],
          approved_video_count: 10,
          watched_video_count: 4,
          unwatched_video_count: 6,
          last_watched_at: daysAgo(1),
          last_pushed_at: daysAgo(2),
        },
      ],
      fetchRSS: async () => { fetchCalled = true; return [makeEntry('v1')]; },
      classifyVideos: async () => [],
      pushVideos: async () => {},
    });

    await runSlowLoop();

    assert.equal(fetchCalled, false, 'healthy feed should not fetch RSS');
  });

  test('skips low feeds refreshed less than 24h ago', async () => {
    let fetchCalled = false;
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-recent',
          kid_name: 'Recent',
          channels: [{ channel_id: 'UC_recent', title: 'Recent Channel' }],
          approved_video_count: 10,
          watched_video_count: 5,
          unwatched_video_count: 5,
          last_watched_at: '2026-05-01 10:00:00',
          last_pushed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      ],
      fetchRSS: async () => { fetchCalled = true; return [makeEntry('v1')]; },
      classifyVideos: async () => [],
      pushVideos: async () => {},
    });

    await runSlowLoop();

    assert.equal(fetchCalled, false, 'recently refreshed feed should not fetch RSS');
  });

  test('refreshes low feeds older than 24h', async () => {
    let fetchCount = 0;
    const pushed = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-low',
          kid_name: 'Low',
          channels: [{ channel_id: 'UC_low', title: 'Low Channel' }],
          approved_video_count: 10,
          watched_video_count: 5,
          unwatched_video_count: 5,
          last_watched_at: '2026-05-01 10:00:00',
          last_pushed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        },
      ],
      fetchRSS: async () => { fetchCount += 1; return [makeEntry('v-low')]; },
      classifyVideos: async (videos) => videos.map(v => ({ videoId: v.videoId, approved: true, reason: 'ok' })),
      pushVideos: async (kidId, videos) => { pushed.push({ kidId, count: videos.length }); },
    });

    await runSlowLoop();

    assert.equal(fetchCount, 1);
    assert.deepEqual(pushed, [{ kidId: 'kid-low', count: 1 }]);
  });

  test('uses a per-loop RSS cache for shared channels', async () => {
    let fetchCount = 0;
    const pushed = [];
    const stalePush = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-a',
          kid_name: 'Kid A',
          channels: [{ channel_id: 'UC_shared', title: 'Shared Channel' }],
          approved_video_count: 2,
          watched_video_count: 1,
          unwatched_video_count: 1,
          last_watched_at: '2026-05-01 10:00:00',
          last_pushed_at: stalePush,
        },
        {
          kid_id: 'kid-b',
          kid_name: 'Kid B',
          channels: [{ channel_id: 'UC_shared', title: 'Shared Channel' }],
          approved_video_count: 2,
          watched_video_count: 1,
          unwatched_video_count: 1,
          last_watched_at: '2026-05-01 10:00:00',
          last_pushed_at: stalePush,
        },
      ],
      fetchRSS: async () => {
        fetchCount += 1;
        return [makeEntry('shared-v1')];
      },
      classifyVideos: async (videos) => videos.map(v => ({ videoId: v.videoId, approved: true, reason: 'ok' })),
      pushVideos: async (kidId, videos) => { pushed.push({ kidId, count: videos.length }); },
    });

    await runSlowLoop();

    assert.equal(fetchCount, 1);
    assert.deepEqual(pushed, [
      { kidId: 'kid-a', count: 1 },
      { kidId: 'kid-b', count: 1 },
    ]);
  });
});

describe('shouldRefreshKidFeed', () => {
  test('skips old server manifests that do not include feed stats', () => {
    const decision = shouldRefreshKidFeed({
      kid_name: 'Old Manifest',
      channels: [{ channel_id: 'UC_old', title: 'Old Channel' }],
    });

    assert.equal(decision.refresh, false);
    assert.equal(decision.reason, 'manifest missing feed stats');
  });

  test('allows initial fill for a kid with approved channels but no videos', () => {
    const decision = shouldRefreshKidFeed({
      kid_name: 'Initial',
      channels: [{ channel_id: 'UC_initial', title: 'Initial Channel' }],
      approved_video_count: 0,
      watched_video_count: 0,
      unwatched_video_count: 0,
      last_pushed_at: null,
    });

    assert.equal(decision.refresh, true);
    assert.equal(decision.reason, 'initial feed fill');
  });

  // A used feed that stops being topped up is the failure mode that stranded
  // A beta kid for three months: 37% watched, so the ratio trigger never fired.
  const usedKid = (over) => ({
    kid_name: 'Used',
    channels: [{ channel_id: 'UC_x', title: 'Channel' }],
    approved_video_count: 299,
    watched_video_count: 112,
    unwatched_video_count: 187,
    last_watched_at: '2026-06-16 15:59:49',
    ...over,
  });

  const NOW = Date.parse('2026-08-08T12:00:00Z');

  test('refreshes a stale feed even when little of it has been watched', () => {
    const decision = shouldRefreshKidFeed(
      usedKid({ last_pushed_at: '2026-05-02 14:29:55' }),
      NOW
    );

    assert.equal(decision.refresh, true);
    assert.match(decision.reason, /^feed stale \(last topped up \d+ days ago\)$/);
  });

  test('leaves a recently topped-up feed alone', () => {
    const decision = shouldRefreshKidFeed(
      usedKid({ last_pushed_at: '2026-08-01 09:00:00' }),
      NOW
    );

    assert.equal(decision.refresh, false);
    assert.match(decision.reason, /^feed healthy/);
  });

  test('refreshes a feed in use that has never been topped up', () => {
    const decision = shouldRefreshKidFeed(
      usedKid({
        approved_video_count: 26,
        watched_video_count: 5,
        unwatched_video_count: 21,
        last_pushed_at: null,
      }),
      NOW
    );

    assert.equal(decision.refresh, true);
    assert.equal(decision.reason, 'feed in use but never topped up');
  });

  test('does not refresh a stale feed nobody has ever watched', () => {
    const decision = shouldRefreshKidFeed(
      usedKid({
        watched_video_count: 0,
        unwatched_video_count: 299,
        last_watched_at: null,
        last_pushed_at: '2026-05-02 14:29:55',
      }),
      NOW
    );

    assert.equal(decision.refresh, false);
    assert.equal(decision.reason, 'feed has not been used yet');
  });

  test('daily rate limit still wins over staleness', () => {
    const decision = shouldRefreshKidFeed(
      usedKid({ last_pushed_at: '2026-08-08T09:00:00Z' }),
      NOW
    );

    assert.equal(decision.refresh, false);
    assert.equal(decision.reason, 'refreshed less than 24h ago');
  });
});

// --- Feedback loop (processFeedback via runFastLoop) ---

describe('runFastLoop: feedback processing', () => {
  test('processes feedback for kid with channels_status=refining', async () => {
    const pushedChannels = [];
    const markedProcessed = [];
    const statusCalls = [];

    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-refine',
          kid_name: 'Refine Kid',
          age: 10,
          interests: ['science'],
          guidelines: null,
          channels: [{ channel_id: 'UC_approved', title: 'Science Channel', status: 'approved' }],
          channels_generated: 1,
          channels_status: 'refining',
        },
      ],
      fetchFeedback: async (kidId) => [
        { id: 42, kid_id: kidId, message: 'More maths content please', processed: 0 },
      ],
      fetchKidChannels: async () => [
        { channel_id: 'UC_approved', title: 'Science Channel', status: 'approved' },
      ],
      refineChannels: async (_profile, _channels, messages) => {
        assert.ok(messages.includes('More maths content please'));
        return [
          { name: 'Numberphile', description: 'Maths videos', reason: 'Matches interest', searchQuery: 'Numberphile YouTube' },
        ];
      },
      resolveChannelBySearch: async () => 'UC_numberphile',
      pushChannels: async (kidId, channel) => { pushedChannels.push({ kidId, ...channel }); },
      markFeedbackProcessed: async (id) => { markedProcessed.push(id); },
      setKidStatus: async (kidId, status) => { statusCalls.push({ kidId, status }); },
      // Not needed but prevent accidental generation calls:
      generateChannels: async () => [],
    });

    await runFastLoop();

    assert.equal(pushedChannels.length, 1);
    assert.equal(pushedChannels[0].title, 'Numberphile');
    assert.equal(pushedChannels[0].status, 'pending');
    assert.ok(markedProcessed.includes(42), 'feedback 42 should be marked processed');
    assert.equal(statusCalls[statusCalls.length - 1].status, 'ready', 'final status should be ready');
  });

  test('sets status to ready even when no suggestions returned', async () => {
    const statusCalls = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-empty-refine',
          kid_name: 'Empty Refine',
          age: 8,
          interests: ['art'],
          guidelines: null,
          channels: [],
          channels_generated: 1,
          channels_status: 'refining',
        },
      ],
      fetchFeedback: async () => [{ id: 99, kid_id: 'kid-empty-refine', message: 'More art', processed: 0 }],
      fetchKidChannels: async () => [],
      refineChannels: async () => [],
      resolveChannelBySearch: async () => null,
      pushChannels: async () => {},
      markFeedbackProcessed: async () => {},
      setKidStatus: async (kidId, status) => { statusCalls.push({ kidId, status }); },
      generateChannels: async () => [],
    });

    await runFastLoop();

    assert.ok(statusCalls.some(c => c.status === 'ready'), 'should set status to ready');
  });

  test('sets status to ready immediately when no unprocessed feedback', async () => {
    const statusCalls = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-no-feedback',
          kid_name: 'No Feedback',
          age: 9,
          interests: ['gaming'],
          guidelines: null,
          channels: [],
          channels_generated: 1,
          channels_status: 'refining',
        },
      ],
      fetchFeedback: async () => [],
      fetchKidChannels: async () => [],
      refineChannels: async () => [],
      resolveChannelBySearch: async () => null,
      pushChannels: async () => {},
      markFeedbackProcessed: async () => {},
      setKidStatus: async (kidId, status) => { statusCalls.push({ kidId, status }); },
      generateChannels: async () => [],
    });

    await runFastLoop();

    assert.ok(statusCalls.some(c => c.status === 'ready'), 'should set status to ready when feedback is empty');
  });
});

// --- Guidelines review (via runFastLoop) ---

describe('runFastLoop: guidelines review', () => {
  test('reviews pending channels against guidelines and rejects incompatible ones', async () => {
    const rejectedChannels = [];
    const statusCalls = [];

    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-guidelines',
          kid_name: 'Guidelines Kid',
          age: 9,
          interests: ['science', 'sports'],
          guidelines: 'No competitive content',
          channels: [
            { channel_id: 'UC_mark', title: 'Mark Rober' },
            { channel_id: 'UC_dude', title: 'Dude Perfect' },
          ],
          channels_generated: 0,
          channels_status: 'reviewing',
        },
      ],
      fetchKidChannels: async () => [
        { channel_id: 'UC_mark', title: 'Mark Rober', status: 'pending', reason: 'Engineering videos' },
        { channel_id: 'UC_dude', title: 'Dude Perfect', status: 'pending', reason: 'Sports tricks' },
      ],
      reviewChannelsAgainstGuidelines: async (_profile, channels) => {
        return [
          { title: 'Mark Rober', compatible: true, reason: 'Educational, non-competitive' },
          { title: 'Dude Perfect', compatible: false, reason: 'Competitive sports stunts' },
        ];
      },
      rejectChannel: async (kidId, channelId) => { rejectedChannels.push({ kidId, channelId }); },
      setKidStatus: async (kidId, status) => { statusCalls.push({ kidId, status }); },
      generateChannels: async () => [],
    });

    await runFastLoop();

    assert.equal(rejectedChannels.length, 1);
    assert.equal(rejectedChannels[0].channelId, 'UC_dude');
    assert.ok(statusCalls.some(c => c.status === 'ready'), 'should set status to ready after review');
  });

  test('sets status to ready even if Opus review returns empty', async () => {
    const statusCalls = [];
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-empty-review',
          kid_name: 'Empty Review',
          age: 8,
          interests: ['art'],
          guidelines: 'Only calm content',
          channels: [{ channel_id: 'UC_art', title: 'Art Channel' }],
          channels_generated: 0,
          channels_status: 'reviewing',
        },
      ],
      fetchKidChannels: async () => [
        { channel_id: 'UC_art', title: 'Art Channel', status: 'pending', reason: 'Art' },
      ],
      reviewChannelsAgainstGuidelines: async () => [],
      rejectChannel: async () => {},
      setKidStatus: async (kidId, status) => { statusCalls.push({ kidId, status }); },
      generateChannels: async () => [],
    });

    await runFastLoop();

    assert.ok(statusCalls.some(c => c.status === 'ready'), 'should set status to ready');
  });

  test('skips review if kid has no guidelines despite reviewing status', async () => {
    const statusCalls = [];
    let reviewCalled = false;
    _setDeps({
      fetchManifest: async () => [
        {
          kid_id: 'kid-no-guidelines',
          kid_name: 'No Guidelines',
          age: 9,
          interests: ['gaming'],
          guidelines: null,
          channels: [{ channel_id: 'UC_x', title: 'Gaming' }],
          channels_generated: 0,
          channels_status: 'reviewing',
        },
      ],
      fetchKidChannels: async () => [],
      reviewChannelsAgainstGuidelines: async () => { reviewCalled = true; return []; },
      rejectChannel: async () => {},
      setKidStatus: async (kidId, status) => { statusCalls.push({ kidId, status }); },
      generateChannels: async () => [],
    });

    await runFastLoop();

    assert.equal(reviewCalled, false, 'should not call Opus review when no guidelines');
    assert.ok(statusCalls.some(c => c.status === 'ready'), 'should flip to ready');
  });
});

// --- refineChannels (channel-gen.js) ---

describe('refineChannels', () => {
  test('returns refined channel suggestions', async () => {
    _setExecForTesting(async (prompt) => {
      assert.ok(prompt.includes('More maths'), 'prompt should include feedback');
      assert.ok(prompt.includes('Science Channel'), 'prompt should include approved channels');
      return JSON.stringify({
        channels: [
          { name: 'Numberphile', description: 'Maths for everyone', reason: 'Matches feedback', searchQuery: 'Numberphile YouTube' },
        ],
      });
    });

    const kidProfile = { kid_name: 'Alex', age: 9, interests: ['science'], guidelines: null };
    const currentChannels = [{ title: 'Science Channel', status: 'approved' }];
    const feedbackMessages = ['More maths'];

    const result = await refineChannels(kidProfile, currentChannels, feedbackMessages);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Numberphile');
    assert.ok(result[0].description);
  });

  test('returns empty array when CLI fails', async () => {
    _setExecForTesting(async () => { throw new Error('CLI unavailable'); });

    const result = await refineChannels({ kid_name: 'Sam', age: 8, interests: [], guidelines: null }, [], ['test']);
    assert.deepEqual(result, []);
  });

  test('prompt includes rejected channels', async () => {
    let capturedPrompt = null;
    _setExecForTesting(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ channels: [] });
    });

    const currentChannels = [
      { title: 'Gaming World', status: 'rejected' },
      { title: 'Science Now', status: 'approved' },
    ];
    await refineChannels({ kid_name: 'Sam', age: 10, interests: ['science'], guidelines: null }, currentChannels, ['Less gaming']);

    assert.ok(capturedPrompt.includes('Gaming World'), 'prompt should include rejected channel');
    assert.ok(capturedPrompt.includes('Science Now'), 'prompt should include approved channel');
  });
});
