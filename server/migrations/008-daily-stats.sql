-- Aggregate counters only: no IPs, no cookies, no per-visitor rows.
CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  key TEXT NOT NULL,          -- e.g. view:landing, signup, ref:news.ycombinator.com
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
