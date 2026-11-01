# yt-dlp integration notes

## What is yt-dlp?

yt-dlp is a command-line tool for downloading and extracting metadata from YouTube
(and other video platforms). Installed locally on the laptop as of 2026-03-23.

## Why it's relevant to YourTube

YourTube currently uses YouTube's iframe embed API for playback (`public/js/player.js`).
yt-dlp could enable several v2 features:

### Offline / local playback
Download approved videos so they play without internet. Useful for car trips,
flights, or when the home network is unreliable. Serve video files directly
from the Node.js server instead of relying on YouTube's embed.

### Content archival
Keep backups of approved videos. YouTube removes content regularly (copyright
strikes, creator deletions, regional restrictions). Once a parent approves a
video, it shouldn't vanish.

### Pre-approval transcript extraction
yt-dlp can extract subtitles and auto-generated transcripts. The AI filter
(`lib/filter.js`) already uses Claude to assess content — feeding it a full
transcript before the kid ever sees the video would be a stronger safety net
than filtering on metadata alone.

### Independence from YouTube API quotas
The YouTube Data API v3 has a 10,000-unit daily quota. yt-dlp doesn't use the
API at all — it scrapes directly. For bulk operations (importing a large
subscription list, refreshing metadata), yt-dlp could supplement or replace
API calls.

## Implementation sketch

```bash
# Download a video (best quality up to 720p, mp4)
yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" \
  --merge-output-format mp4 \
  -o "data/videos/%(id)s.%(ext)s" \
  "https://www.youtube.com/watch?v=VIDEO_ID"

# Extract subtitles only (no video download)
yt-dlp --write-auto-sub --sub-lang en --skip-download \
  -o "data/subs/%(id)s" \
  "https://www.youtube.com/watch?v=VIDEO_ID"

# Get metadata as JSON
yt-dlp --dump-json "https://www.youtube.com/watch?v=VIDEO_ID"
```

## Considerations

- **Storage**: Each 720p video is roughly 200-500 MB. Need a storage budget
  and cleanup policy (e.g., keep last 50 approved videos).
- **YouTube ToS**: Downloading violates YouTube's terms of service. This is a
  personal, local-only, non-commercial use case for a child's safety. Not
  distributing anything.
- **Latency**: Downloads take time. Would need a background queue that
  pre-fetches approved videos, not on-demand download at play time.
- **Fallback**: Keep iframe embed as primary, use local files as fallback
  (or vice versa for offline mode).

## Priority

v2 feature. Current iframe approach works fine for v1. Revisit when:
- Kid starts watching on the go (offline need)
- YouTube API quota becomes a bottleneck
- A video the kid loved gets deleted and there are tears
