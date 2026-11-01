# Future: Ad-free playback via yt-dlp

## Goal

Use yt-dlp to download approved videos locally, serving them via `<video>` tags instead of the YouTube IFrame API. This removes all YouTube ads without violating the IFrame API ToS (since we'd stop using it).

## Why later

- Significant rearchitecture: player currently uses YouTube IFrame Player API
- Storage: videos are large (a 10-min 720p video is ~100-200 MB)
- Need to decide on quality/resolution tradeoffs
- Legal grey area for personal/family use — low risk but non-zero

## Rough approach

1. Scheduled download: after feed poll finds new approved videos, run `yt-dlp` to download them (720p, mp4)
2. Store in `data/videos-local/` or similar, keyed by video ID
3. Serve via static file route or streaming endpoint
4. Player detects local copy exists and uses `<video>` tag; falls back to YouTube embed if not downloaded yet
5. SponsorBlock integration: yt-dlp can mark/skip sponsor segments — could use this data in the local player
6. Storage management: auto-delete videos older than N days, keep a cache budget

## Research (2026-04-09)

- yt-dlp is actively maintained (latest stable: 2026.03.17, nightly builds daily)
- SponsorBlock integration already built into yt-dlp
- Chrome now flags yt-dlp downloads as "suspicious" — download via pip or direct from GitHub
- A DMCA Section 1201 lawsuit could theoretically threaten tools like yt-dlp, but no direct action against it yet
- Security fix CVE-2026-26331 addressed command injection — keep yt-dlp updated
