# YourTube Distributable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform YourTube from a personal LAN-only tool into a distributable web service at YourTube.me where any parent can sign up, curate channels for their kids, and give each child a zero-login bookmark on their iPad.

**Architecture:** Three components: (1) a fly.io Node.js server that stores family configs and serves pre-filtered video feeds via a kid-facing SPA; (2) a local worker daemon on Jono's machine that polls RSS, runs Claude Haiku per-video filtering, and pushes results to the server; (3) a parent onboarding flow with Opus-powered channel generation from interests. The kid is identified by a long-lived cookie set via a one-time setup link -- daily use is just `yourtube.me/` with no login. The parent manages everything through a web UI at `yourtube.me/admin`.

**Tech Stack:** Node.js 20+ (vanilla, no frameworks), node:test, SQLite (via better-sqlite3), fly.io, Claude CLI (Haiku for filtering, Opus for channel generation).

**Domain:** YourTube.me

---

## Subsystem Overview

| # | Subsystem | What it does | Where it runs |
|---|---|---|---|
| 1 | **Server** | Serves kid SPA, stores family data, exposes REST API | fly.io |
| 2 | **Worker** | Polls RSS, runs AI filter, pushes filtered feeds | Jono's machine |
| 3 | **Onboarding** | Parent signup, Opus channel generation, kid URL setup | Server + Worker |

**Dependency order:** Server first (Tasks 1-8), then Worker (Tasks 9-12), then Onboarding (Tasks 13-16). Within each subsystem, tasks are sequential.

---

## File Structure

### New files (server -- deployed to fly.io)

```
server/
  package.json
  server.js                     # HTTP server (routes, static files)
  lib/
    db.js                       # SQLite schema + query helpers
    auth.js                     # Parent auth (email/password, sessions)
    kid-token.js                # Kid setup tokens, cookie helpers, CRUD
    feed-api.js                 # Feed serving (read pre-filtered JSON)
    family-api.js               # Family CRUD (channels, profiles, guidelines)
    worker-api.js               # Worker push endpoint (authenticated)
  public/
    index.html                  # Kid SPA (feed + player, identified by yt_kid cookie)
    js/
      app.js                    # Kid SPA logic (cookie-based, no login)
      player.js                 # Video player (YouTube iframe)
    css/
      style.css                 # Kid UI styles (iPad-optimised)
    admin/
      index.html                # Admin/parent dashboard
      js/
        admin.js                # Admin UI logic
      css/
        admin.css               # Admin UI styles
  migrations/
    001-init.sql                # Initial schema
  fly.toml                      # Fly.io config
  Dockerfile                    # Container build
```

### New files (worker -- runs on Jono's machine)

```
worker/
  package.json
  worker.js                     # Main daemon: poll, filter, push
  config.js                     # Worker config
  lib/
    rss.js                      # YouTube RSS fetching
    filter.js                   # Claude Haiku filter
    server-client.js            # HTTP client for server API
    channel-gen.js              # Opus channel generation from interests
```

### Files reused from current codebase

The worker adapts core logic from the current `lib/` directory:
- `lib/youtube.js` -> `worker/lib/rss.js` (RSS fetching + parsing only)
- `lib/filter.js` -> `worker/lib/filter.js` (Claude CLI integration)

These will be extracted/adapted, not symlinked.

### Files NOT migrated (server-side features dropped for v1)

- `lib/oauth.js`, `lib/import.js` -- YouTube OAuth import (channels come from Opus)
- `lib/scraper.js` -- web scraper for related videos
- `lib/upnext.js` -- Up Next engine
- `lib/profile.js` -- profile generation (replaced by parent-authored guidelines)
- `public/admin.html`, `public/js/admin.js` -- replaced by new admin dashboard

---

## Database Schema (SQLite)

