CREATE TABLE watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  UNIQUE(kid_id, video_id)
);

CREATE TABLE likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT,
  channel_title TEXT,
  liked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kid_id, video_id)
);
