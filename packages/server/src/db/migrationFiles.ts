// 0002_files (spec/FILES-AND-ENVIRONMENT.md §10): the first migration after the frozen baseline.
// Additive only: two new tables and four nullable or defaulted columns; no existing row is
// rewritten. The file tree itself lives on disk (FILES_DIR/<userId>); the database keeps what
// the tree can't: earlier contents, shares, and what an attachment named.
export const filesMigration: ReadonlyArray<string> = [
  // Earlier contents of an account's files, in the content-addressed media store. A row is
  // never changed, only deleted by retention or with its account. `rollout_id`/`tool_call_id`
  // name the agent call that made the change: provenance, kept when the run is gone.
  `CREATE TABLE file_versions (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
    inode INTEGER,
    media_id TEXT REFERENCES media_assets(id),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    origin TEXT NOT NULL,
    actor_user_id TEXT REFERENCES users(id),
    rollout_id TEXT,
    tool_call_id TEXT,
    created_at INTEGER NOT NULL,
    CHECK ((rollout_id IS NULL) = (tool_call_id IS NULL))
  ) STRICT`,
  `CREATE INDEX file_versions_path ON file_versions(owner_user_id, path, created_at)`,
  `CREATE INDEX file_versions_call ON file_versions(rollout_id, tool_call_id)`,
  `CREATE INDEX file_versions_media ON file_versions(media_id)`,
  `CREATE INDEX file_versions_actor ON file_versions(actor_user_id)`,
  `CREATE TRIGGER file_versions_immutable BEFORE UPDATE ON file_versions BEGIN
    SELECT RAISE(ABORT, 'file versions are immutable');
  END`,
  // A folder shared with another account (§1.4): Can view or Can edit.
  `CREATE TABLE file_shares (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
    inode INTEGER,
    grantee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
    created_at INTEGER NOT NULL,
    UNIQUE (owner_user_id, path, grantee_user_id)
  ) STRICT`,
  `CREATE INDEX file_shares_grantee ON file_shares(grantee_user_id)`,
  `CREATE TRIGGER file_shares_not_self BEFORE INSERT ON file_shares WHEN NEW.owner_user_id = NEW.grantee_user_id BEGIN
    SELECT RAISE(ABORT, 'a folder is not shared with its owner');
  END`,
  // An attachment of any type (§6.1): its name and where it was saved in Files.
  `ALTER TABLE version_attachments ADD COLUMN name TEXT`,
  `ALTER TABLE version_attachments ADD COLUMN path TEXT`,
  `ALTER TABLE composer_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'`,
  `ALTER TABLE composer_images ADD COLUMN name TEXT`
]
