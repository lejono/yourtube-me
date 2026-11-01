CREATE TABLE families (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE kids (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setup_token TEXT UNIQUE NOT NULL,
  cookie_generation INTEGER NOT NULL DEFAULT 1,
  age INTEGER,
  guidelines TEXT,
  interests TEXT,
  channels_generated INTEGER NOT NULL DEFAULT 0,
  last_pushed_at TEXT,
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
