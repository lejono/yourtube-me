# YourTube — Revised V1 Plan

## Product Goal

Build a local-only YouTube wrapper for one child and one parent.

The goal for v1 is not to reproduce YouTube's private recommendation system. The goal is simpler and buildable:

- let the kid watch YouTube videos inline on the iPad
- let the parent import subscriptions and liked videos from the kid's account
- let the parent approve or block channels and videos
- replace end-of-video suggestions with a safer "Up Next" overlay built from approved content and filtered related candidates

Runs on the laptop and is served to the iPad over home Wi-Fi.

## Scope Decisions

These decisions are intentional. They keep the project small enough to finish.

- Single parent account, single kid profile
- Local network only
- Parent setup happens on the laptop browser
- OAuth is used for YouTube API access only
- v1 does not assume OAuth gives us YouTube browser cookies
- v1 does not promise the kid's exact personalized YouTube sidebar
- AI filtering is metadata-only in v1

## Success Criteria

v1 is successful if all of the following work reliably:

1. Parent logs into `/admin` on the laptop and connects a YouTube account.
2. Subscriptions and liked videos import successfully.
3. Parent can approve channels, block channels/videos, and edit content guidelines.
4. Kid can browse a feed on the iPad and play videos inline.
5. When a video ends, the app always shows safe next picks instead of exposing raw YouTube suggestions.
6. The system works even if scraping is disabled or broken.

## Non-Goals

Not part of v1:

- multiple kid profiles
- exact replication of YouTube's personalized recommendations
- thumbnail OCR, comment analysis, or transcript-level moderation
- time limits or parental control scheduling
- public internet hosting
- account switching
- search inside the app

## Product Behavior

### Parent Setup

The parent opens `/admin` on the laptop, logs in, and connects the kid's YouTube account.

The app imports:

- subscriptions
- liked videos

The app then builds a compact taste profile from:

- subscribed channels
- a sampled subset of liked videos

The parent reviews imported channels, marks them approved/unapproved, adds any manual channels, and writes content guidelines for the AI filter.

### Kid Watching Flow

The kid uses the iPad app for browsing and playback.

When a video starts, the server begins a background "up next" job:

1. Load cached vetted candidates for this video if they exist.
2. Load recent videos from approved channels as guaranteed-safe backfill.
3. Optionally fetch public related-video candidates for the current video.
4. Only if candidate quality is still poor and quota allows it, run one YouTube API search.
5. Fetch metadata for unseen candidates.
6. Filter new candidates through Claude using:
   - parent guidelines
   - approved/blocked lists
   - the taste profile
7. Store approved results keyed by the current video ID.

When playback ends, the app shows a full overlay over the embed and renders our vetted picks.

### What "Up Next" Means in v1

The "Up Next" list in v1 is assembled from these sources, in order:

1. previously approved candidates for the current video
2. fresh candidates from public related-video scraping, if available
3. one quota-guarded API search, if needed
4. recent videos from approved channels

This means the app is always able to show something safe, even if scraping fails.

## Key Product Correction

The original plan assumed Google OAuth could make Playwright behave like the kid's signed-in YouTube session. That is not a safe assumption, so v1 does not depend on it.

If we later want a true "use the real YouTube sidebar from a logged-in browser profile" experiment, that should be an explicit opt-in phase after v1 works.

## Architecture

```text
YourTube/
├── package.json
├── config.js
├── server.js
├── index.html
├── admin.html
├── lib/
│   ├── auth.js          # Password login + signed cookie session
│   ├── oauth.js         # Google OAuth flow + token refresh
│   ├── youtube.js       # YouTube Data API + RSS helpers
│   ├── store.js         # Atomic JSON persistence
│   ├── profile.js       # Taste profile generation
│   ├── filter.js        # Claude metadata filtering
│   ├── feed.js          # Kid feed generation
│   ├── upnext.js        # Candidate gathering + vetting
│   └── scraper.js       # Optional public related-video scraper
└── data/
    ├── config.json
    ├── channels.json
    ├── videos.json
    ├── history.json
    ├── blocked.json
    ├── ai-cache.json
    ├── upnext-cache.json
    ├── profile.json
    └── tokens.json
```

## Data Model

### `config.json`

- parent notes
- filtering guidelines
- search budget per day
- scraper enabled/disabled

### `channels.json`

Each channel record should include:

- `channelId`
- `title`
- `source` (`oauth` or `manual`)
- `approved`
- `lastFetchedAt`