```sql
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- scrypt hash (hex)
  password_salt TEXT NOT NULL,          -- per-user random salt (hex)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE kids (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setup_token TEXT UNIQUE NOT NULL,    -- one-time setup link token (96 bits, 16 chars base64url)
  cookie_generation INTEGER NOT NULL DEFAULT 1,  -- increment to revoke all active cookies
  age INTEGER,
  guidelines TEXT,
  interests TEXT,                      -- JSON array
  channels_generated INTEGER NOT NULL DEFAULT 0, -- set to 1 after Opus channel gen completes
  last_pushed_at TEXT,                 -- ISO 8601, updated on each worker push
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  approved INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kid_id, channel_id)
);

CREATE TABLE videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_title TEXT NOT NULL,
  published_at TEXT,
  thumbnail TEXT,
  ai_approved INTEGER NOT NULL DEFAULT 1,
  ai_reason TEXT,
  filtered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kid_id, video_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
```

---

## Task 1: Server project scaffold + SQLite schema

**Files:**
- Create: `server/package.json`
- Create: `server/migrations/001-init.sql`
- Create: `server/lib/db.js`
- Create: `server/server.js` (minimal)
- Test: `server/test/db.test.js`

- [ ] **Step 1: Create `server/package.json` and install dependencies**

```json
{
  "name": "yourtube-server",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "node --test --test-concurrency=1 test/*.test.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  }
}
```

Run: `cd server && npm install`

This is pure build scaffolding, not application code — no test needed.

- [ ] **Step 2: Write failing test `server/test/db.test.js`**

Tests:
- `generateId` returns unique strings of expected length
- `generateSetupToken` returns 16-char URL-safe strings (96 bits)
- `runMigrations` creates all 5 tables (families, kids, channels, videos, sessions)
- `runMigrations` is idempotent
- Foreign keys are enforced (inserting kid with nonexistent family_id throws)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --test test/db.test.js`
Expected: FAIL (module not found)

- [ ] **Step 4: Create `server/migrations/001-init.sql`**

Use the schema from the Database Schema section above (all 5 CREATE TABLE statements).

- [ ] **Step 5: Create `server/lib/db.js`** (minimal implementation to pass tests)

Exports: `generateId(bytes=12)`, `generateSetupToken()` (12 bytes = 16 chars base64url = 96 bits), `getDb(dbPath?)`, `runMigrations(db)`, `closeDb()`.

- Uses `better-sqlite3` with `WAL` journal mode and `foreign_keys = ON`.
- Migrations tracked in `_migrations` table, reads `.sql` files from `../migrations/` directory.
- `generateId` and `generateSetupToken` use `crypto.randomBytes` with base64url encoding. Both produce 96-bit tokens.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && node --test test/db.test.js`
Expected: All pass

- [ ] **Step 7: Create minimal `server/server.js`** that opens DB, runs migrations, listens on PORT, returns "YourTube server OK"

- [ ] **Step 8: Verify server starts**

Run: `cd server && timeout 3 node server.js || true`

- [ ] **Step 9: Commit**

```bash
git add server/ && git commit -m "feat(server): scaffold project with SQLite schema and migrations"
```

---

## Task 2: Parent auth (signup, login, sessions)

**Files:**
- Create: `server/lib/auth.js`
- Test: `server/test/auth.test.js`

- [ ] **Step 1: Write test `server/test/auth.test.js`**

Tests:
- `hashPassword` + `verifyPassword`: correct password verifies, wrong password rejects, different passwords produce different hashes, same password with different salts produces different hashes
- `createFamily(db, email, password)`: creates row with id + email + password_salt, rejects duplicate email
- `createSession(db, familyId)` + `validateSession(db, sessionId)`: creates and validates, returns null for invalid, respects expiry
- `destroySession(db, sessionId)`: session no longer validates

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/auth.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `server/lib/auth.js`**

Exports: `hashPassword(pw, salt?)`, `verifyPassword(pw, hash, salt)`, `createFamily(db, email, pw)`, `authenticateFamily(db, email, pw)`, `createSession(db, familyId)`, `validateSession(db, sessionId)`, `destroySession(db, sessionId)`, `getSessionFromCookie(req)`, `setSessionCookie(res, sessionId)`, `clearSessionCookie(res)`.

