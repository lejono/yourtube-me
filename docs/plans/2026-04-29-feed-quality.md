# Feed Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six feed quality issues so new users get a reliable, diverse, age-appropriate experience out of the box.

**Architecture:** All changes are in the server — feed-api.js (query changes), family-api.js (channel validation, curated video filtering), and seed-channels.json (data cleanup). Each fix is independently testable.

**Tech Stack:** Node.js, better-sqlite3, node:test

---

### Task 1: Exclude pending channel videos from feed

Videos from channels with `status='pending'` should not appear until the parent approves the channel. Currently the feed only excludes `status='rejected'`.

**Files:**
- Modify: `server/lib/feed-api.js:32-34`
- Test: `server/test/feed-api.test.js`

- [ ] **Step 1: Write failing test**

In `server/test/feed-api.test.js`, add after the existing "excludes watched videos from rejected channels too" test:

```javascript
test('getKidFeed excludes videos from pending channels', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'pending-vids@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'PendingKid' });

    addChannel(db, kid.id, { channel_id: 'UC_OK', title: 'Approved Chan' });
    addChannel(db, kid.id, { channel_id: 'UC_PEND', title: 'Pending Chan', status: 'pending' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'ok1', channel_id: 'UC_OK', channel_title: 'Approved Chan', ai_approved: 1 }),
      makeVideo({ video_id: 'pend1', channel_id: 'UC_PEND', channel_title: 'Pending Chan', ai_approved: 1 }),
    ]);

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 1, 'only approved-channel videos should appear');
    assert.equal(feed.videos[0].video_id, 'ok1');
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed shows pending channel videos after channel is approved', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'approve-pending@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'ApproveKid' });

    addChannel(db, kid.id, { channel_id: 'UC_P', title: 'Was Pending', status: 'pending' });
    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'p1', channel_id: 'UC_P', channel_title: 'Was Pending', ai_approved: 1 }),
    ]);

    // Before approval: no videos
    let feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 0);

    // After approval: video appears
    db.prepare("UPDATE channels SET status = 'approved' WHERE kid_id = ? AND channel_id = ?").run(kid.id, 'UC_P');
    feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 1);
    assert.equal(feed.videos[0].video_id, 'p1');
  } finally {
    teardown(dir, db);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/feed-api.test.js 2>&1 | tail -20`
Expected: FAIL — pending channel videos still appear.

- [ ] **Step 3: Implement — change rejected filter to an approved-only filter**

In `server/lib/feed-api.js`, replace the `rejectedFilter` with an `approvedChannelFilter` that uses a whitelist approach. Videos must either come from an approved channel OR have an empty channel_id (curated wow videos):

```javascript
  // Only show videos from approved channels (or curated videos with empty channel_id)
  const approvedChannelFilter = `AND (v.channel_id = '' OR v.channel_id IN (
    SELECT channel_id FROM channels WHERE kid_id = v.kid_id AND status = 'approved'
  ))`;
```

Replace all occurrences of `${rejectedFilter}` with `${approvedChannelFilter}` in both the unwatched and watched queries.

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd server && node --test test/feed-api.test.js`
Expected: ALL PASS (including the two earlier rejected-channel tests, which should still pass since rejected channels are also not approved).

- [ ] **Step 5: Commit**

```bash
git add server/lib/feed-api.js server/test/feed-api.test.js
git commit -m "fix: exclude pending channel videos from kid feed

