// The provider layer (spec/PROVIDERS.md): connections reshaped around provider kinds,
// models with fetched data and user edits kept apart, and the usage ledger.
//
// Nothing writes connections or models before this migration, so both are recreated in
// their final shape. The migration refuses to run if either holds rows (migrations.ts).
// Versions, rollouts and chats refer to them by name, so their foreign keys follow.

export const providers = [
  `DROP TABLE models`,
  `DROP TABLE connections`,

  // One provider kind, one wire API, one base URL, one key (PROVIDERS §2). `kind` and
  // `api` follow pi-ai's catalog, so they're validated by the shared schema rather than
  // a CHECK list here.
  `CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    api TEXT NOT NULL,
    -- NULL means the kind's default.
    base_url TEXT,
    -- Write-only secrets, encrypted with the server secret (PROVIDERS §5). Header values
    -- often carry credentials too, so only header names are ever shown.
    api_key_enc BLOB,
    key_hint TEXT,
    headers_enc BLOB,
    header_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(header_names_json)),
    compat_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(compat_json)),
    cache_ttl_s INTEGER CHECK (cache_ttl_s IS NULL OR cache_ttl_s > 0),
    max_concurrent INTEGER CHECK (max_concurrent IS NULL OR max_concurrent >= 1),
    -- The per-connection proxy override (PROVIDERS §6.2).
    proxy_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (proxy_mode IN ('inherit', 'direct', 'custom')),
    proxy_url_enc BLOB,
    preset_override_ref_id TEXT REFERENCES entity_refs(id),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    bin_item_id TEXT,
    -- Purged connections stay as tombstones, so old messages and ledger rows still
    -- name their model (PROVIDERS §10).
    purged_at INTEGER,
    CHECK ((api_key_enc IS NULL) = (key_hint IS NULL)),
    CHECK ((proxy_mode = 'custom') = (proxy_url_enc IS NOT NULL)),
    CHECK (purged_at IS NULL OR (api_key_enc IS NULL AND headers_enc IS NULL AND proxy_url_enc IS NULL AND base_url IS NULL))
  ) STRICT`,
  `CREATE INDEX connections_owner ON connections(owner_user_id)`,

  // A model's description merges pi-ai's catalog, the upstream list and the user's edits
  // (PROVIDERS §3.1). A refresh rewrites upstream_json and never touches overrides_json.
  // Rows are never deleted by a refresh: a model the list stops reporting gets
  // missing_since.
  `CREATE TABLE models (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connections(id),
    model_key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('fetched', 'user')),
    upstream_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(upstream_json)),
    overrides_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides_json)),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    fetched_at INTEGER,
    missing_since INTEGER,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE (connection_id, model_key)
  ) STRICT`,
  `CREATE TRIGGER models_connection_fixed BEFORE UPDATE OF connection_id, model_key ON models
    WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.model_key IS NOT OLD.model_key
    BEGIN SELECT RAISE(ABORT, 'a model never moves to another connection or key'); END`,

  // The usage ledger (PROVIDERS §9.1): one row per request to a model, retries and
  // failed attempts included. Opened as 'running' before the request is sent, closed
  // with its counts. Token counts are NULL when unknown, never zero.
  //
  // Provider-reported numbers get no CHECKs: a quirky upstream must never make the
  // closing write fail, or a billed request would go unrecorded.
  //
  // The ledger outlives what it's attributed to: deleting a chat for good keeps its
  // requests, with the attribution cleared.
  `CREATE TABLE llm_requests (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    connection_id TEXT NOT NULL REFERENCES connections(id),
    model_id TEXT REFERENCES models(id),
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    rollout_id TEXT REFERENCES rollouts(id) ON DELETE SET NULL,
    version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
    purpose TEXT NOT NULL CHECK (purpose IN
      ('generation', 'summarize', 'condense', 'decision', 'workshop', 'idle_job', 'edit', 'test')),
    -- What was requested.
    api TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_key TEXT NOT NULL,
    -- What served it: the model the response named, and the routed upstream where a
    -- gateway reports one (OpenRouter).
    response_model TEXT,
    upstream TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'aborted', 'interrupted')),
    started_at INTEGER NOT NULL,
    first_token_at INTEGER,
    ended_at INTEGER,
    -- Normalized counts (PROVIDERS §9.2). cache_write_long is the subset of cache_write
    -- written with the long TTL; reasoning is the subset of output.
    input_uncached INTEGER,
    cache_read INTEGER,
    cache_write INTEGER,
    cache_write_long INTEGER,
    output INTEGER,
    reasoning INTEGER,
    usage_source TEXT NOT NULL DEFAULT 'none' CHECK (usage_source IN ('reported', 'estimated', 'none')),
    -- The provider's usage object verbatim, so counts can be recomputed if a
    -- normalization turns out wrong.
    raw_usage_json TEXT CHECK (raw_usage_json IS NULL OR json_valid(raw_usage_json)),
    reported_cost REAL,
    cost REAL,
    cost_currency TEXT,
    -- What produced cost: a built-in price source, 'reported', or a user formula.
    cost_formula TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    CHECK ((status = 'running') = (ended_at IS NULL)),
    CHECK ((cost IS NULL) = (cost_currency IS NULL) AND (cost IS NULL) = (cost_formula IS NULL))
  ) STRICT`,
  `CREATE INDEX llm_requests_owner ON llm_requests(owner_user_id, started_at)`,
  `CREATE INDEX llm_requests_connection ON llm_requests(connection_id, started_at)`,
  `CREATE INDEX llm_requests_running ON llm_requests(status) WHERE status = 'running'`,
  // Deleting a chat for good clears attribution row by row, so these must be indexed.
  `CREATE INDEX llm_requests_chat ON llm_requests(chat_id) WHERE chat_id IS NOT NULL`,
  `CREATE INDEX llm_requests_rollout ON llm_requests(rollout_id) WHERE rollout_id IS NOT NULL`,
  `CREATE INDEX llm_requests_version ON llm_requests(version_id) WHERE version_id IS NOT NULL`,

  // Attribution stays inside the user's own data, and a request's model belongs to its
  // connection.
  `CREATE TRIGGER llm_requests_attribution_valid BEFORE INSERT ON llm_requests
    WHEN (NEW.chat_id IS NOT NULL AND (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id) IS NOT NEW.owner_user_id)
      OR (NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id)
      OR (NEW.version_id IS NOT NULL AND (SELECT s.chat_id FROM versions v JOIN slots s ON s.id = v.slot_id
        WHERE v.id = NEW.version_id) IS NOT NEW.chat_id)
      OR (NEW.model_id IS NOT NULL AND (SELECT connection_id FROM models WHERE id = NEW.model_id) IS NOT NEW.connection_id)
    BEGIN SELECT RAISE(ABORT, 'a request is attributed only to its own user''s chat, and to a model of its connection'); END`,
  `CREATE TRIGGER llm_requests_identity_fixed BEFORE UPDATE OF owner_user_id, connection_id, model_id, purpose, api, provider, model_key, started_at ON llm_requests
    WHEN NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.connection_id IS NOT OLD.connection_id
      OR NEW.model_id IS NOT OLD.model_id OR NEW.purpose IS NOT OLD.purpose OR NEW.api IS NOT OLD.api
      OR NEW.provider IS NOT OLD.provider OR NEW.model_key IS NOT OLD.model_key OR NEW.started_at IS NOT OLD.started_at
    BEGIN SELECT RAISE(ABORT, 'a request''s user, connection, model and purpose never change'); END`,
  // Attribution is set when the row opens. Afterwards it can only be cleared, which is
  // what deleting the chat does.
  `CREATE TRIGGER llm_requests_attribution_fixed BEFORE UPDATE OF chat_id, rollout_id, version_id ON llm_requests
    WHEN (NEW.chat_id IS NOT NULL AND NEW.chat_id IS NOT OLD.chat_id)
      OR (NEW.rollout_id IS NOT NULL AND NEW.rollout_id IS NOT OLD.rollout_id)
      OR (NEW.version_id IS NOT NULL AND NEW.version_id IS NOT OLD.version_id)
    BEGIN SELECT RAISE(ABORT, 'a request''s attribution can only be cleared, never moved'); END`,
  // A closed request is a record: only its cost may be recomputed later (PROVIDERS §9.3).
  `CREATE TRIGGER llm_requests_closed_frozen BEFORE UPDATE ON llm_requests
    WHEN OLD.status <> 'running' AND (
      NEW.status IS NOT OLD.status OR NEW.ended_at IS NOT OLD.ended_at OR NEW.first_token_at IS NOT OLD.first_token_at
      OR NEW.response_model IS NOT OLD.response_model OR NEW.upstream IS NOT OLD.upstream
      OR NEW.input_uncached IS NOT OLD.input_uncached OR NEW.cache_read IS NOT OLD.cache_read
      OR NEW.cache_write IS NOT OLD.cache_write OR NEW.cache_write_long IS NOT OLD.cache_write_long
      OR NEW.output IS NOT OLD.output OR NEW.reasoning IS NOT OLD.reasoning OR NEW.usage_source IS NOT OLD.usage_source
      OR NEW.raw_usage_json IS NOT OLD.raw_usage_json OR NEW.reported_cost IS NOT OLD.reported_cost
      OR NEW.error_json IS NOT OLD.error_json)
    BEGIN SELECT RAISE(ABORT, 'a closed request is a record; only its cost can be recomputed'); END`,

  // Connections go through the recycle bin (PROVIDERS §10). SQLite can't change a CHECK
  // in place, so bin_items is rebuilt with the new kind.
  `CREATE TABLE bin_items_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('chat', 'message', 'branch', 'version', 'entity', 'connection')),
    target_id TEXT NOT NULL,
    chat_id TEXT,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
    byte_size INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
  ) STRICT`,
  `INSERT INTO bin_items_new SELECT id, user_id, kind, target_id, chat_id, title, excerpt, origin_json, byte_size, deleted_at FROM bin_items`,
  `DROP TABLE bin_items`,
  `ALTER TABLE bin_items_new RENAME TO bin_items`,
  `CREATE INDEX bin_items_user ON bin_items(user_id, deleted_at)`,
  `CREATE INDEX bin_items_chat ON bin_items(chat_id) WHERE chat_id IS NOT NULL`
]
