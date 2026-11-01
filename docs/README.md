# Docs

Project documentation for YourTube.

## Layout

- [`plans/`](plans/) — implementation plans, both current and future
- [`research/`](research/) — supporting investigation and notes
- [`setup/`](setup/) — practical setup guides for users

## Quick links

- [Product plan](plans/yourtube-v1.md) — the v1 goals and scope
- [OAuth setup](setup/oauth.md) — how to configure Google OAuth for subscription import
- [yt-dlp ad-free plan](plans/yt-dlp-ad-free.md) — future work: local video download to bypass ads
- [YouTube Data API research](research/youtube-oauth.md) — technical notes on the API
- [yt-dlp notes](research/yt-dlp.md) — notes on integrating yt-dlp

## Conventions

- `plans/` — living documents describing what we're building and why
- `research/` — supporting investigation, may go stale over time
- `setup/` — step-by-step guides for end users (should stay accurate)

If a research document turns into repeatable engineering instructions, move the actionable parts into `setup/` and keep the original reasoning in `research/`.