- Password hashing: `crypto.scryptSync(password, salt, 64)` with per-user random salt (32 bytes hex). Both hash and salt stored in families table.
- Constant-time comparison via `timingSafeEqual`
- Session TTL: 30 days
- Cookie name: `yt_session`, HttpOnly, SameSite=Lax, Secure (conditional: omit Secure if `NODE_ENV !== 'production'`)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/auth.test.js`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add server/lib/auth.js server/test/auth.test.js && git commit -m "feat(server): parent auth with signup, login, sessions"
```

---

## Task 3: Kid management + setup tokens

**Files:**
- Create: `server/lib/kid-token.js`
- Test: `server/test/kid-token.test.js`

**Design:** Kids are identified by a signed long-lived cookie (`yt_kid`), not a URL slug.
- Parent creates a kid -> server generates a `setup_token` (unguessable, 96 bits / 16 chars base64url)
- Parent shares a one-time setup link: `yourtube.me/setup/<token>`
- Kid opens the link on their iPad -> server sets signed `yt_kid` cookie (HttpOnly, Secure, SameSite=Lax, 1 year) and redirects to `/`
- Cookie value: `kid_id:cookie_generation:hmac(kid_id:cookie_generation, SESSION_SECRET)` -- signed to prevent forgery
- From then on, `yourtube.me/` reads + verifies the cookie to identify the kid. No slug in the URL.
- **Revocation:** Parent increments `cookie_generation` on the kid record. All existing cookies with the old generation become invalid. Parent then shares the new setup link to re-enroll the device.
- Multiple kids on one iPad: each opens their own setup link, overwriting the cookie. Or parent opens `/setup/<token>` on behalf of each kid's device.

- [ ] **Step 1: Write test `server/test/kid-token.test.js`**

Tests:
- `createKid(db, familyId, { name, age })`: creates kid with 16-char setup_token (96 bits)
- `getKidBySetupToken(db, token)`: retrieves kid, returns null for unknown
- `getKidById(db, kidId)`: retrieves kid by id
- `listKids(db, familyId)`: lists all kids for family
- `updateKid(db, kidId, { name, age, guidelines })`: updates fields
- `deleteKid(db, kidId)`: removes kid (cascade tested)
- `regenerateSetupToken(db, kidId)`: returns new token, old token no longer resolves
- `revokeKidCookies(db, kidId)`: increments cookie_generation, invalidating all active cookies
- `validateKidCookie(db, cookieValue)`: parses `kid_id:generation:hmac`, verifies HMAC + generation match

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement `server/lib/kid-token.js`**

Exports: `createKid(db, familyId, opts)`, `getKidBySetupToken(db, token)`, `getKidById(db, kidId)`, `listKids(db, familyId)`, `updateKid(db, kidId, opts)`, `deleteKid(db, kidId)`, `regenerateSetupToken(db, kidId)`, `revokeKidCookies(db, kidId)`, `validateKidCookie(db, cookieValue)`.

Helper: `getKidFromCookie(req)` -- reads `yt_kid` cookie, calls `validateKidCookie` (verifies HMAC + checks cookie_generation matches DB), returns kid_id or null.
Helper: `setKidCookie(res, kidId, generation)` -- sets signed `yt_kid` cookie: `kid_id:generation:hmac(kid_id:generation)`, HttpOnly, SameSite=Lax, Secure (conditional), Max-Age=1 year.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add server/lib/kid-token.js server/test/kid-token.test.js && git commit -m "feat(server): kid management with setup tokens and cookie-based identification"
```

---

## Task 4: Channel and video storage

**Files:**
- Create: `server/lib/family-api.js`
- Test: `server/test/family-api.test.js`

- [ ] **Step 1: Write test `server/test/family-api.test.js`**

Tests:
- `addChannel(db, kidId, { channel_id, title })`: adds channel, rejects duplicate for same kid
- `listChannels(db, kidId)`: lists channels
- `removeChannel(db, kidId, channelId)`: removes channel and its videos
- `upsertVideos(db, kidId, videos)`: inserts new, updates existing (ON CONFLICT)
- `getApprovedVideos(db, kidId)`: returns only ai_approved=1, sorted by published_at DESC

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement `server/lib/family-api.js`**

Exports: `addChannel`, `listChannels`, `removeChannel`, `upsertVideos`, `getApprovedVideos`, `getAllChannelsWithKidInfo`.

- `upsertVideos` uses `INSERT ... ON CONFLICT DO UPDATE` in a transaction, also updates `last_pushed_at` on the kid record
- `getAllChannelsWithKidInfo` joins channels+kids+families for worker manifest

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add server/lib/family-api.js server/test/family-api.test.js && git commit -m "feat(server): channel and video storage with upsert"
```

