CREATE TABLE parent_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  rating INTEGER NOT NULL,  -- 1 = thumbs up, -1 = thumbs down
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kid_id, video_id)
);
