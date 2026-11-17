-- Users: roles are admin (Krayons, approves first), editor (Krayons, prepares posts),
-- approver (AHH, approves second and sets boost), viewer (AHH, read only).
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  org TEXT NOT NULL CHECK (org IN ('krayons','ahh')),
  role TEXT NOT NULL CHECK (role IN ('admin','editor','approver','viewer')),
  pw_hash TEXT,
  pw_salt TEXT,
  invite_token TEXT,
  invite_expires INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires INTEGER NOT NULL
);

-- Status flow:
-- outline_krayons -> outline_ahh -> in_production -> post_krayons -> post_ahh -> approved -> scheduled
-- send-backs: outline_changes, post_changes
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT,
  channel TEXT NOT NULL DEFAULT 'Feed',
  format TEXT,
  series TEXT,
  phase TEXT,
  title TEXT NOT NULL,
  brief TEXT,
  onscreen TEXT,
  caption TEXT,
  hashtags TEXT,
  cta TEXT,
  ads_plan TEXT,
  notes TEXT,
  boost INTEGER NOT NULL DEFAULT 0,
  media_key TEXT,
  media_type TEXT,
  media_name TEXT,
  status TEXT NOT NULL DEFAULT 'outline_krayons',
  updated_at INTEGER NOT NULL
);
CREATE INDEX posts_date ON posts(date);
CREATE INDEX posts_status ON posts(status);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  note TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX events_post ON events(post_id);

-- Starting users agreed with Raj on 17 Nov 2026. Each sets a password through a one-time link.
-- View-only AHH users are added by Raj from the Users page.
INSERT INTO users (username, name, org, role, created_at) VALUES
  ('raj', 'Raj', 'krayons', 'admin', 0),
  ('krayons', 'Krayons team', 'krayons', 'editor', 0),
  ('vikram', 'Vikram', 'ahh', 'approver', 0);