---

## Task 5: Worker API endpoint

**Files:**
- Create: `server/lib/worker-api.js`
- Test: `server/test/worker-api.test.js`

- [ ] **Step 1: Write test `server/test/worker-api.test.js`**

Tests:
- `authenticateWorker(masterKey, providedKey)`: true for matching key, false for invalid
- `getWorkerManifest(db)`: returns all kids with channels grouped, interests parsed from JSON, includes channels_generated flag

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement `server/lib/worker-api.js`**

Exports: `authenticateWorker(masterKey, providedKey)`, `getWorkerManifest(db)`.

- `authenticateWorker`: constant-time comparison of provided key against `YOURTUBE_WORKER_MASTER_KEY` env var. The worker is a trusted system component operated by the service owner, not per-family.
- `getWorkerManifest`: returns `[{ kid_id, name, age, guidelines, interests: [], channels_generated, channels: [{ channel_id, title }] }]`

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add server/lib/worker-api.js server/test/worker-api.test.js && git commit -m "feat(server): worker API with auth and manifest"
```

---

## Task 6: Kid feed API

**Files:**
- Create: `server/lib/feed-api.js`
- Test: `server/test/feed-api.test.js`

- [ ] **Step 1: Write test `server/test/feed-api.test.js`**

Tests:
- Returns only approved videos (inserts 20 approved + 5 rejected, verifies count)
- Includes channel list for kid
- Includes kid_name in response
- Filters by channel_id when param provided
- Respects limit param

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement `server/lib/feed-api.js`**

Export: `getKidFeed(db, kidId, { channel?, limit? })` returning `{ videos, channels, kid_name }`.

Note: the HTTP layer reads `yt_kid` cookie to get `kidId` -- this function just takes the kidId directly.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add server/lib/feed-api.js server/test/feed-api.test.js && git commit -m "feat(server): kid feed API serving pre-filtered videos"
```

---

## Task 7: HTTP router (assemble all routes)

**Files:**
- Modify: `server/server.js` (full router)
- Test: `server/test/server.test.js` (HTTP integration)

- [ ] **Step 1: Write integration test `server/test/server.test.js`**

Tests via HTTP:
- `GET /` returns 200
- `GET /admin` returns 200
- Parent signup flow: POST /api/auth/signup -> 201 with family_id
- Parent login: POST /api/auth/login -> 200 with session cookie
- Create kid: POST /api/kids -> 201 with setup_token
- Setup link: GET /setup/:token -> 302 redirect to `/`, sets yt_kid cookie
- Feed API: GET /api/feed with yt_kid cookie -> 200 with videos
- Feed API: GET /api/feed without cookie -> 404
- Worker push: POST /api/worker/push rejects bad key with 401

Server exports `startServer()` and `stopServer()` for testability. Uses `PORT=0` for random port.

- [ ] **Step 2: Implement full `server/server.js`**