Only videos from parent-approved channels (or curated wow videos)
appear in the feed. Previously only rejected channels were excluded,
so pending channel videos leaked through before parent review."
```

---

### Task 2: Feed diversity — round-robin channel interleaving

Instead of pure `published_at DESC`, interleave videos from different channels so one prolific channel doesn't dominate the feed. Keep unwatched-before-watched ordering.

**Files:**
- Modify: `server/lib/feed-api.js`
- Test: `server/test/feed-api.test.js`

- [ ] **Step 1: Write failing test**

```javascript
test('getKidFeed interleaves videos from different channels', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'diversity@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'DiverseKid' });

    addChannel(db, kid.id, { channel_id: 'UC_A', title: 'Channel A' });
    addChannel(db, kid.id, { channel_id: 'UC_B', title: 'Channel B' });
    addChannel(db, kid.id, { channel_id: 'UC_C', title: 'Channel C' });

    // Channel A has 6 videos, B has 3, C has 3 — all recent
    const videos = [];
    for (let i = 0; i < 6; i++) {
      videos.push(makeVideo({
        video_id: `a${i}`, channel_id: 'UC_A', channel_title: 'Channel A',
        ai_approved: 1, published_at: `2024-06-${String(10 + i).padStart(2, '0')}`,
      }));
    }
    for (let i = 0; i < 3; i++) {
      videos.push(makeVideo({
        video_id: `b${i}`, channel_id: 'UC_B', channel_title: 'Channel B',
        ai_approved: 1, published_at: `2024-06-${String(10 + i).padStart(2, '0')}`,
      }));
    }
    for (let i = 0; i < 3; i++) {
      videos.push(makeVideo({
        video_id: `c${i}`, channel_id: 'UC_C', channel_title: 'Channel C',
        ai_approved: 1, published_at: `2024-06-${String(10 + i).padStart(2, '0')}`,
      }));
    }
    upsertVideos(db, kid.id, videos);

    const feed = getKidFeed(db, kid.id, {});
    assert.equal(feed.videos.length, 12);

    // The first 3 videos should be from 3 different channels
    const firstThreeChannels = new Set(feed.videos.slice(0, 3).map(v => v.channel_id));
    assert.equal(firstThreeChannels.size, 3, 'first 3 videos should each be from a different channel');

    // No 3 consecutive videos should be from the same channel
    for (let i = 0; i < feed.videos.length - 2; i++) {
      const consecutive = feed.videos.slice(i, i + 3);
      const sameChannel = consecutive.every(v => v.channel_id === consecutive[0].channel_id);
      assert.ok(!sameChannel, `videos ${i}-${i+2} should not all be from ${consecutive[0].channel_id}`);
    }
  } finally {
    teardown(dir, db);
  }
});

test('getKidFeed diversity still puts unwatched before watched', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'diversity-watched@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'DivWatchKid' });

    addChannel(db, kid.id, { channel_id: 'UC_X', title: 'Channel X' });
    addChannel(db, kid.id, { channel_id: 'UC_Y', title: 'Channel Y' });

    upsertVideos(db, kid.id, [
      makeVideo({ video_id: 'x1', channel_id: 'UC_X', channel_title: 'Channel X', ai_approved: 1, published_at: '2024-06-01' }),
      makeVideo({ video_id: 'y1', channel_id: 'UC_Y', channel_title: 'Channel Y', ai_approved: 1, published_at: '2024-06-02' }),
      makeVideo({ video_id: 'x2', channel_id: 'UC_X', channel_title: 'Channel X', ai_approved: 1, published_at: '2024-06-03' }),
    ]);

    recordWatch(db, kid.id, 'x2'); // Watch the newest one

    const feed = getKidFeed(db, kid.id, {});
    const watchedIdx = feed.videos.findIndex(v => v.watched === 1);
    const unwatchedAfter = feed.videos.slice(watchedIdx).filter(v => v.watched === 0);
    assert.equal(unwatchedAfter.length, 0, 'no unwatched videos should appear after watched section');
  } finally {
    teardown(dir, db);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/feed-api.test.js 2>&1 | tail -20`
Expected: FAIL — first 3 videos will all be from the channel with the newest publish dates.

- [ ] **Step 3: Implement round-robin interleaving**

In `server/lib/feed-api.js`, add an `interleave` function and apply it to both unwatched and watched video groups:

```javascript
/**
 * Round-robin interleave videos from different channels.
 * Groups by channel_id, then picks one from each channel in turn,
 * ordered by each channel's newest video first.
 */
function interleave(videos) {
  if (videos.length === 0) return videos;

  // Group by channel, preserving per-channel order (already sorted by published_at DESC)
  const buckets = new Map();
  for (const v of videos) {
    const key = v.channel_id || v.video_id; // curated videos have empty channel_id
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }

  // Sort channels by their newest video's published_at DESC
  const sorted = [...buckets.values()].sort((a, b) =>
    (b[0].published_at ?? '').localeCompare(a[0].published_at ?? '')
  );

  // Round-robin pick
  const result = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const bucket of sorted) {
      if (bucket.length > 0) {
        result.push(bucket.shift());
        remaining = true;
      }
    }
  }
  return result;
}
```

Then change the final assembly in `getKidFeed` from:

```javascript
  const videos = [...unwatched, ...watchedVids];
