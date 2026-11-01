CREATE TABLE curated_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  channel_title TEXT,
  description TEXT,
  interests TEXT NOT NULL,     -- JSON array
  age_min INTEGER NOT NULL DEFAULT 3,
  age_max INTEGER NOT NULL DEFAULT 16,
  source TEXT DEFAULT 'curated',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