Routes:
- `GET /` -> serves index.html (kid SPA; reads yt_kid cookie to identify kid)
- `GET /setup/:token` -> sets yt_kid cookie, redirects to `/` (one-time setup link)
- `GET /api/feed` -> kid feed JSON (identified by yt_kid cookie, no login)
- `GET /admin` -> serves admin/index.html
- `POST /api/auth/signup` -> create family + session
- `POST /api/auth/login` -> authenticate + session
- `POST /api/auth/logout` -> destroy session
- `GET /api/auth/session` -> check auth status
- `GET /api/kids` -> list kids (admin auth)
- `POST /api/kids` -> create kid (admin auth)
- `PATCH /api/kids/:id` -> update kid (admin auth)
- `DELETE /api/kids/:id` -> delete kid (admin auth)
- `GET /api/kids/:id/channels` -> list channels (admin auth)
- `POST /api/kids/:id/channels` -> add channel (admin auth)
- `DELETE /api/kids/:id/channels/:channelId` -> remove channel (admin auth)
- `GET /api/worker/manifest` -> worker manifest (worker key auth)
- `POST /api/worker/push` -> push filtered videos (worker key auth)
- `POST /api/worker/channels` -> push generated channels (worker key auth)
- `GET /api/health` -> 200 `{ ok: true }` (fly.io health check, no auth)
- Static file serving with path traversal protection (normalize paths, reject `..` after normalization)

`GET /setup/:token` flow: look up kid by setup_token -> if found, set `yt_kid=<kid.id>` cookie (HttpOnly, SameSite=Lax, Max-Age=1 year) -> redirect to `/`.

`GET /api/feed` flow: read `yt_kid` cookie -> look up kid by id -> return approved videos + channels.

`GET /` when no yt_kid cookie is set: the SPA shows a friendly message ("Ask your parent for your YourTube setup link").

Worker auth uses `YOURTUBE_WORKER_MASTER_KEY` env var only. The worker is a trusted system component (run by the service operator), not scoped per-family. Constant-time comparison via `timingSafeEqual`.

- [ ] **Step 3: Run tests**

Run: `cd server && node --test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/server.js server/test/server.test.js && git commit -m "feat(server): full HTTP router with all endpoints"
```

---

## Task 8: Kid SPA (feed + player, no login)

**Files:**
- Create: `server/public/index.html`
- Create: `server/public/js/app.js`
- Create: `server/public/js/player.js`
- Create: `server/public/css/style.css`

**No unit tests** -- frontend HTML/CSS/JS. Behaviour covered by Task 7 integration test (GET /, setup flow) and Task 16 E2E test.

- [ ] **Step 1: Create `server/public/index.html`**

Two screens: feed (default) and player. No login screen.
- Feed: header with "YourTube" + kid name, channel tabs, video grid
- Player: back button, YouTube iframe, title/channel info
- iPad-optimised viewport meta tags + apple-mobile-web-app-capable

- [ ] **Step 2: Create `server/public/js/app.js`**

- No slug extraction -- the cookie identifies the kid
- `loadFeed(channel?)`: fetches `GET /api/feed` (cookie sent automatically), renders grid
- If API returns 404 (no cookie or invalid kid), shows "Ask your parent for your YourTube setup link"
- `renderTabs()`: channel filter buttons
- `renderGrid()`: video cards with thumbnail, title, channel
- `createCard(video)`: click opens player
- `escapeHtml()` for XSS prevention
- Back button returns to feed

- [ ] **Step 3: Create `server/public/js/player.js`**

Exports: `openPlayer(video)`, `closePlayer()`.
- Embeds YouTube iframe with `?autoplay=1&controls=1&rel=0`
- Shows title and channel name below player

- [ ] **Step 4: Create `server/public/css/style.css`**

iPad-optimised dark theme:
- Video grid: responsive `auto-fill, minmax(280px, 1fr)`
- Channel tabs: horizontal scroll, pill buttons
- Player: full-width iframe with 16:9 aspect ratio
- Mobile: single-column grid below 600px

- [ ] **Step 5: Verify SPA loads**

Start server, open `/` in browser (no cookie set), verify "ask your parent for setup link" message renders.

- [ ] **Step 6: Commit**

```bash
git add server/public/ && git commit -m "feat(server): kid SPA with feed grid and YouTube player"
```

---

## Task 9: Worker scaffold + RSS fetching

**Files:**
- Create: `worker/package.json`
- Create: `worker/config.js`
- Create: `worker/lib/rss.js`
- Create: `worker/lib/server-client.js`
- Test: `worker/test/rss.test.js`

- [ ] **Step 1: Create `worker/package.json` and `worker/config.js`**