### `videos.json`

Video metadata cache keyed by `videoId`:

- title
- channel ID / title
- description
- tags
- category
- thumbnails
- published date
- fetched timestamp

### `history.json`

Local watch events:

- `videoId`
- started at
- ended at
- watched duration if available

### `blocked.json`

- blocked channel IDs
- blocked video IDs

### `ai-cache.json`

Per-video AI decisions:

- approved / rejected
- reason
- decision timestamp
- model used

### `upnext-cache.json`

Per source video:

- approved candidate IDs
- generated timestamp
- candidate source list

## Constraints

1. `search.list` costs 100 quota units. It must not run by default for every watch.
2. OAuth testing mode is acceptable for local use, but the parent should expect re-consent if tokens expire.
3. Watch history is not available from the YouTube API, so history is local-only after first use.
4. `rel=0` does not fully suppress YouTube end suggestions. We must cover them with our own overlay.
5. `playsinline=1` is required for iPad Safari.
6. Public scraping can break if YouTube changes markup, so the product must work without it.
7. Parent setup must happen on the laptop browser because the callback is `http://localhost:3457/auth/callback`.

## Security Model

This is a local app, but it still needs a minimal security model.

- Parent login sets a signed, HttpOnly session cookie.
- All admin routes require the parent session.
- OAuth `state` is bound to the current parent session.
- `tokens.json` is gitignored and stored with restrictive file permissions.
- The app should run same-origin only. Do not add broad CORS.
- The kid-facing UI must not be able to call admin write endpoints successfully.

## Implementation Phases

### Phase 1. Foundation

Build the minimum shell:

- `package.json`
- `config.js`
- `server.js`
- `lib/store.js`
- `lib/auth.js`
- empty `index.html` / `admin.html`
- default JSON data files

Deliverables:

- server starts on `0.0.0.0:3457`
- parent can log in
- admin routes are protected
- JSON persistence works

### Phase 2. YouTube Import

Build the Google integration:

- `lib/oauth.js`
- `lib/youtube.js`

Rules:

- use redirect URI `http://localhost:3457/auth/callback`
- start and finish OAuth from the laptop browser only
- import subscriptions
- import liked videos
- refresh access tokens automatically

Deliverables:

- parent can connect YouTube from `/admin`
- channels are imported
- liked videos can be sampled for profile generation

### Phase 3. Taste Profile

Build a compact profile generator.

Do not send every liked video to Claude. Sample instead:

- all imported subscriptions
- up to the most recent 100 to 200 liked videos
- optional aggregate stats by channel/category

Expected output:

- interests
- preferred formats
- avoid patterns
- useful discovery terms

Deliverables:

- `profile.json` exists
- parent can rebuild the profile manually

### Phase 4. Feed from Approved Channels

Build a feed that works before "smart up next" exists.

Sources:

- approved channels via RSS
- approved channels via uploads playlist if needed

Deliverables:

- kid sees a grid feed on the iPad
- blocked content is excluded
- feed remains useful even with no scraping and no API search

### Phase 5. Playback and Safe Up Next

Build the actual watch flow.

Files:

- `index.html`
- `lib/upnext.js`
- optional `lib/scraper.js`

Behavior:

- on video start, queue vetting
- on video end, show our overlay immediately
- return partial results if background work is still running
- always include approved-channel backfill

Candidate strategy:

1. cached vetted results
2. public related-video scraping
3. API search only when candidate count is too low and daily budget remains
4. approved-channel backfill

Deliverables:

- kid never falls through to raw YouTube end suggestions
- `GET /api/upnext/:videoId` always returns something

### Phase 6. Parent Controls

Finish the admin surface:

- approved/unapproved channel toggles
- manual add channel
- block video
- block channel
- watch history view
- config editor
- sync status
- quota usage

Deliverables:

- parent can tune the system without editing files manually

## Route Plan

### Session and OAuth

- `POST /auth/login`
- `POST /auth/logout`
- `GET /api/admin/session`
- `GET /auth/youtube`
- `GET /auth/callback`

### Kid App

- `GET /`
- `GET /api/feed`
- `GET /api/video/:id`
- `POST /api/watch/start`
- `POST /api/watch/end`
- `GET /api/upnext/:videoId`

### Parent Admin

