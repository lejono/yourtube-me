# YourTube

Parent-controlled YouTube for kids, running at [yourtube.me](https://yourtube.me).

A parent sets up a child (age, interests). YourTube suggests channels, the parent approves or skips them, and the child gets a feed built only from those channels. Each new video is checked by a content filter before it appears. There's no YouTube account, no ads from us, and no recommendation rabbit hole.

## How it works

1. The parent creates a child profile. The server matches curated channels from `server/migrations/seed-channels.json` (about 190 hand-checked channels tagged by interest and age).
2. For interests with no curated match, the worker asks Claude (Sonnet) to suggest channels. The parent reviews every suggestion.
3. The worker fetches each approved channel's public RSS feed and runs every new video's title and description past a Claude (Haiku) filter, with the child's age and the parent's guidelines.
4. The child's feed shows only filter-approved videos from parent-approved channels, interleaved across channels.

Kids sign in on their device with a one-time three-word code; no email or password for children.

## Layout

```
server/   Node + SQLite app on fly.io: API, kid app (public/index.html), parent dashboard (public/admin/)
worker/   Background worker: channel suggestions and video filtering via the Claude CLI
lib/      Shared helpers (lib/ai-usage.js: Claude usage log, spending cap, kill switch)
```

The files at the repo root (`server.js`, `config.js`, `public/`, `test/`) are the original single-family home-network version and are no longer deployed.

## Running it

Server:

```bash
cd server && npm install
YOURTUBE_SESSION_SECRET=dev YOURTUBE_WORKER_MASTER_KEY=dev-key node server.js   # http://127.0.0.1:3458
node --test test/*.test.js
```

Worker (needs the `claude` CLI, logged in):

```bash
cd worker && npm install
YOURTUBE_SERVER_URL=http://127.0.0.1:3458 YOURTUBE_WORKER_KEY=dev-key node worker.js
node --test test/*.test.js
```

## Safety and cost controls

- The video filter fails closed: if Claude errors or leaves a video out, that video stays hidden until the next refresh.
- Video text is passed to the filter as untrusted data, and the Claude CLI runs with every tool disabled from an empty directory.
- Spending cap: `YOURTUBE_AI_DAILY_BUDGET_USD` and `YOURTUBE_AI_MONTHLY_BUDGET_USD` stop Claude calls once the CLI's cost estimate reaches the limit. Creating the file named by `YOURTUBE_AI_KILL_FILE` stops all calls at once. `node worker/scripts/ai-usage-report.js` prints today's and this month's spend.
- Signup cap: `YOURTUBE_SIGNUP_SLOTS` and `YOURTUBE_SIGNUP_SLOTS_SINCE` limit new families; later signups join a waitlist.
- Rate limits on login, signup and kid setup codes; 64KB request limit; every per-child API call checks the child belongs to the logged-in parent.

Found a security problem? Please email yourtube@postquantum.space rather than opening a public issue.

## Related projects

- [Bouncer](https://imbue.com/product/bouncer/) by Imbue: a browser extension that filters your own X/Twitter feed by topics you describe. Same "take back the feed" idea for adults; YourTube does it for parents curating what their children watch.

## License

AGPL-3.0. See [LICENSE](LICENSE).