package.json: no dependencies, uses built-in fetch.
config.js exports: `SERVER_URL`, `WORKER_KEY`, `POLL_INTERVAL_MS` (default 30 min), `AI_FILTER_ENABLED`.

Pure scaffolding, no test needed.

- [ ] **Step 2: Write failing test `worker/test/rss.test.js`**

Tests `parseRSSEntries` with sample XML: correct entry count, title decoding, HTML entity decoding, fallback thumbnails.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && node --test test/rss.test.js`
Expected: FAIL (module not found)

- [ ] **Step 4: Create `worker/lib/rss.js`** (minimal implementation to pass tests)

Adapted from existing `lib/youtube.js`. Exports: `fetchRSS(channelId)`, `parseRSSEntries(xml)`, `resolveChannelBySearch(query)`.

- `fetchRSS`: fetches YouTube RSS feed, returns `[{ videoId, title, channelTitle, publishedAt, thumbnail }]`
- `parseRSSEntries`: regex-based XML parsing (no dependencies)
- `resolveChannelBySearch`: scrapes YouTube search page for first channel ID
- `_setFetchForTesting(fn)`: test injection

- [ ] **Step 5: Run test to verify it passes**

Run: `cd worker && node --test test/rss.test.js`
Expected: All pass

- [ ] **Step 6: Create `worker/lib/server-client.js`**

Exports: `fetchManifest()`, `pushVideos(kidId, videos)`, `pushChannels(kidId, channels)`.

- All use `X-Worker-Key` header for auth
- `fetchManifest`: GET /api/worker/manifest
- `pushVideos`: POST /api/worker/push
- `pushChannels`: POST /api/worker/channels (one per channel)

(No unit test -- this is a thin HTTP client; tested via E2E in Task 16.)

- [ ] **Step 7: Commit**

```bash
git add worker/ && git commit -m "feat(worker): scaffold with RSS fetching and server client"
```

---

## Task 10: Worker AI filter (Claude Haiku)

**Files:**
- Create: `worker/lib/filter.js`
- Test: `worker/test/filter.test.js`

- [ ] **Step 1: Write test `worker/test/filter.test.js`**

Tests:
- `buildPrompt`: includes child age and guidelines in output
- `parseResponse`: parses valid JSON, strips markdown fences, returns null for garbage
- `classifyVideos` with mock executor: returns classifications, gracefully degrades on failure

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement `worker/lib/filter.js`**

Adapted from existing `lib/filter.js` but standalone (no store/cache dependency).

Exports: `classifyVideos(videos, context)`, `buildPrompt(videos, context)`, `parseResponse(raw)`, `_setExecForTesting(fn)`.

- Uses `node:child_process` `execFile` to call `claude -p --model haiku --output-format json`
- Deletes `CLAUDECODE` env var before spawning
- Batches by 10, 60s timeout
- Graceful degradation: returns `approved: true, reason: 'unclassified'` on failure

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add worker/lib/filter.js worker/test/filter.test.js && git commit -m "feat(worker): Claude Haiku content filter"
```

---

## Task 11: Worker main loop (poll, filter, push)

**Files:**
- Create: `worker/worker.js`
- Test: `worker/test/worker.test.js`

- [ ] **Step 1: Write test `worker/test/worker.test.js`**

Tests `processKid(kid)` with mocked deps:
- Fetches RSS, classifies, returns push-ready video array
- Videos have correct shape: `{ video_id, title, channel_id, channel_title, published_at, thumbnail, ai_approved, ai_reason }`

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement `worker/worker.js`**

Exports: `processKid(kid)`, `_setDeps(overrides)`.

- `processKid`: fetches RSS for all kid's channels in parallel, runs AI filter, merges into push-ready format
- `runCycle`: fetches manifest from server, processes each kid, pushes results
- Channel generation: if kid has interests but no channels, calls Opus to generate, resolves to YouTube channel IDs, pushes to server
- Main loop: runs `runCycle` immediately then on interval