- `GET /admin`
- `GET /api/channels`
- `POST /api/channels`
- `PATCH /api/channels/:id`
- `DELETE /api/channels/:id`
- `GET /api/history`
- `POST /api/block`
- `DELETE /api/block/:id`
- `GET /api/profile`
- `POST /api/profile/rebuild`
- `GET /api/config`
- `POST /api/config`
- `POST /api/refresh`
- `GET /api/status`

## UI Notes

### Kid UI

Keep it simple:

- password gate if needed
- responsive feed grid
- inline YouTube player
- large end-of-video overlay with 3 to 8 safe picks
- optional countdown autoplay

Must-have details:

- `playsinline=1`
- large tap targets
- no visible admin controls

### Parent UI

Parent pages should optimize for review, not beauty.

Sections:

- YouTube connection status
- imported channels with approval toggles
- manual channel add
- taste profile summary
- content guidelines editor
- watch history
- blocked list
- status panel

## Quota Policy

This needs to be explicit.

- RSS and uploads playlist fetching are the default content sources.
- `search.list` is not part of the normal watch path unless the candidate pool is weak.
- Add a configurable hard cap, for example 10 to 20 searches per day.
- Cache search-derived candidates and AI decisions aggressively.

If quota becomes a problem, disable search before disabling the rest of the app.

## Testing Strategy

The plan should require tests, but only where they materially reduce risk.

### Unit Tests

Write unit tests for the brittle backend logic:

- `lib/store.js` atomic read/write and default-file behavior
- `lib/auth.js` password validation, session creation, and admin-route enforcement
- `lib/oauth.js` state generation/validation and token refresh handling
- `lib/youtube.js` quota guards and request-shaping helpers
- `lib/filter.js` cache lookup and cache invalidation rules
- `lib/upnext.js` source prioritization, fallback behavior, and blocked-item filtering

Each backend module should have:

- at least one happy-path test
- at least one failure-path test

### Integration Tests

Write API-level integration tests for the flows that can silently regress:

- parent login and session persistence
- OAuth callback success and failure handling
- channel import
- feed response generation
- `POST /api/watch/start`
- `GET /api/upnext/:videoId`
- block/unblock behavior

Integration tests should stub external dependencies:

- YouTube API
- Claude CLI
- scraping results

### End-to-End Smoke Tests

Keep end-to-end coverage narrow. One or two smoke tests are enough for v1:

- parent can log in, connect/import, and approve a channel
- kid can open a video, reach the end, and see the custom Up Next overlay

These tests matter because the embed-overlay handoff is one of the highest-risk product behaviors.

### Regression Rule

When fixing a bug in routing, filtering, caching, auth, or up-next generation, add a regression test when practical.

## Definition of Done

A phase is not done just because the UI appears to work once.

For each phase, "done" means:

1. The feature works manually.
2. Relevant unit or integration tests exist and pass.
3. External dependencies are stubbed in automated tests where practical.
4. Failure behavior is defined, not just the happy path.
5. The feature is reflected in the admin or status surface if the user needs visibility into it.

Minimum bar for project completion:

- all verification steps pass manually
- critical automated tests pass
- the app still functions with scraping disabled
- the app still functions when YouTube API search is unavailable

## Verification Plan

1. Start the server and confirm the laptop IP is shown.
2. Open `/admin` on the laptop and complete OAuth successfully.
3. Verify subscriptions import.
4. Verify the profile is generated from sampled data.
5. Approve a few channels and refresh content.
6. Open `/` on the iPad and confirm feed playback works inline.
7. Start a video and confirm background vetting begins.
8. End the video and confirm the custom overlay appears immediately.
9. Confirm the overlay still works with scraping disabled.
10. Block a video or channel in admin and verify it disappears from feed and up-next results.

## Kill Criteria

If any of these features prove fragile, cut them from v1 instead of stalling the project:

- public related-video scraping
- autoplay countdown
- profile-informed API search

The hard requirement is safe replacement suggestions, not a clever sourcing pipeline.

## Phase 2 Experiments

Only after v1 is working:

- manual browser-profile bootstrap for Playwright
- true logged-in recommendation scraping as an opt-in experiment
- richer AI moderation
- multiple kid profiles
- screen-time controls

## Why This Plan Is Better

This version makes four important corrections:

1. It removes the dependency on unproven personalized scraping.
2. It turns API search into a guarded fallback instead of a default cost center.
3. It makes the OAuth flow consistent with a local laptop-based setup.
4. It guarantees the app still works when the brittle parts fail.
