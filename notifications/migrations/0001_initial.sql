CREATE TABLE subscribers (
  phone TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'stopped')),
  requested_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL,
  terms_version TEXT NOT NULL
);
CREATE TABLE incoming (
  sid TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE deliveries (
  id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES events(id),
  phone TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  claimed_at INTEGER,
  message_sid TEXT,
  error_code TEXT,
  PRIMARY KEY (event_id, phone)
);
CREATE INDEX delivery_queue ON deliveries(state);
CREATE TABLE monthly_usage (
  month TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0
);
