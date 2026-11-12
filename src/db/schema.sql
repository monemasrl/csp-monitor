CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE,
  domains TEXT NOT NULL,              -- JSON array di pattern: "gida-spa.it", "*.gida-spa.it"
  created_at INTEGER NOT NULL, learning_until INTEGER NOT NULL,
  learning_summary_sent INTEGER NOT NULL DEFAULT 0,
  rate_per_min INTEGER NOT NULL DEFAULT 120, rate_per_day INTEGER NOT NULL DEFAULT 20000,
  last_report_at INTEGER
);
CREATE TABLE IF NOT EXISTS origins (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL DEFAULT 'csp-violation',
  directive TEXT NOT NULL, origin TEXT NOT NULL,
  category TEXT NOT NULL,             -- external | inline | eval | data | blob | self
  status TEXT NOT NULL DEFAULT 'new', -- new | approved | suspect
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  first_page TEXT, last_alert_at INTEGER,
  UNIQUE (site_id, report_type, directive, origin)
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE, -- NULL = globale
  pattern TEXT NOT NULL, directive TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (site_id, pattern, directive)
);
CREATE TABLE IF NOT EXISTS noise_patterns (id INTEGER PRIMARY KEY, pattern TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS daily_counts (
  site_id INTEGER NOT NULL, report_type TEXT NOT NULL, directive TEXT NOT NULL, origin TEXT NOT NULL,
  day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (site_id, report_type, directive, origin, day)
);
CREATE TABLE IF NOT EXISTS noise_counts (
  site_id INTEGER NOT NULL, reason TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (site_id, reason, day)  -- reason: extension | foreign-document | known-noise | bot | rate-limit | invalid
);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, origin_id INTEGER REFERENCES origins(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL, received_at INTEGER NOT NULL, page TEXT, source_file TEXT,
  script_sample TEXT, line INTEGER, ua TEXT, disposition TEXT, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_origin ON samples (origin_id, received_at);
CREATE TABLE IF NOT EXISTS pending_alerts (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, origin_id INTEGER, kind TEXT NOT NULL,
  created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
