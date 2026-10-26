-- One row per shared record (see ../src/share/schema.ts). uid makes retried uploads harmless.
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  install TEXT NOT NULL,
  app TEXT NOT NULL,
  time TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  received TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_install ON records (install);

-- "That was wrong" reports, with the frame. Never exported to the repo by the workflow.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  install TEXT NOT NULL,
  app TEXT NOT NULL,
  time TEXT NOT NULL,
  screen TEXT NOT NULL,
  text TEXT NOT NULL,
  read TEXT,
  image BLOB,
  image_type TEXT,
  received TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_install ON reports (install);

-- Rate limits per sender, kept against a salted hash of the address that changes daily.
CREATE TABLE IF NOT EXISTS limits (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  minute INTEGER NOT NULL,
  minute_count INTEGER NOT NULL,
  records INTEGER NOT NULL,
  reports INTEGER NOT NULL
);