```

to:

```javascript
  const videos = [...interleave(unwatched), ...interleave(watchedVids)];
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd server && node --test test/feed-api.test.js`
Expected: ALL PASS. Note: the existing "sorted by published_at DESC" test will need updating — the interleaved order won't be strictly `published_at DESC` anymore. If that test fails, update it to test that unwatched come before watched (the invariant we still guarantee) rather than strict date ordering.

- [ ] **Step 5: Fix any broken tests**

The existing test `getKidFeed returns videos sorted by published_at DESC` (which expects `['newest', 'middle', 'old']`) may still pass since all those videos are from the same channel, so interleaving won't change their order. Verify and adjust if needed.

- [ ] **Step 6: Commit**

```bash
git add server/lib/feed-api.js server/test/feed-api.test.js
git commit -m "feat: round-robin channel interleaving in kid feed

Videos are now interleaved across channels so no single channel
dominates the top of the feed. Within each channel, newest-first
ordering is preserved. Unwatched videos still appear before watched."
```

---

### Task 3: Skip UNRESOLVED channel IDs during channel suggestion

When suggesting channels to a new kid, skip any curated channels with `UNRESOLVED-*` channel IDs. Also add a startup log warning.

**Files:**
- Modify: `server/lib/family-api.js:246-264` (getCuratedChannels)
- Modify: `server/server.js:676-698` (seedCuratedChannels — add warning)
- Test: `server/test/curated-channels.test.js`

- [ ] **Step 1: Write failing test**

In `server/test/curated-channels.test.js`, add:

```javascript
test('getCuratedChannels skips UNRESOLVED channel IDs', () => {
  const { dir, db } = makeTempDb();
  try {
    insertChannel(db, {
      channel_id: 'UCxxxxREAL', title: 'Real Channel',
      interests: ['science'], age_min: 5, age_max: 12,
    });
    insertChannel(db, {
      channel_id: 'UNRESOLVED-fake', title: 'Fake Channel',
      interests: ['science'], age_min: 5, age_max: 12,
    });

    const results = getCuratedChannels(db, ['science'], 8);
    assert.equal(results.length, 1);
    assert.equal(results[0].channel_id, 'UCxxxxREAL');
  } finally {
    teardown(dir, db);
  }
});
```

Note: check the existing test file's helper `insertChannel` function to match its signature.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/curated-channels.test.js 2>&1 | tail -10`
Expected: FAIL — UNRESOLVED channel is returned.

- [ ] **Step 3: Implement — filter in getCuratedChannels**

In `server/lib/family-api.js`, change the `getCuratedChannels` SQL query:

```javascript
export function getCuratedChannels(db, interests, age) {
  const candidates = db.prepare(
    `SELECT * FROM curated_channels
     WHERE age_min <= ? AND age_max >= ?
       AND channel_id NOT LIKE 'UNRESOLVED%'`
  ).all(age, age);
```

- [ ] **Step 4: Add startup warning for UNRESOLVED channels**

In `server/server.js`, in the `seedCuratedChannels` function, after seeding add:

