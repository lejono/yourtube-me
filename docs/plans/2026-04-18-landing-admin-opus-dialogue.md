# Landing Page, Admin UX, and Opus Dialogue Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the bare-bones UI into a polished, self-explanatory experience: a compelling landing page, a conversational admin with Opus-powered channel curation, and restore missing admin features from the original YourTube.

**Architecture:** The Opus dialogue runs via the worker (Claude CLI on Jono's machine, using Max subscription). The worker runs a fast loop (30s) for channel generation so suggestions appear quickly. Suggestions are stored as `pending` channels; the parent reviews and approves them in the admin UI. The server gains polling endpoints so the admin UI can show a spinner while waiting for Opus.

**Tech Stack:** Same as existing -- vanilla Node.js, vanilla JS frontend, SQLite, node:test.

---

## Overview

| # | Task | What it does |
|---|---|---|
| 1 | Landing page | Compelling public page at `/` when no kid cookie set |
| 2 | Channel status field | Add `status` column to channels (pending/approved/rejected) |
| 3 | Worker fast loop | 30s poll for kids needing channel generation |
| 4 | Opus suggestions with descriptions | Worker pushes channels as `pending` with reason/examples |
| 5 | Admin: suggestion review UI | Parent sees pending channels, approves/rejects, adds own |
| 6 | Admin: feedback loop | Parent gives text feedback, Opus refines suggestions |
| 7 | Admin: restore dashboard features | Status, guidelines editor, recent videos, channel management |
| 8 | Admin: onboarding copy | Explain what everything does, guide the parent through setup |

---

## Database Changes

### Modify `channels` table

```sql
-- Add status and metadata columns (migration 002)
ALTER TABLE channels ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
  -- 'pending' = Opus suggested, awaiting parent review
  -- 'approved' = parent approved or manually added
  -- 'rejected' = parent rejected
ALTER TABLE channels ADD COLUMN reason TEXT;
  -- Why Opus suggested this channel (shown to parent)
ALTER TABLE channels ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
  -- 'opus' = AI suggested, 'parent' = manually added
```

### Add `feedback` table

```sql
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  message TEXT NOT NULL,           -- parent's feedback text
  processed INTEGER NOT NULL DEFAULT 0, -- 1 = worker has processed this
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Modify `kids` table

```sql
ALTER TABLE kids ADD COLUMN channels_status TEXT NOT NULL DEFAULT 'idle';
  -- 'idle' = nothing happening
  -- 'generating' = worker is running Opus
  -- 'ready' = suggestions available for review
  -- 'refining' = worker is processing feedback
```

---

## Task 1: Landing page

**Files:**
- Create: `server/public/landing.html`
- Create: `server/public/css/landing.css`
- Modify: `server/server.js` (serve landing.html when no yt_kid cookie)

**No unit tests** -- frontend HTML/CSS. Tested via browser.

The landing page should use the `frontend-design` skill for high design quality. It appears when a visitor hits `yourtube.me/` without a kid cookie set.

- [ ] **Step 1: Create `server/public/landing.html`**

Content:
- Hero section: "Don't let YouTube attention-mine your children" (or similar punchy headline)
- Subheading: "YourTube gives parents control. AI curates the channels. Your kid gets a clean feed. No algorithm, no ads rabbit hole, no login."
- How it works (3 steps with icons/illustrations):
  1. "Tell us what your child loves" -- parent lists interests
  2. "AI picks safe channels" -- Opus suggests, you approve
  3. "They get their own feed" -- bookmark on iPad, done
- "Set up your family" CTA button -> /admin
- Footer: "Built by a parent, for parents. Open source."
- Logo: stylised "YourTube" -- the "Your" in white, "Tube" in red (echoing YouTube but distinct)

- [ ] **Step 2: Create `server/public/css/landing.css`**

Clean, modern, not dark-mode (the kid feed is dark; the parent-facing pages are light). Mobile-responsive. The hero should feel confident and trustworthy, not techy.

- [ ] **Step 3: Modify `server/server.js` routing**

Current: `GET /` always serves `index.html` (kid SPA).
New: `GET /` checks for `yt_kid` cookie.
- If cookie present and valid: serve `index.html` (kid feed)
- If no cookie or invalid: serve `landing.html`

This means kids always see their feed, and new visitors see the landing page.

- [ ] **Step 4: Test in browser, commit**

```bash
git commit -m "feat(server): landing page for yourtube.me"
```

---

## Task 2: Channel status field + migration

**Files:**
- Create: `server/migrations/002-channel-status.sql`
- Modify: `server/lib/family-api.js` (update queries for status)
- Modify: `server/lib/feed-api.js` (only serve `approved` channels)
- Modify: `server/lib/worker-api.js` (manifest reports channel status)
- Test: update existing tests

- [ ] **Step 1: Write migration `002-channel-status.sql`**

```sql
ALTER TABLE channels ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE channels ADD COLUMN reason TEXT;
ALTER TABLE channels ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE kids ADD COLUMN channels_status TEXT NOT NULL DEFAULT 'idle';

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Update `family-api.js`**

- `addChannel` gains optional `status`, `reason`, `source` params (default: approved, null, manual)
- New: `addPendingChannel(db, kidId, { channel_id, title, reason, thumbnail })` -- inserts with status='pending', source='opus'
- New: `approveChannel(db, kidId, channelId)` -- sets status='approved'
- New: `rejectChannel(db, kidId, channelId)` -- sets status='rejected'
- New: `getPendingChannels(db, kidId)` -- returns pending channels with reasons
- `listChannels` gains optional `status` filter
- `getApprovedVideos` already filters by approved channels -- verify it joins on channel status too (it doesn't currently; videos have their own ai_approved flag, which is correct)

- [ ] **Step 3: Update `feed-api.js`**

- `getKidFeed` should only include channels with `status = 'approved'` in the channel tabs
- Videos are not affected (they're already filtered by ai_approved)

- [ ] **Step 4: Update `worker-api.js`**

- `getWorkerManifest` includes `channels_status` for each kid
- New: `getUnprocessedFeedback(db, kidId)` -- returns unprocessed feedback messages
- New: `markFeedbackProcessed(db, feedbackId)`

- [ ] **Step 5: Update tests, run, commit**

```bash
git commit -m "feat(server): channel status (pending/approved/rejected) and feedback table"
```

---

## Task 3: Worker fast loop for channel generation

**Files:**
- Modify: `worker/worker.js` (split into fast loop + slow loop)

- [ ] **Step 1: Write failing test**

Test that the worker exposes a `runFastLoop()` function that only processes kids with `channels_status = 'idle'` and `channels_generated = 0`.

- [ ] **Step 2: Refactor `worker/worker.js`**

Split into two loops:
- `runFastLoop()` (every 30s): fetches manifest, finds kids needing channel generation (`channels_generated = 0, channels_status = 'idle'`), runs `maybeGenerateChannels`. Also checks for unprocessed feedback and runs refinement.
- `runSlowLoop()` (every 30min): fetches manifest, runs RSS + Haiku filter for all kids with approved channels, pushes videos.

The fast loop sets `channels_status = 'generating'` before calling Opus, then `'ready'` after suggestions are pushed. This lets the admin UI show a spinner.

- [ ] **Step 3: Add server endpoints**

- `POST /api/worker/kid/:id/status` -- worker sets `channels_status` on a kid
- Modify existing `POST /api/worker/channels` to accept `status: 'pending'` and `reason`
- `POST /api/worker/kid/:id/feedback` -- worker reads and processes feedback

- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat(worker): fast loop for channel generation with status tracking"
```

---

## Task 4: Opus suggestions with descriptions

**Files:**
- Modify: `worker/lib/channel-gen.js` (richer prompt, return descriptions)

- [ ] **Step 1: Write failing test**

Test that `generateChannels` returns objects with `name`, `reason`, `searchQuery`, and `description` (a 1-2 sentence explanation of the channel aimed at the parent).

- [ ] **Step 2: Update Opus prompt**

The prompt should ask for richer output:
```json
{
  "channels": [
    {
      "name": "Mark Rober",
      "description": "Former NASA engineer who makes science and engineering videos. Think exploding glitter bombs and backyard squirrel obstacle courses.",
      "reason": "Matches Alex's interest in science experiments and engineering. Age-appropriate, educational, highly engaging.",
      "searchQuery": "Mark Rober YouTube"
    }
  ]
}
```

The `description` is shown to the parent in the review UI so they can make an informed decision without having to go look up each channel.

- [ ] **Step 3: Update worker to push pending channels with descriptions**

Worker pushes channels with `status: 'pending'`, `reason` (the description + reason combined or separate), and `source: 'opus'`.

- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat(worker): Opus generates channel descriptions for parent review"
```

---

## Task 5: Admin suggestion review UI

**Files:**
- Modify: `server/public/admin/index.html` (add suggestion review section)
- Modify: `server/public/admin/js/admin.js` (polling, approve/reject logic)
- Modify: `server/public/admin/css/admin.css` (suggestion cards)
- Add: `GET /api/kids/:id/suggestions` endpoint to server

**No unit tests** -- frontend UI. API endpoint tested via integration test.

- [ ] **Step 1: Add server endpoint**

`GET /api/kids/:id/suggestions` -- returns pending channels for a kid, each with `channel_id, title, reason, thumbnail`.

`POST /api/kids/:id/channels/:channelId/approve` -- sets status to approved.
`POST /api/kids/:id/channels/:channelId/reject` -- sets status to rejected.

- [ ] **Step 2: Update admin kid detail view**

After parent adds a kid with interests, the detail view shows:

**While generating** (`channels_status = 'generating'`):
- Spinner with "AI is finding channels for [name]... This takes about a minute."

**When ready** (`channels_status = 'ready'`, pending channels exist):
- "We found these channels for [name]. Review each one and approve or skip."
- List of suggestion cards, each showing:
  - Channel name (bold)
  - Description (Opus's description of the channel)
  - Why it fits (Opus's reason)
  - Thumbnail if available
  - "Approve" button (green) and "Skip" button (grey)
- "Approve all" button at the top
- "Add your own channel" input at the bottom
- "Tell the AI what to change" text input for feedback

**After review** (all pending processed):
- Normal channel list (approved channels)
- "Add a channel" input
- Feed status: "X videos from Y channels. Last updated: [time]"

- [ ] **Step 3: Implement polling in admin.js**

When the kid detail view loads and `channels_status` is `generating`:
- Poll `GET /api/kids/:id` every 3 seconds
- When status changes to `ready`, fetch suggestions and display cards
- Stop polling

- [ ] **Step 4: Test in browser, commit**

```bash
git commit -m "feat(admin): suggestion review UI with approve/reject and polling"
```

---

## Task 6: Feedback loop with Opus

**Files:**
- Add: `POST /api/kids/:id/feedback` endpoint
- Modify: `worker/worker.js` (process feedback in fast loop)
- Modify: `worker/lib/channel-gen.js` (add `refineChannels` function)
- Modify: admin UI (feedback input)

- [ ] **Step 1: Add server endpoint**

`POST /api/kids/:id/feedback` -- stores feedback message, sets `channels_status = 'refining'`.

- [ ] **Step 2: Add `refineChannels` to channel-gen.js**

New function: `refineChannels(kidProfile, currentChannels, feedback)`.

Opus prompt includes:
- The kid's profile (same as before)
- Currently approved channels
- Currently rejected channels
- Parent's feedback text (e.g. "More educational science, less gaming" or "He also loves chess")
- Asks Opus to suggest additional channels or replacements

Returns new suggestions (same format as `generateChannels`).

- [ ] **Step 3: Worker fast loop processes feedback**

When the fast loop finds a kid with `channels_status = 'refining'`:
- Fetch unprocessed feedback
- Call `refineChannels` with current state + feedback
- Push new pending channels
- Mark feedback as processed
- Set `channels_status = 'ready'`

- [ ] **Step 4: Admin UI feedback input**

In the suggestion review view and the channel management view:
- Text input: "Tell the AI what to change" with placeholder "e.g. More educational science, he also loves chess"
- Submit button
- When submitted: POST feedback, show spinner, poll for refined suggestions

- [ ] **Step 5: Test full loop in browser, commit**

```bash
git commit -m "feat: Opus feedback loop -- parent gives feedback, AI refines suggestions"
```

---

## Task 7: Restore admin dashboard features

**Files:**
- Modify: admin HTML, JS, CSS
- Add: server endpoints as needed

Restore features from the original admin that were dropped:

- [ ] **Step 1: Status section**

Show at top of kid detail:
- Video count in feed
- Channel count (approved)
- Last updated (from `last_pushed_at`)
- Worker status indicator

- [ ] **Step 2: Content guidelines editor**

Editable textarea in kid detail. Auto-saves on blur or after typing stops.
Uses `PATCH /api/kids/:id` with `guidelines` field (already exists).

- [ ] **Step 3: Recent videos in feed**

Show last 10 videos pushed (title, channel, thumbnail, approved/rejected status).
New endpoint: `GET /api/kids/:id/recent-videos` -- returns last 10 videos regardless of approval status, so parent can spot-check what the AI is doing.

- [ ] **Step 4: Manual channel management**

- "Add a channel" input that accepts YouTube URLs, channel names, or channel IDs
- Resolves to channel ID (can reuse `resolveChannelBySearch` or a server-side resolver)
- Channel list shows approved + pending channels, with ability to remove

- [ ] **Step 5: Setup link management**

- Regenerate setup link button
- Revoke all devices button (increments cookie_generation)
- Show QR code for setup link (easy to scan on iPad) -- use a simple QR library or inline SVG generator

- [ ] **Step 6: Test in browser, commit**

```bash
git commit -m "feat(admin): restore dashboard features -- status, guidelines, recent videos, channel mgmt"
```

---

## Task 8: Onboarding copy and UX polish

**Files:**
- Modify: admin HTML, JS, CSS

- [ ] **Step 1: Contextual help throughout**

Add explanatory text at each step:

**Signup screen:**
- Below the form: "YourTube is a filtered YouTube feed for kids. You set the interests, AI picks safe channels, and your child gets a clean feed on their iPad -- no login needed."

**After adding a child:**
- "We're using AI to find YouTube channels that match [name]'s interests. This takes about a minute. You'll be able to review every channel before it goes live."

**Suggestion review:**
- "These channels were picked by AI based on [name]'s interests. Approve the ones you like, skip the rest. You can always add more channels later or give the AI feedback."

**Setup link:**
- "Open this link on your child's iPad and bookmark it. From then on, [name] just opens the bookmark -- no login, no password, no YouTube algorithm."

**Channel management:**
- "These are the channels in [name]'s feed. Videos from approved channels are filtered by AI before appearing. You can add channels manually or ask the AI for more suggestions."

- [ ] **Step 2: Empty states**

Every section should have a helpful empty state:
- No children: "Add your first child to get started."
- No channels: "Channels will appear here after AI generates suggestions."
- No videos: "Videos will appear after the worker polls the channels (happens every 30 minutes)."

- [ ] **Step 3: Loading states**

Proper spinners/skeleton screens for:
- Initial dashboard load
- Suggestion generation
- Feedback processing
- Channel resolution

- [ ] **Step 4: Test full flow end-to-end in browser, commit**

```bash
git commit -m "feat(admin): onboarding copy, empty states, and loading states"
```

---

## Deployment

After all tasks:
- Run all tests: `cd server && node --test && cd ../worker && node --test`
- Deploy: `fly deploy --app yourtube-me`
- Full browser test on https://yourtube.me
- Test the complete parent flow: signup -> add kid -> wait for suggestions -> review -> approve -> share setup link -> test kid feed

---

## What's NOT in this plan

- Watch history (was in original admin; defer to later)
- Blocked items management (was in original; defer -- channels can be removed instead)
- YouTube OAuth import (replaced by Opus suggestions)
- Taste profile viewer/rebuild (replaced by interests + guidelines)
- Channel search within feed (kid browses curated feed only)
