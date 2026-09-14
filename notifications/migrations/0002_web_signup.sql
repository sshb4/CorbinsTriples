ALTER TABLE subscribers ADD COLUMN consent_source TEXT NOT NULL DEFAULT 'sms';
CREATE TABLE signup_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE signup_requests (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  state TEXT NOT NULL,
  message_sid TEXT
);
CREATE INDEX signup_retention ON signup_requests(created_at);
