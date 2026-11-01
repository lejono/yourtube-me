CREATE TABLE curated_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  interests TEXT NOT NULL,        -- JSON array of interest tags
  age_min INTEGER NOT NULL DEFAULT 3,
  age_max INTEGER NOT NULL DEFAULT 16,
  quality TEXT NOT NULL DEFAULT 'researched',  -- 'verified', 'researched', 'community'
  source TEXT,                    -- where we found it: 'parent-signal', 'commonsense', etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_curated_age ON curated_channels(age_min, age_max);