Only auto-starts if run directly (not imported by tests).

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add worker/worker.js worker/test/worker.test.js && git commit -m "feat(worker): main loop with RSS polling, AI filter, and server push"
```

---

## Task 12: Fly.io deployment config

**Files:**
- Create: `server/fly.toml`
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`

**No unit tests** -- infrastructure config. Verified by Docker build + deploy.

- [ ] **Step 1: Create `server/Dockerfile`**

- FROM node:20-slim
- COPY package.json + npm ci --only=production
- COPY app files
- mkdir /data for SQLite
- ENV YOURTUBE_DB_PATH=/data/yourtube.sqlite
- EXPOSE 3457, CMD node server.js

- [ ] **Step 2: Create `server/.dockerignore`**

Exclude: node_modules, test, *.test.js, .env, data

- [ ] **Step 3: Create `server/fly.toml`**

- app = "yourtube", primary_region = "lhr"
- internal_port = 3457, force_https, auto_stop/start machines
- Mount: source = "yourtube_data", destination = "/data"
- Health check: `GET /api/health` (path, interval 30s, timeout 5s)

- [ ] **Step 4: Verify Docker build**

Run: `cd server && docker build -t yourtube-server .`

- [ ] **Step 5: Commit**

```bash
git add server/Dockerfile server/.dockerignore server/fly.toml && git commit -m "feat(server): fly.io deployment config"
```

---

## Task 13: Admin dashboard (signup + kid management)

**Files:**
- Create: `server/public/admin/index.html`
- Create: `server/public/admin/js/admin.js`
- Create: `server/public/admin/css/admin.css`

**No unit tests** -- frontend UI. Admin API behaviour covered by Task 7 integration test. Full flow covered by Task 16 E2E test.

- [ ] **Step 1: Create `server/public/admin/index.html`**

Two screens:
- Auth: signup form (email + password) with toggle to login form
- Dashboard: kid list (cards with name, age, setup link), "Add a Child" button, add-kid form (name, age, interests textarea, guidelines textarea), kid detail view (setup link + copy button, channel list with remove)

- [ ] **Step 2: Create `server/public/admin/js/admin.js`**

- Auth: signup/login forms call /api/auth/signup and /api/auth/login
- Dashboard: loadKids() fetches /api/kids, renders kid cards
- Add kid: collects name, age, interests (comma-separated -> JSON array), guidelines
- Kid detail: shows setup link (`origin/setup/:setup_token`), copy-to-clipboard button, "open this on your child's iPad" instruction, channel list with remove buttons
- Auto-checks session on load: GET /api/auth/session

- [ ] **Step 3: Create `server/public/admin/css/admin.css`**

Light theme, max-width 800px centered layout, card-based kid list, clean form styling.

- [ ] **Step 4: Verify pages load**

Start server, open `/admin` in browser, verify signup form renders.

- [ ] **Step 5: Commit**

```bash
git add server/public/admin/ && git commit -m "feat(server): admin dashboard with signup, kid management, and setup links"
```

---

## Task 14: Opus channel generation

**Files:**
- Create: `worker/lib/channel-gen.js`
- Test: `worker/test/channel-gen.test.js`

- [ ] **Step 1: Write test `worker/test/channel-gen.test.js`**

Tests:
- `parseChannelResponse`: parses JSON with channels array, returns empty for garbage
- `generateChannels` with mock executor: returns channel suggestions with name, reason, searchQuery

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement `worker/lib/channel-gen.js`**

Exports: `generateChannels(kidProfile)`, `parseChannelResponse(raw)`, `_setExecForTesting(fn)`.

