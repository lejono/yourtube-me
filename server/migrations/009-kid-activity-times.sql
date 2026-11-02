-- When a child's device was first set up, and when the child last opened their feed.
ALTER TABLE kids ADD COLUMN device_setup_at TEXT;
ALTER TABLE kids ADD COLUMN last_seen_at TEXT;
