CREATE TABLE signup_waitlist (
  phone TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  consent_source TEXT NOT NULL DEFAULT 'web'
);