- Calls `claude -p --model opus --output-format json` via `execFile`
- Prompt asks for 10-15 real YouTube channels based on kid's age + interests + guidelines
- Response: `{ channels: [{ name, reason, searchQuery }] }`
- 120s timeout (Opus is slower)

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add worker/lib/channel-gen.js worker/test/channel-gen.test.js && git commit -m "feat(worker): Opus-powered channel generation from kid interests"
```

---

## Task 15: Wire channel generation into worker loop

**Files:**
- Modify: `worker/worker.js` (add channel gen step before RSS polling)
- Modify: `worker/lib/server-client.js` (add pushChannels)

- [ ] **Step 1: Add `pushChannels(kidId, channels)` to server-client.js**

POSTs each channel to /api/worker/channels with worker key.

- [ ] **Step 2: Add channel generation to worker.js runCycle()**

Before processing each kid's RSS:
- If kid has interests, `channels_generated == 0`, and 0 channels -> call `generateChannels(kid)`
- For each suggestion, call `resolveChannelBySearch(suggestion.searchQuery)` to get YouTube channel ID
- Push resolved channels to server via `pushChannels`
- Set `channels_generated = 1` on the server (new endpoint or flag in push response)
- Update kid.channels in-memory for subsequent RSS polling

- [ ] **Step 3: Add /api/worker/channels endpoint to server.js**

POST /api/worker/channels: accepts `{ kid_id, channel_id, title }`, calls `addChannel`, handles UNIQUE conflict gracefully.

- [ ] **Step 4: Run all tests**

Run: `cd worker && node --test && cd ../server && node --test`

- [ ] **Step 5: Commit**

```bash
git add worker/ server/server.js && git commit -m "feat: wire Opus channel generation into worker loop"
```

---

## Task 16: End-to-end integration test

**Files:**
- Create: `test/e2e.test.js`

- [ ] **Step 1: Write integration test**

Full flow via HTTP:
1. Start server on random port
2. Parent signs up (POST /api/auth/signup -> 201)
3. Parent adds kid with interests (POST /api/kids -> 201 with setup_token)
4. Kid opens setup link (GET /setup/:token -> 302, yt_kid cookie set)
5. Worker pushes videos via master key (POST /api/worker/push -> 200)
6. Kid feed returns only approved videos (GET /api/feed with yt_kid cookie -> 200)
7. Kid SPA loads at / (GET -> 200, HTML contains "YourTube")
8. Feed without cookie returns 404

- [ ] **Step 2: Run test**

Run: `node --test test/e2e.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add test/e2e.test.js && git commit -m "test: end-to-end integration test"
```

---

## Deployment Checklist

After all tasks pass:

- [ ] Deploy server to fly.io:
  ```
  cd server
  fly launch --name yourtube --region lhr
  fly volumes create yourtube_data --region lhr --size 1
  fly secrets set YOURTUBE_SESSION_SECRET=$(openssl rand -hex 32)
  fly secrets set YOURTUBE_WORKER_MASTER_KEY=$(openssl rand -hex 32)
  fly deploy
  ```

- [ ] Point YourTube.me DNS:
  - CNAME: `yourtube.me` -> `yourtube.fly.dev`
  - `fly certs add yourtube.me`

- [ ] Set up worker:
  ```
  cd worker
  export YOURTUBE_SERVER_URL=https://yourtube.me
  export YOURTUBE_WORKER_KEY=<master key>
  export YOURTUBE_AI_FILTER_ENABLED=true
  node worker.js
  ```

- [ ] Configure Litestream for SQLite replication:
  - Add `litestream.yml` to the Docker image
  - Replicate to Tigris (fly.io's S3-compatible store, free tier)
  - Verify restore works: `litestream restore -o /tmp/restored.sqlite`

- [ ] Test full flow: signup at /admin, add kid, open setup link on iPad, wait for channels + videos, verify yourtube.me/ shows feed

---

## What's NOT in this plan (future work)

- Like/dislike buttons on kid feed
- Watch history tracking
- Up Next recommendations
- YouTube search in kid UI (kids browse curated feed only)
- Screen time / bedtime controls
- Multiple worker instances
- Worker health monitoring
- Add-to-homescreen PWA manifest
- Weighted shuffle (v1 uses simple recency sort; can add later)
- Migration of existing LAN data (the original family's channels, history, likes). The LAN version at paploo:3457 continues to run independently.
- COPPA / child privacy compliance. V1 is friends-and-family only. If offered publicly, verifiable parental consent, data retention policies, and minimum-necessary data collection would need to be addressed.
- Rate limiting on auth endpoints (signup, login). Needed before public launch.
