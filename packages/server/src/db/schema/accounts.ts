// Built-in login (DESIGN §10.1). A user with a password can log in; sessions are kept
// as the SHA-256 of their token, so a copy of the database holds no live session.

export const accounts = [
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  `CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX sessions_user ON sessions(user_id)`
]