```javascript
  const unresolved = db.prepare(
    `SELECT title FROM curated_channels WHERE channel_id LIKE 'UNRESOLVED%'`
  ).all();
  if (unresolved.length > 0) {
    console.warn(`[seed] WARNING: ${unresolved.length} curated channels have UNRESOLVED IDs and will be skipped:`);
    for (const ch of unresolved) console.warn(`  - ${ch.title}`);
  }
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `cd server && node --test test/curated-channels.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/lib/family-api.js server/server.js server/test/curated-channels.test.js
git commit -m "fix: skip UNRESOLVED channel IDs in channel suggestions

Channels with placeholder UNRESOLVED-* IDs are excluded from
auto-suggestions. A startup warning lists any unresolved channels
so they can be fixed in seed-channels.json."
```

---

### Task 4: Resolve UNRESOLVED channel IDs in seed data

Resolve the 25 UNRESOLVED channel IDs in `seed-channels.json` to real YouTube channel IDs, or remove entries that can't be resolved.

**Files:**
- Modify: `server/migrations/seed-channels.json`

- [ ] **Step 1: Resolve channel IDs**

Use `yt-dlp` or web search to find the real YouTube channel IDs for each UNRESOLVED entry. For each channel, run:

```bash
yt-dlp --print channel_id "https://www.youtube.com/@ChannelHandle/videos" --flat-playlist --playlist-items 1
```

Known resolutions (verify these):
- Mystery Doug: `UCddVMQ29laWksMBJExqVPhw`
- The Coding Train: `UCvjgXvBlISQQNNNAXeY9Maw`
- Code.org: `UCJyEBMU1xVP2be1LPVnLGDQ`
- Crash Course: `UCX6b17PVsYBQ0ip5gyeme-Q`
- Crash Course Kids: `UCcfBLBQJoZ6Qr-4VFNqgv-A` (verify — may be inactive)
- MinuteEarth: `UCeiYXex_fwgYDonaTcSIk6w`
- National Geographic Kids: `UCXVCgDuD_QCkI7gTKU7-tpg`
- BBC Earth Kids: (verify — may not exist as separate channel)
- Animal Wonders: `UCGnilvO_WqMT4bOHOKOGOAA` (verify)
- Red Ted Art: `UCB3JFRIaLUKeodLLyq3mE8g` (verify)
- KIDZ BOP: `UCKE0Xnj818IDaHvIcRiq0Bg`
- Khan Academy: `UCnMekx_J2SGTST5aEk0Xb0Q` (verify)
- Homeschool Pop: `UC7FhJebKbMRhHcl7LMT04EA` (verify)
- The DadLab: `UCGCGpUIwAXq_VHl8QCTG3ew` (verify)
- PBS Kids: `UCkEvp3kDbCxDWG_xhGiJRRQ` (verify)
- Ms. Rachel: `UCMmp39paNnYfheDAhDhiGEg` (verify)
- Super Simple Songs: `UCLsooMJoIpl_7ux2jvdPB-Q` (verify)
- Liberty's Kids: (verify — may not have official channel)
- Extra Credits: `UCCODtTcd5M1JavPCOr_Uydg`
- Joe Wicks: `UCAxW1XT0iEJo0TYlRfn6rYQ`
- Kids Cook Real Food: `UCT1B3Tb7Bit_S7EWkhSba4A`
- Baking with Ryan: (verify — may not have official channel)
- Tingman: `UC4JCksJF76g_MdzPVBJoC3Q` (verify)
- J Perm: `UCqTVfFIsjQBgKls378xOwnA`
- TheOdd1sOut: `UCo8bcnLyZH8tBIH9V1mLgqQ`

- [ ] **Step 2: Update seed-channels.json**

Replace each `UNRESOLVED-*` channel_id with the resolved YouTube ID. Remove entries where no valid channel can be found.

- [ ] **Step 3: Verify by running tests**

Run: `cd server && node --test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add server/migrations/seed-channels.json
git commit -m "data: resolve UNRESOLVED channel IDs in seed data

