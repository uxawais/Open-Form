PRAGMA foreign_keys = ON;

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX submissions_form_created ON submissions(form_id, created_at DESC, id DESC);
CREATE INDEX submissions_expiry ON submissions(expires_at);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('notification', 'acknowledgment')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'accepted', 'failed', 'unknown', 'skipped')),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  cost INTEGER NOT NULL CHECK (cost BETWEEN 0 AND 5),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
  next_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  provider_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(submission_id, channel),
  CHECK (status = 'skipped' OR payload IS NOT NULL)
);
CREATE INDEX deliveries_due ON deliveries(status, next_at, id);
CREATE INDEX deliveries_submission ON deliveries(submission_id);

CREATE TABLE dedupe (
  key TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX dedupe_expiry ON dedupe(expires_at);

CREATE TABLE rate_counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_counters_expiry ON rate_counters(expires_at);

-- Anonymous reservations survive submission deletion so retention cannot reset
-- the email budget. No addresses or content are stored in this table.
CREATE TABLE email_reservations (
  delivery_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost BETWEEN 1 AND 5),
  expires_at INTEGER NOT NULL
);
CREATE INDEX email_reservations_day ON email_reservations(day);
CREATE INDEX email_reservations_month ON email_reservations(month);
CREATE INDEX email_reservations_expiry ON email_reservations(expires_at);
