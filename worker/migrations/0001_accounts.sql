-- Accounts. `hash` is a salted hash of a key the browser derives from the
-- password; `profile` is sealed in the browser with a second derived key.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  profile TEXT,
  created_at INTEGER NOT NULL
);

-- One pending code per email and purpose ('signup' or 'reset'). For a signup,
-- `pending` holds the salt and hash until the email is confirmed.
CREATE TABLE codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  pending TEXT,
  expires_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, purpose)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
