-- Instagram account, one row per day (IST). Followers are a nightly snapshot; reach/views are Meta's daily values.
CREATE TABLE ig_daily (
  date TEXT PRIMARY KEY,
  followers INTEGER,
  reach INTEGER,
  views INTEGER,
  updated_at INTEGER NOT NULL
);

-- Instagram feed posts and reels, with their own insights. post_id links to the approval board.
CREATE TABLE ig_media (
  id TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL,
  date TEXT NOT NULL,
  media_type TEXT,
  product_type TEXT,
  caption TEXT,
  permalink TEXT,
  thumbnail_url TEXT,
  like_count INTEGER,
  comments_count INTEGER,
  reach INTEGER,
  views INTEGER,
  saved INTEGER,
  shares INTEGER,
  total_interactions INTEGER,
  post_id INTEGER REFERENCES posts(id),
  updated_at INTEGER NOT NULL
);
CREATE INDEX ig_media_date ON ig_media(date);

-- Meta Ads, one row per campaign per day.
CREATE TABLE ad_daily (
  date TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  spend REAL,
  impressions INTEGER,
  reach INTEGER,
  clicks INTEGER,
  results TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (date, campaign_id)
);

-- Planned budgets. A Meta campaign counts towards a plan line when its name starts with the prefix.
CREATE TABLE ad_budget (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  amount REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);
-- Agreed with Raj on 4 Nov 2026; start dates moved to 19 Nov when the Kochi launch moved.
INSERT INTO ad_budget (name, prefix, amount, start_date, end_date) VALUES
  ('Always-on followers', 'AHH | Always-on', 20000, '2026-11-19', '2027-02-14'),
  ('Kochi maker call', 'AHH | Kochi maker call', 4000, '2026-11-19', '2026-12-15'),
  ('NIFT maker call', 'AHH | NIFT maker call', 4000, '2026-12-01', '2027-01-10'),
  ('Kochi visitors', 'AHH | Kochi visitors', 16000, '2027-01-04', '2027-01-30'),
  ('NIFT visitors', 'AHH | NIFT visitors', 16000, '2027-01-20', '2027-02-14');

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
