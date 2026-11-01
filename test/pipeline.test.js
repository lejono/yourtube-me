/**
 * Integration tests for the full recommendation pipeline.
 *
 * Tests that the system generates video options a kid would like based on
 * the taste profile, filters out inappropriate content via the AI filter,
 * suggests adjacent/discovery content via Up Next, and respects channel
 * approval, blocks, and content guidelines throughout.
 *
 * Claude CLI is mocked — the mock returns decisions that reflect what a
 * real classifier would do given the profile and guidelines, so we can
 * verify the pipeline wires everything together correctly.
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Isolated data dir
const testDataName = `test-data-pipeline-${randomBytes(4).toString('hex')}`;
process.env.YOURTUBE_DATA_DIR = testDataName;

const { generateFeed } = await import('../lib/feed.js');
const {
  classifyVideos,
  classifyWithCache,
  _setExecForTesting,
} = await import('../lib/filter.js');
const {
  getUpNext,
  vetUpNext,
  gatherCandidates,
  _setScraperForTesting,
  _setSearchForTesting,
} = await import('../lib/upnext.js');
const {
  setChannels, setVideos, setBlocked,
  setConfig, setProfile, setAICache,
  setUpNextCache,
} = await import('../lib/store.js');
const { DATA_DIR } = await import('../config.js');

after(async () => {
  _setExecForTesting(null);
  _setScraperForTesting(null);
  _setSearchForTesting(null);
  await rm(DATA_DIR, { recursive: true, force: true });
});

// --- Realistic test data ---

const PROFILE = {
  interests: ['theoretical physics', 'mathematics', 'yoga', 'indie music'],
  preferredFormats: ['academic lectures', 'music videos', 'tutorials'],
  avoidPatterns: ['gaming', 'pranks', 'violence', 'reaction videos'],
  discoveryTerms: ['quantum gravity lecture', 'yoga flow', 'indie rock video'],
};

const GUIDELINES = 'No violent content. No videos about weapons or fighting. Educational content preferred. Music and yoga are fine.';

const CHANNELS = {
  physics: {
    channelId: 'UC_physics',
    title: 'Quantum Physics Lectures',
    description: 'University lectures on quantum mechanics',
    approved: true, blocked: false,
  },
  yoga: {
    channelId: 'UC_yoga',
    title: 'Yoga With Sarah',
    description: 'Yoga for all levels',
    approved: true, blocked: false,
  },
  music: {
    channelId: 'UC_music',
    title: 'Indie Sounds',
    description: 'Indie and alternative music',
    approved: true, blocked: false,
  },
  gaming: {
    channelId: 'UC_gaming',
    title: 'Pro Gamer Zone',
    description: 'Gaming walkthroughs and reviews',
    approved: false, blocked: false,
  },
  violence: {
    channelId: 'UC_violence',
    title: 'Action Clips',
    description: 'Action movie compilations',
    approved: false, blocked: true,
  },
  cooking: {
    channelId: 'UC_cooking',
    title: 'Kitchen Adventures',
    description: 'Recipes and cooking tips',
    approved: true, blocked: false,
  },
};

function makeVideos() {
  return {
    // Physics videos — should appear in feed (approved channel, matches profile)
    'vid_physics_1': {
      title: 'Introduction to Quantum Entanglement',
      channelId: 'UC_physics', channelTitle: 'Quantum Physics Lectures',
      description: 'A rigorous introduction to quantum entanglement for undergraduates',
      tags: ['physics', 'quantum', 'entanglement', 'lecture'],
      categoryId: '27', publishedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    },
    'vid_physics_2': {
      title: 'Path Integrals in Quantum Field Theory',
      channelId: 'UC_physics', channelTitle: 'Quantum Physics Lectures',
      description: 'Graduate-level lecture on Feynman path integrals',
      tags: ['physics', 'QFT', 'path integrals'],
      categoryId: '27', publishedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    },
    // Yoga videos — should appear (approved, matches profile)
    'vid_yoga_1': {
      title: '30-Minute Morning Yoga Flow',
      channelId: 'UC_yoga', channelTitle: 'Yoga With Sarah',
      description: 'Start your day with this gentle morning yoga routine',
      tags: ['yoga', 'morning', 'flow', 'beginner'],
      categoryId: '17', publishedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    },
    'vid_yoga_2': {
      title: 'Yoga for Flexibility — Deep Stretch',
      channelId: 'UC_yoga', channelTitle: 'Yoga With Sarah',
      description: 'Improve your flexibility with this 45-minute deep stretch session',
      tags: ['yoga', 'flexibility', 'stretch'],
      categoryId: '17', publishedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    },
    // Music videos — should appear (approved, matches profile)
    'vid_music_1': {
      title: 'Radiohead — Everything In Its Right Place (Live)',
      channelId: 'UC_music', channelTitle: 'Indie Sounds',
      description: 'Live performance from 2001',
      tags: ['radiohead', 'live', 'indie', 'alternative'],
      categoryId: '10', publishedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    },
    // Gaming video — should NOT appear (channel not approved)
    'vid_gaming_1': {
      title: 'Fortnite Chapter 5 — Best Kills Compilation',
      channelId: 'UC_gaming', channelTitle: 'Pro Gamer Zone',
      description: 'Epic kills montage from Season 2',
      tags: ['fortnite', 'gaming', 'kills', 'compilation'],
      categoryId: '20', publishedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    },
    // Violence channel video — should NOT appear (channel blocked)
    'vid_violence_1': {
      title: 'Most Intense Fight Scenes in Cinema',
      channelId: 'UC_violence', channelTitle: 'Action Clips',
      description: 'Top 10 brutal fight scenes from action movies',
      tags: ['fights', 'action', 'violence', 'compilation'],
      categoryId: '24', publishedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    },
    // Cooking video — approved channel, should appear in feed
    'vid_cooking_1': {
      title: 'Easy Pasta Recipe for Kids',
      channelId: 'UC_cooking', channelTitle: 'Kitchen Adventures',
      description: 'Simple and fun pasta recipe the whole family can enjoy',
      tags: ['cooking', 'recipe', 'kids', 'pasta'],
      categoryId: '26', publishedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
    },
  };
}

async function seedFullState() {
  await setChannels(Object.values(CHANNELS));
  await setVideos(makeVideos());
  await setBlocked({ channels: ['UC_violence'], videos: [] });
  await setConfig({ guidelines: GUIDELINES, searchBudgetPerDay: 10 });
  await setProfile(PROFILE);
  await setAICache({});
  await setUpNextCache({});
}

// --- Pipeline integration tests ---

describe('Feed generation with realistic data', () => {
  beforeEach(seedFullState);

  test('feed only includes videos from approved, non-blocked channels', async () => {
    const feed = await generateFeed();
    const channelIds = new Set(feed.map(v => v.channelId));

    assert.ok(channelIds.has('UC_physics'), 'physics channel should be in feed');
    assert.ok(channelIds.has('UC_yoga'), 'yoga channel should be in feed');
    assert.ok(channelIds.has('UC_music'), 'music channel should be in feed');
    assert.ok(channelIds.has('UC_cooking'), 'cooking channel should be in feed');
    assert.ok(!channelIds.has('UC_gaming'), 'unapproved gaming channel should be excluded');
    assert.ok(!channelIds.has('UC_violence'), 'blocked violence channel should be excluded');
  });

  test('feed excludes individually blocked videos', async () => {
    await setBlocked({ channels: ['UC_violence'], videos: ['vid_physics_1'] });
    const feed = await generateFeed();
    const videoIds = feed.map(v => v.videoId);

    assert.ok(!videoIds.includes('vid_physics_1'), 'individually blocked video excluded');
    assert.ok(videoIds.includes('vid_physics_2'), 'other physics video still included');
  });

  test('feed respects channel filter', async () => {
    const feed = await generateFeed({ channel: 'UC_yoga' });
    assert.ok(feed.length > 0, 'should have yoga videos');
    assert.ok(feed.every(v => v.channelId === 'UC_yoga'), 'all videos from yoga channel');
  });

  test('recent videos appear more frequently near the top', async () => {
    // Run 100 shuffles and check that the 1-day-old physics video
    // appears in the top 3 more often than the 10-day-old yoga video
    let recentInTop3 = 0;
    let oldInTop3 = 0;

    for (let i = 0; i < 100; i++) {
      const feed = await generateFeed();
      const top3Ids = feed.slice(0, 3).map(v => v.videoId);
      if (top3Ids.includes('vid_physics_1')) recentInTop3++;
      if (top3Ids.includes('vid_yoga_2')) oldInTop3++;
    }

    assert.ok(
      recentInTop3 > oldInTop3,
      `recent video should appear in top 3 more often (got ${recentInTop3} vs ${oldInTop3})`
    );
  });

  test('feed includes thumbnail for every video', async () => {
    const feed = await generateFeed();
    for (const v of feed) {
      assert.ok(v.thumbnail, `video ${v.videoId} should have a thumbnail`);
    }
  });
});

describe('AI filter with profile and guidelines', () => {
  beforeEach(async () => {
    await seedFullState();
  });

  const context = {
    profile: PROFILE,
    guidelines: GUIDELINES,
    blockedChannels: ['UC_violence'],
    blockedVideos: [],
  };

  test('approves videos matching the taste profile', async () => {
    _setExecForTesting(async () => JSON.stringify([
      { videoId: 'vid_physics_1', approved: true, reason: 'educational physics content' },
    ]));

    const physicsVideo = {
      videoId: 'vid_physics_1',
      title: 'Introduction to Quantum Entanglement',
      channelTitle: 'Quantum Physics Lectures',
      description: 'A rigorous introduction to quantum entanglement',
      tags: ['physics', 'quantum'],
      categoryId: '27',
    };

    const result = await classifyVideos([physicsVideo], context);
    assert.equal(result.length, 1);
    assert.equal(result[0].approved, true);
    assert.equal(result[0].videoId, 'vid_physics_1');
  });

  test('rejects violent content based on guidelines', async () => {
    _setExecForTesting(async () => JSON.stringify([
      { videoId: 'vid_violence_1', approved: false, reason: 'contains violence — violates guidelines' },
    ]));

    const violentVideo = {
      videoId: 'vid_violence_1',
      title: 'Most Intense Fight Scenes in Cinema',
      channelTitle: 'Action Clips',
      description: 'Top 10 brutal fight scenes',
      tags: ['fights', 'action', 'violence'],
      categoryId: '24',
    };

    const result = await classifyVideos([violentVideo], context);
    assert.equal(result[0].approved, false);
    assert.ok(result[0].reason.includes('violence'), 'reason should mention violence');
  });

  test('rejects gaming content when avoidPatterns includes gaming', async () => {
    _setExecForTesting(async (prompt) => {
      assert.ok(prompt.includes('gaming'), 'prompt should include avoidPatterns');
      return JSON.stringify([
        { videoId: 'vid_gaming_1', approved: false, reason: 'gaming content — not in taste profile' },
      ]);
    });

    const gamingVideo = {
      videoId: 'vid_gaming_1',
      title: 'Fortnite Chapter 5 — Best Kills Compilation',
      channelTitle: 'Pro Gamer Zone',
      description: 'Epic kills montage',
      tags: ['fortnite', 'gaming', 'kills'],
      categoryId: '20',
    };

    const result = await classifyVideos([gamingVideo], context);
    assert.equal(result[0].approved, false);
  });

  test('prompt includes profile, guidelines, and blocklists', async () => {
    let capturedPrompt = '';
    _setExecForTesting(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify([{ videoId: 'v1', approved: true, reason: 'ok' }]);
    });

    await classifyVideos([{ videoId: 'v1', title: 'Test' }], context);

    assert.ok(capturedPrompt.includes('Parent Guidelines'), 'prompt has guidelines section');
    assert.ok(capturedPrompt.includes('No violent content'), 'prompt has actual guideline text');
    assert.ok(capturedPrompt.includes('Taste Profile'), 'prompt has profile section');
    assert.ok(capturedPrompt.includes('theoretical physics'), 'prompt has profile interests');
    assert.ok(capturedPrompt.includes('Blocked'), 'prompt has blocked section');
    assert.ok(capturedPrompt.includes('UC_violence'), 'prompt includes blocked channel');
  });

  test('classifyWithCache caches decisions and reuses them', async () => {
    let callCount = 0;
    _setExecForTesting(async () => {
      callCount++;
      return JSON.stringify([
        { videoId: 'v1', approved: true, reason: 'educational' },
        { videoId: 'v2', approved: false, reason: 'violent' },
      ]);
    });

    const videos = [
      { videoId: 'v1', title: 'Quantum Lecture' },
      { videoId: 'v2', title: 'Street Fight Compilation' },
    ];

    // First call — should hit Claude
    const first = await classifyWithCache(videos, context);
    assert.equal(callCount, 1);
    assert.equal(first[0].approved, true);
    assert.equal(first[1].approved, false);

    // Second call — should use cache, not Claude
    const second = await classifyWithCache(videos, context);
    assert.equal(callCount, 1, 'should not call Claude again for cached videos');
    assert.equal(second[0].approved, true);
    assert.equal(second[1].approved, false);
  });

  test('mixed batch: cached + uncached videos', async () => {
    let calledWith = [];
    _setExecForTesting(async (prompt) => {
      // Extract video IDs from prompt by checking which ones are mentioned
      const ids = [];
      if (prompt.includes('v_new')) ids.push('v_new');
      if (prompt.includes('v_cached')) ids.push('v_cached');
      calledWith = ids;
      return JSON.stringify(ids.map(id => ({
        videoId: id, approved: true, reason: 'ok',
      })));
    });

    // Pre-cache one video
    await setAICache({
      'v_cached': { approved: true, reason: 'was cached', timestamp: new Date().toISOString() },
    });

    const videos = [
      { videoId: 'v_cached', title: 'Cached Video' },
      { videoId: 'v_new', title: 'New Video' },
    ];

    const result = await classifyWithCache(videos, context);
    assert.equal(result.length, 2);
    assert.deepEqual(calledWith, ['v_new'], 'only uncached video sent to Claude');
    assert.equal(result[0].reason, 'was cached', 'cached video uses cache');
    assert.equal(result[1].reason, 'ok', 'new video gets fresh classification');
  });
});

describe('Up Next pipeline', () => {
  beforeEach(async () => {
    await seedFullState();
    _setScraperForTesting(null);
    _setSearchForTesting(null);
  });

  test('gatherCandidates finds same-channel videos', async () => {
    const currentVideo = {
      title: 'Introduction to Quantum Entanglement',
      channelId: 'UC_physics',
      channelTitle: 'Quantum Physics Lectures',
    };

    const candidates = await gatherCandidates('vid_physics_1', currentVideo, {
      blockedChannelIds: new Set(['UC_violence']),
      blockedVideoIds: new Set(),
    });

    // Should find vid_physics_2 from same channel
    const ids = candidates.map(c => c.videoId);
    assert.ok(ids.includes('vid_physics_2'), 'finds other video from same channel');
    assert.ok(!ids.includes('vid_physics_1'), 'excludes current video');
    assert.ok(!ids.includes('vid_violence_1'), 'excludes blocked channel videos');
  });

  test('gatherCandidates excludes blocked videos', async () => {
    const currentVideo = {
      title: 'Test', channelId: 'UC_physics', channelTitle: 'Physics',
    };

    const candidates = await gatherCandidates('vid_physics_1', currentVideo, {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(['vid_physics_2']),
    });

    const ids = candidates.map(c => c.videoId);
    assert.ok(!ids.includes('vid_physics_2'), 'blocked video excluded from candidates');
  });

  test('gatherCandidates uses scraper results when available', async () => {
    _setScraperForTesting(async () => [
      { id: 'vid_scraped_1', title: 'Related Physics Talk', channel: 'Another Channel' },
      { id: 'vid_scraped_2', title: 'Math Foundations', channel: 'Math Channel' },
      { id: 'vid_scraped_3', title: 'Quantum Computing', channel: 'CS Channel' },
    ]);

    const currentVideo = {
      title: 'Quantum Entanglement', channelId: 'UC_physics',
    };

    const candidates = await gatherCandidates('vid_physics_1', currentVideo, {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(),
    });

    const ids = candidates.map(c => c.videoId);
    assert.ok(ids.includes('vid_scraped_1'), 'scraper result included');
    assert.ok(ids.includes('vid_scraped_2'), 'scraper result included');
  });

  test('gatherCandidates falls back to search when scraper yields few results', async () => {
    _setScraperForTesting(async () => [
      { id: 'vid_scraped_1', title: 'One Result', channel: 'Ch' },
    ]);

    _setSearchForTesting(async (query) => [
      { videoId: 'vid_search_1', title: 'Search Result 1', channelId: 'UC_s1' },
      { videoId: 'vid_search_2', title: 'Search Result 2', channelId: 'UC_s2' },
    ]);

    const currentVideo = {
      title: 'Quantum Entanglement', channelId: 'UC_physics',
    };

    const candidates = await gatherCandidates('vid_physics_1', currentVideo, {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(),
    });

    const ids = candidates.map(c => c.videoId);
    assert.ok(ids.includes('vid_scraped_1'), 'scraper result present');
    assert.ok(ids.includes('vid_search_1'), 'search fallback result present');
  });

  test('gatherCandidates skips search when scraper yields enough results', async () => {
    _setScraperForTesting(async () => [
      { id: 'vid_s1', title: 'R1', channel: 'C' },
      { id: 'vid_s2', title: 'R2', channel: 'C' },
      { id: 'vid_s3', title: 'R3', channel: 'C' },
    ]);

    let searchCalled = false;
    _setSearchForTesting(async () => {
      searchCalled = true;
      return [];
    });

    const currentVideo = { title: 'Test', channelId: 'UC_physics' };
    await gatherCandidates('vid_physics_1', currentVideo, {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(),
    });

    assert.ok(!searchCalled, 'search not called when scraper has enough');
  });

  test('vetUpNext filters candidates through AI and caches approved picks', async () => {
    _setScraperForTesting(async () => [
      { id: 'vid_related_physics', title: 'Quantum Gravity Lecture', channel: 'Physics TV' },
      { id: 'vid_related_gaming', title: 'Fortnite Best Moments', channel: 'Game TV' },
      { id: 'vid_related_yoga', title: 'Evening Yoga Flow', channel: 'Yoga TV' },
    ]);

    // AI filter: approve physics and yoga, reject gaming
    _setExecForTesting(async (prompt) => {
      const decisions = [];
      // Check which candidate videos are in the prompt
      if (prompt.includes('vid_related_physics'))
        decisions.push({ videoId: 'vid_related_physics', approved: true, reason: 'appropriate' });
      if (prompt.includes('vid_related_gaming'))
        decisions.push({ videoId: 'vid_related_gaming', approved: false, reason: 'gaming content' });
      if (prompt.includes('vid_related_yoga'))
        decisions.push({ videoId: 'vid_related_yoga', approved: true, reason: 'appropriate' });
      // Also handle same-channel videos that appear as candidates
      for (const id of ['vid_physics_2', 'vid_yoga_1', 'vid_yoga_2', 'vid_music_1', 'vid_cooking_1']) {
        if (prompt.includes(id))
          decisions.push({ videoId: id, approved: true, reason: 'approved channel' });
      }
      return JSON.stringify(decisions);
    });

    await vetUpNext('vid_physics_1');

    const result = await getUpNext('vid_physics_1');
    assert.equal(result.complete, true);
    assert.equal(result.source, 'cache');

    const pickIds = result.picks.map(p => p.videoId);
    assert.ok(pickIds.includes('vid_related_physics'), 'physics pick approved');
    assert.ok(pickIds.includes('vid_related_yoga'), 'yoga pick approved');
    assert.ok(!pickIds.includes('vid_related_gaming'), 'gaming pick rejected');
  });

  test('getUpNext returns backfill when no cache exists', async () => {
    const result = await getUpNext('vid_physics_1');
    assert.ok(result.picks.length > 0, 'should return backfill picks');
    assert.equal(result.source, 'backfill');
    assert.equal(result.complete, true);

    // Backfill comes from approved channel feed
    for (const pick of result.picks) {
      assert.ok(
        ['UC_physics', 'UC_yoga', 'UC_music', 'UC_cooking'].includes(pick.channelId),
        `backfill pick from approved channel: ${pick.channelId}`
      );
    }
  });

  test('getUpNext excludes current video from backfill', async () => {
    const result = await getUpNext('vid_physics_1');
    const ids = result.picks.map(p => p.videoId);
    assert.ok(!ids.includes('vid_physics_1'), 'current video excluded from backfill');
  });
});

describe('End-to-end: profile shapes what appears in feed and Up Next', () => {
  beforeEach(async () => {
    await seedFullState();
    _setScraperForTesting(null);
    _setSearchForTesting(null);
  });

  test('full pipeline: feed + filter + upnext with consistent profile-based decisions', async () => {
    // 1. Feed should include only approved channel videos
    const feed = await generateFeed();
    const feedChannels = new Set(feed.map(v => v.channelId));
    assert.ok(feedChannels.has('UC_physics'));
    assert.ok(feedChannels.has('UC_yoga'));
    assert.ok(!feedChannels.has('UC_gaming'));
    assert.ok(!feedChannels.has('UC_violence'));

    // 2. AI filter should approve feed videos matching profile
    _setExecForTesting(async (prompt) => {
      // Verify profile and guidelines are in the prompt
      assert.ok(prompt.includes('theoretical physics'));
      assert.ok(prompt.includes('No violent content'));

      // Build decisions for all feed videos found in prompt
      const decisions = [];
      for (const v of feed) {
        if (prompt.includes(v.videoId)) {
          decisions.push({ videoId: v.videoId, approved: true, reason: 'matches taste profile' });
        }
      }
      return JSON.stringify(decisions);
    });

    const context = {
      profile: PROFILE,
      guidelines: GUIDELINES,
      blockedChannels: ['UC_violence'],
      blockedVideos: [],
    };

    const decisions = await classifyVideos(
      feed.map(v => ({
        videoId: v.videoId, title: v.title,
        channelTitle: v.channelTitle,
        description: v.description || '',
        tags: v.tags || [], categoryId: v.categoryId || '',
      })),
      context,
    );

    assert.ok(decisions.every(d => d.approved), 'all feed videos approved');

    // 3. Up Next for a physics video should suggest related safe content
    _setScraperForTesting(async () => [
      { id: 'vid_adjacent_1', title: 'Quantum Computing for Beginners', channel: 'CS Channel' },
      { id: 'vid_adjacent_2', title: 'MMA Best Knockouts 2024', channel: 'Fight Club' },
    ]);

    _setExecForTesting(async (prompt) => {
      const decisions = [];
      if (prompt.includes('vid_adjacent_1'))
        decisions.push({ videoId: 'vid_adjacent_1', approved: true, reason: 'appropriate' });
      if (prompt.includes('vid_adjacent_2'))
        decisions.push({ videoId: 'vid_adjacent_2', approved: false, reason: 'violent content' });
      // Same-channel and other approved channel videos
      for (const id of ['vid_physics_2', 'vid_yoga_1', 'vid_yoga_2', 'vid_music_1', 'vid_cooking_1']) {
        if (prompt.includes(id))
          decisions.push({ videoId: id, approved: true, reason: 'approved channel' });
      }
      return JSON.stringify(decisions);
    });

    await vetUpNext('vid_physics_1');
    const upnext = await getUpNext('vid_physics_1');

    assert.equal(upnext.complete, true);
    assert.equal(upnext.source, 'cache');

    const upnextIds = upnext.picks.map(p => p.videoId);
    assert.ok(upnextIds.includes('vid_adjacent_1'), 'adjacent quantum video approved');
    assert.ok(!upnextIds.includes('vid_adjacent_2'), 'violent video rejected');
  });

  test('blocking a channel mid-session removes its videos from Up Next cache', async () => {
    // Pre-cache up-next with a video from cooking channel
    await setUpNextCache({
      'vid_physics_1': {
        picks: [
          { videoId: 'vid_cooking_1', title: 'Easy Pasta', channelId: 'UC_cooking', channelTitle: 'Kitchen Adventures' },
          { videoId: 'vid_yoga_1', title: 'Morning Yoga', channelId: 'UC_yoga', channelTitle: 'Yoga With Sarah' },
        ],
        generatedAt: new Date().toISOString(),
        candidateCount: 5,
      },
    });

    // Block the cooking channel
    await setBlocked({ channels: ['UC_violence', 'UC_cooking'], videos: [] });

    const result = await getUpNext('vid_physics_1');
    const pickIds = result.picks.map(p => p.videoId);

    assert.ok(!pickIds.includes('vid_cooking_1'), 'blocked channel video removed from cached picks');
    assert.ok(pickIds.includes('vid_yoga_1'), 'non-blocked video still present');
  });

  test('blocking a video mid-session removes it from Up Next cache', async () => {
    await setUpNextCache({
      'vid_physics_1': {
        picks: [
          { videoId: 'vid_yoga_1', title: 'Morning Yoga', channelId: 'UC_yoga', channelTitle: 'Yoga With Sarah' },
          { videoId: 'vid_music_1', title: 'Radiohead Live', channelId: 'UC_music', channelTitle: 'Indie Sounds' },
        ],
        generatedAt: new Date().toISOString(),
        candidateCount: 5,
      },
    });

    await setBlocked({ channels: ['UC_violence'], videos: ['vid_yoga_1'] });

    const result = await getUpNext('vid_physics_1');
    const pickIds = result.picks.map(p => p.videoId);

    assert.ok(!pickIds.includes('vid_yoga_1'), 'blocked video removed from picks');
    assert.ok(pickIds.includes('vid_music_1'), 'non-blocked video still present');
  });

  test('unapproving a channel removes its videos from the feed', async () => {
    // Start with cooking approved
    let feed = await generateFeed();
    assert.ok(feed.some(v => v.channelId === 'UC_cooking'), 'cooking videos in feed initially');

    // Unapprove cooking
    const channels = Object.values(CHANNELS).map(ch =>
      ch.channelId === 'UC_cooking' ? { ...ch, approved: false } : ch
    );
    await setChannels(channels);

    feed = await generateFeed();
    assert.ok(!feed.some(v => v.channelId === 'UC_cooking'), 'cooking videos removed after unapproval');
  });

  test('AI filter gracefully degrades when Claude is unavailable', async () => {
    _setExecForTesting(async () => {
      throw new Error('Claude CLI not available');
    });

    const videos = [
      { videoId: 'v1', title: 'Quantum Lecture', channelTitle: 'Physics' },
      { videoId: 'v2', title: 'Yoga Flow', channelTitle: 'Yoga' },
    ];

    const context = {
      profile: PROFILE,
      guidelines: GUIDELINES,
      blockedChannels: [],
      blockedVideos: [],
    };

    const result = await classifyVideos(videos, context);

    // All videos should be approved (unclassified fallback)
    assert.equal(result.length, 2);
    assert.ok(result.every(d => d.approved), 'all videos approved when Claude unavailable');
    assert.ok(
      result.every(d => d.reason.includes('unclassified')),
      'reason indicates unclassified'
    );
  });
});

describe('Discovery: adjacent content suggestions', () => {
  beforeEach(async () => {
    await seedFullState();
  });

  test('scraper provides adjacent content from outside approved channels', async () => {
    // Simulate YouTube sidebar suggesting adjacent educational content
    _setScraperForTesting(async () => [
      { id: 'vid_discovery_1', title: 'String Theory Explained Simply', channel: 'SciShow' },
      { id: 'vid_discovery_2', title: 'Yoga Nidra for Sleep', channel: 'Yoga Journal' },
      { id: 'vid_discovery_3', title: 'The Math Behind Music', channel: 'Numberphile' },
    ]);

    _setExecForTesting(async (prompt) => {
      const decisions = [];
      const knownIds = [
        'vid_discovery_1', 'vid_discovery_2', 'vid_discovery_3',
        'vid_physics_2', 'vid_yoga_1', 'vid_yoga_2', 'vid_music_1', 'vid_cooking_1',
      ];
      for (const id of knownIds) {
        if (prompt.includes(id))
          decisions.push({ videoId: id, approved: true, reason: 'educational content' });
      }
      return JSON.stringify(decisions);
    });

    await vetUpNext('vid_physics_1');
    const result = await getUpNext('vid_physics_1');

    assert.equal(result.source, 'cache');
    const titles = result.picks.map(p => p.title);
    assert.ok(titles.some(t => t.includes('String Theory')), 'adjacent physics content discovered');
  });

  test('search fallback discovers content using video title as query', async () => {
    _setScraperForTesting(async () => []); // No scraper results

    let searchQuery = '';
    _setSearchForTesting(async (query) => {
      searchQuery = query;
      return [
        { videoId: 'vid_found_1', title: 'Quantum Entanglement Explained', channelId: 'UC_edu' },
      ];
    });

    const currentVideo = {
      title: 'Introduction to Quantum Entanglement',
      channelId: 'UC_physics',
    };

    const candidates = await gatherCandidates('vid_physics_1', currentVideo, {
      blockedChannelIds: new Set(),
      blockedVideoIds: new Set(),
    });

    assert.equal(searchQuery, 'Introduction to Quantum Entanglement');
    assert.ok(
      candidates.some(c => c.videoId === 'vid_found_1'),
      'search result included in candidates'
    );
  });
});