Replaced 25 placeholder channel IDs with real YouTube channel IDs.
Removed entries where no official channel could be found."
```

---

### Task 5: Curated wow videos — age and interest filtering

Curated "wow" videos (hand-picked, `channel_id = ''`) are currently injected if they match age AND at least one interest. But they should also be filtered to exclude inappropriate content (religious content, product reviews, etc). The `getCuratedVideos` function already handles age+interest filtering. The issue is that the *seed data itself* needs vetting — and the injection code needs to respect it.

Since curated videos are already filtered by age and interest in `injectCuratedVideos`, the real fix here is:

1. Audit `seed-videos.json` for inappropriate entries
2. Add content-category tags to curated videos so future vetting is easier

**Files:**
- Modify: `server/migrations/seed-videos.json`
- Test: `server/test/curated-videos.test.js`

- [ ] **Step 1: Write test for interest filtering edge case**

Verify that curated videos with no interest overlap are excluded:

```javascript
test('injectCuratedVideos skips videos with no matching interests', () => {
  const { dir, db } = makeTempDb();
  try {
    const family = createFamily(db, 'no-match@example.com', 'secret');
    const kid = createKid(db, family.id, { name: 'NoMatchKid' });

    insertVideo(db, {
      video_id: 'v_sci', title: 'Science Vid',
      interests: ['science'], age_min: 5, age_max: 12,
    });
    insertVideo(db, {
      video_id: 'v_chess', title: 'Chess Vid',
      interests: ['chess'], age_min: 5, age_max: 12,
    });

    // Kid only likes dance — neither video should be injected
    const count = injectCuratedVideos(db, kid.id, ['dance'], 8);
    assert.equal(count, 0);

    const videos = db.prepare('SELECT * FROM videos WHERE kid_id = ?').all(kid.id);
    assert.equal(videos.length, 0);
  } finally {
    teardown(dir, db);
  }
});
```

- [ ] **Step 2: Run test — should already pass (verify existing behavior)**

Run: `cd server && node --test test/curated-videos.test.js`
Expected: PASS (this confirms the existing age+interest filter works)

- [ ] **Step 3: Audit seed-videos.json**

Review every entry in `server/migrations/seed-videos.json`. Remove or flag entries that:
- Have religious content (unless tagged with a `religion` interest)
- Are product reviews or unboxing
- Have low production quality or clickbait titles
- Are not genuinely "wow" — delightful, creative, enriching content

Current 31 entries should be reviewed. Known good ones: OK Go, Marcel the Shell, Planet Earth, Kurzgesagt, PES stop-motion. Check the rest.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/seed-videos.json server/test/curated-videos.test.js
git commit -m "fix: audit curated wow videos for age-appropriateness

Reviewed all seed videos. Removed entries that don't meet quality
bar (religious content, product reviews, clickbait). Added test
confirming interest-based filtering works correctly."
```

---

### Task 6: Run full test suite and deploy

- [ ] **Step 1: Run full test suite**

```bash
cd server && node --test test/*.test.js
```

Expected: ALL PASS

- [ ] **Step 2: Test with Playwright**

Navigate to yourtube.me, enter a kid's code, verify:
1. Feed shows diverse channels (not dominated by one)
2. No videos from pending channels appear
3. Curated wow videos appear in feed
4. YouTube iframe has sandbox attribute (no escape)
5. Click a video — stays on yourtube.me

- [ ] **Step 3: Deploy**

```bash
cd server && FLY_ACCESS_TOKEN=$(grep '^access_token:' ~/.fly/config.yml | sed 's/access_token: //') ~/.fly/bin/flyctl deploy --app yourtube-me
```

- [ ] **Step 4: Verify in production**

Repeat Playwright test against production URL.

- [ ] **Step 5: Final commit (if any adjustments)**

```bash
git add -A && git commit -m "fix: feed quality fixes — deploy verified"
```
