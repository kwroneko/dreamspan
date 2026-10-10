// Per-user data, settings, connections and models, media, background jobs.
// DATA-MODEL.md §10, §11.

export const platform = [
  `CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('composer', 'version_edit', 'scratchpad', 'entity_field', 'summary_edit')),
    target_id TEXT NOT NULL,
    field TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    -- Compressed edit history: survives a refresh and recovers from Ctrl-A plus a stray key.
    undo_log BLOB,
    -- What the draft started from, for conflict detection on commit.
    base_revision TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, target_kind, target_id, field)
  ) STRICT`,

  `CREATE TABLE user_prefs (
    user_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    PRIMARY KEY (user_id, key)
  ) STRICT, WITHOUT ROWID`,

  // Settings scope chain (DATA-MODEL §5.4): app_settings → user_settings → chat state.
  `CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json))
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE user_settings (
    user_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    PRIMARY KEY (user_id, key)
  ) STRICT, WITHOUT ROWID`,

  // A connection is one wire type, one provider and one set of settings (DESIGN §9).
  `CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    api TEXT NOT NULL,
    base_url TEXT,
    -- Write-only: encrypted with a server secret, never sent to a browser.
    api_key_enc BLOB,
    headers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(headers_json)),
    preset_override_ref_id TEXT REFERENCES entity_refs(id),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX connections_owner ON connections(owner_user_id)`,

  `CREATE TABLE models (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connections(id),
    model_key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('fetched', 'user')),
    display_name TEXT NOT NULL,
    capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    fetched_at INTEGER,
    UNIQUE (connection_id, model_key)
  ) STRICT`,

  // Content-addressed files on disk, originals at full resolution, deduplicated
  // across users. Access is through media_refs.
  `CREATE TABLE media_assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    byte_size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE media_refs (
    media_id TEXT NOT NULL REFERENCES media_assets(id),
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (media_id, owner_user_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX media_refs_owner ON media_refs(owner_user_id)`,

  // Generic background work (import, backfill, idle-time scheduling).
  `CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT REFERENCES users(id),
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    request_class TEXT NOT NULL DEFAULT 'background' CHECK (request_class IN ('interactive', 'idle', 'background')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    run_after INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX jobs_queue ON jobs(status, request_class, run_after) WHERE status IN ('pending', 'processing')`
]
