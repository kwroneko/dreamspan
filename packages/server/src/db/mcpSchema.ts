// MCP storage (spec/MCP.md §12, M0): connections to MCP servers, the users an admin shares one
// with, each user's uses of one, and the ledger of every request the app sends to a server.
// Only the schema is built; the client, its operations and the UI are later units (M1+).
export const mcpSchema: ReadonlyArray<string> = [
  // MCP servers (spec/MCP.md §2): one per row, owned by one user, optionally shared by an admin.
  // Secrets are encrypted with the server secret, bound to "mcp:<id>:<part>"; only names are clear.
  `CREATE TABLE mcp_connections (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    -- The fixed part of the tools' names the model sees, mcp_<key>_<tool>. Never changes.
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 24 AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9]*'),
    -- The user's own words for what it's for: the skill index line.
    about TEXT NOT NULL DEFAULT '' CHECK (length(about) <= 1000),
    transport TEXT NOT NULL CHECK (transport IN ('streamable-http', 'sse', 'stdio')),
    url TEXT CHECK (url IS NULL OR length(url) <= 2048),
    -- stdio: the argv array, no shell.
    command_json TEXT CHECK (command_json IS NULL OR (json_valid(command_json) AND json_type(command_json) = 'array')),
    env_enc BLOB,
    env_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(env_names_json) AND json_type(env_names_json) = 'array'),
    credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
    headers_enc BLOB,
    header_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(header_names_json) AND json_type(header_names_json) = 'array'),
    headers_origin TEXT,
    proxy_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (proxy_mode IN ('inherit', 'direct', 'custom')),
    proxy_url_enc BLOB,
    timeout_s INTEGER NOT NULL DEFAULT 60 CHECK (timeout_s BETWEEN 5 AND 1800),
    loading TEXT NOT NULL DEFAULT 'auto' CHECK (loading IN ('auto', 'immediate', 'deferred')),
    use_instructions INTEGER NOT NULL DEFAULT 1 CHECK (use_instructions IN (0, 1)),
    share_scope TEXT NOT NULL DEFAULT 'private' CHECK (share_scope IN ('private', 'all', 'chosen')),
    -- The last listing (§4.1): server info and the tool catalog, with its revision.
    server_json TEXT CHECK (server_json IS NULL OR (json_valid(server_json) AND json_type(server_json) = 'object')),
    tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools_json) AND json_type(tools_json) = 'array'),
    catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0),
    listed_at INTEGER,
    check_error TEXT CHECK (check_error IS NULL OR length(check_error) <= 1000),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    -- Advances on any change to where or how calls are sent; open clients close on it.
    cache_revision INTEGER NOT NULL DEFAULT 0 CHECK (cache_revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    bin_item_id TEXT,
    -- Purged connections stay as tombstones, so the call ledger still names them.
    purged_at INTEGER,
    CHECK (purged_at IS NOT NULL OR ((transport = 'stdio') = (command_json IS NOT NULL) AND (transport = 'stdio') = (url IS NULL))),
    CHECK (transport = 'stdio' OR (env_enc IS NULL AND env_names_json = '[]')),
    CHECK (transport <> 'stdio' OR (credential_id IS NULL AND headers_enc IS NULL AND proxy_mode = 'inherit')),
    CHECK ((proxy_mode = 'custom') = (proxy_url_enc IS NOT NULL)),
    CHECK (purged_at IS NULL OR (url IS NULL AND command_json IS NULL AND env_enc IS NULL AND credential_id IS NULL
      AND headers_enc IS NULL AND proxy_url_enc IS NULL))
  ) STRICT`,
  `CREATE INDEX mcp_connections_owner ON mcp_connections(owner_user_id)`,
  `CREATE UNIQUE INDEX mcp_connections_key ON mcp_connections(owner_user_id, key) WHERE purged_at IS NULL`,
  `CREATE INDEX mcp_connections_credential ON mcp_connections(credential_id) WHERE credential_id IS NOT NULL`,
  `CREATE INDEX mcp_connections_shared ON mcp_connections(share_scope) WHERE share_scope <> 'private' AND deleted_at IS NULL`,
  `CREATE TRIGGER mcp_connections_identity BEFORE UPDATE OF id, owner_user_id, key, created_at ON mcp_connections
    WHEN NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.key IS NOT OLD.key OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'an MCP connection never changes identity, owner or key'); END`,
  `CREATE TRIGGER mcp_connections_credential_owner BEFORE INSERT ON mcp_connections
    WHEN NEW.credential_id IS NOT NULL
      AND (SELECT owner_user_id FROM credentials WHERE id = NEW.credential_id) IS NOT NEW.owner_user_id
    BEGIN SELECT RAISE(ABORT, 'an MCP connection can only use its owner''s credentials'); END`,
  `CREATE TRIGGER mcp_connections_credential_owner_update BEFORE UPDATE OF credential_id ON mcp_connections
    WHEN NEW.credential_id IS NOT NULL
      AND (SELECT owner_user_id FROM credentials WHERE id = NEW.credential_id) IS NOT NEW.owner_user_id
    BEGIN SELECT RAISE(ABORT, 'an MCP connection can only use its owner''s credentials'); END`,
  // A local program runs code on the server: only an admin may own one (§2.2).
  `CREATE TRIGGER mcp_connections_stdio_admin BEFORE INSERT ON mcp_connections
    WHEN NEW.transport = 'stdio' AND (SELECT role FROM users WHERE id = NEW.owner_user_id) IS NOT 'admin'
    BEGIN SELECT RAISE(ABORT, 'only an admin can add a local program'); END`,
  `CREATE TRIGGER mcp_connections_stdio_admin_update BEFORE UPDATE OF transport, command_json, env_enc ON mcp_connections
    WHEN NEW.transport = 'stdio' AND NEW.purged_at IS NULL
      AND (SELECT role FROM users WHERE id = NEW.owner_user_id) IS NOT 'admin'
    BEGIN SELECT RAISE(ABORT, 'only an admin can add a local program'); END`,
  // Sharing is an admin's (§3).
  `CREATE TRIGGER mcp_connections_share_admin BEFORE UPDATE OF share_scope ON mcp_connections
    WHEN NEW.share_scope <> 'private' AND (SELECT role FROM users WHERE id = NEW.owner_user_id) IS NOT 'admin'
    BEGIN SELECT RAISE(ABORT, 'only an admin can share an MCP connection'); END`,
  `CREATE TRIGGER mcp_connections_share_admin_insert BEFORE INSERT ON mcp_connections
    WHEN NEW.share_scope <> 'private' AND (SELECT role FROM users WHERE id = NEW.owner_user_id) IS NOT 'admin'
    BEGIN SELECT RAISE(ABORT, 'only an admin can share an MCP connection'); END`,
  // The users an admin chose to share a connection with (share_scope 'chosen').
  `CREATE TABLE mcp_connection_shares (
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, user_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX mcp_connection_shares_user ON mcp_connection_shares(user_id)`,
  `CREATE TRIGGER mcp_connection_shares_not_owner BEFORE INSERT ON mcp_connection_shares
    WHEN (SELECT owner_user_id FROM mcp_connections WHERE id = NEW.connection_id) = NEW.user_id
    BEGIN SELECT RAISE(ABORT, 'a connection is not shared with its owner'); END`,
  // One user's uses of a connection they own or were given (§5): the account defaults for
  // stories and workshops, the tool allow list, the catalog revision they
  // last saw (tools listed after it start off), and the key their tools are offered under.
  `CREATE TABLE mcp_uses (
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stories INTEGER NOT NULL DEFAULT 0 CHECK (stories IN (0, 1)),
    workshops INTEGER NOT NULL DEFAULT 0 CHECK (workshops IN (0, 1)),
    -- { "<MCP tool name>": { "on": bool } }: the allow list; annotations are never stored here.
    tools_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tools_json) AND json_type(tools_json) = 'object'),
    reviewed_revision INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_revision >= 0),
    offered_key TEXT NOT NULL CHECK (length(offered_key) BETWEEN 1 AND 26 AND offered_key NOT GLOB '*[^a-z0-9]*'),
    -- This user's own sign-in with the server (§2.4), bound to "mcp:<connection>:<user>:oauth".
    oauth_enc BLOB,
    oauth_origin TEXT,
    oauth_expires_at INTEGER,
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    updated_at INTEGER NOT NULL,
    CHECK ((oauth_enc IS NULL) = (oauth_origin IS NULL)),
    CHECK (oauth_expires_at IS NULL OR oauth_enc IS NOT NULL),
    PRIMARY KEY (connection_id, user_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX mcp_uses_user ON mcp_uses(user_id)`,
  `CREATE UNIQUE INDEX mcp_uses_offered_key ON mcp_uses(user_id, offered_key)`,
  `CREATE TRIGGER mcp_uses_access BEFORE INSERT ON mcp_uses
    WHEN NOT EXISTS (
      SELECT 1 FROM mcp_connections m WHERE m.id = NEW.connection_id AND m.purged_at IS NULL AND (
        m.owner_user_id = NEW.user_id OR m.share_scope = 'all'
        OR (m.share_scope = 'chosen' AND EXISTS (SELECT 1 FROM mcp_connection_shares s
          WHERE s.connection_id = m.id AND s.user_id = NEW.user_id))))
    BEGIN SELECT RAISE(ABORT, 'an MCP use needs a connection its user may use'); END`,
  `CREATE TRIGGER mcp_uses_identity BEFORE UPDATE OF connection_id, user_id, offered_key ON mcp_uses
    WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.user_id IS NOT OLD.user_id OR NEW.offered_key IS NOT OLD.offered_key
    BEGIN SELECT RAISE(ABORT, 'an MCP use never changes identity or key'); END`,
  // Every request the app sends to an MCP server (§10), opened before it is sent. Outlives
  // the chat it was for; holds no arguments or results (those are in the run's transcript).
  `CREATE TABLE mcp_calls (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
    connection_revision INTEGER NOT NULL CHECK (connection_revision >= 0),
    method TEXT NOT NULL CHECK (method IN ('initialize', 'tools/list', 'tools/call', 'oauth')),
    tool TEXT CHECK (tool IS NULL OR length(tool) <= 128),
    purpose TEXT NOT NULL CHECK (purpose IN ('story', 'workshop', 'check')),
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    rollout_id TEXT REFERENCES rollouts(id) ON DELETE SET NULL,
    tool_call_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'error', 'failed', 'timeout', 'cancelled', 'interrupted')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    sent_bytes INTEGER CHECK (sent_bytes IS NULL OR sent_bytes >= 0),
    received_bytes INTEGER CHECK (received_bytes IS NULL OR received_bytes >= 0),
    error TEXT CHECK (error IS NULL OR length(error) <= 1000),
    CHECK ((status = 'running') = (ended_at IS NULL)),
    CHECK ((method = 'tools/call') = (tool IS NOT NULL)),
    CHECK (method = 'tools/call' OR (rollout_id IS NULL AND tool_call_id IS NULL))
  ) STRICT`,
  `CREATE INDEX mcp_calls_owner ON mcp_calls(owner_user_id, started_at DESC)`,
  `CREATE INDEX mcp_calls_connection ON mcp_calls(connection_id, started_at DESC, id)`,
  `CREATE INDEX mcp_calls_call ON mcp_calls(rollout_id, tool_call_id) WHERE rollout_id IS NOT NULL`,
  `CREATE INDEX mcp_calls_chat ON mcp_calls(chat_id) WHERE chat_id IS NOT NULL`,
  `CREATE INDEX mcp_calls_live ON mcp_calls(status) WHERE status = 'running'`,
  `CREATE TRIGGER mcp_calls_owner BEFORE INSERT ON mcp_calls
    WHEN NOT EXISTS (SELECT 1 FROM mcp_uses u WHERE u.connection_id = NEW.connection_id AND u.user_id = NEW.owner_user_id)
      AND (SELECT owner_user_id FROM mcp_connections WHERE id = NEW.connection_id) IS NOT NEW.owner_user_id
    BEGIN SELECT RAISE(ABORT, 'an MCP call needs a connection its user may use'); END`,
  `CREATE TRIGGER mcp_calls_chat_owner BEFORE INSERT ON mcp_calls
    WHEN NEW.chat_id IS NOT NULL AND (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id) IS NOT NEW.owner_user_id
    BEGIN SELECT RAISE(ABORT, 'an MCP call is attributed only to its user''s chat'); END`,
  `CREATE TRIGGER mcp_calls_identity BEFORE UPDATE OF id, owner_user_id, connection_id, connection_revision, method, tool, purpose, rollout_id, tool_call_id, attempt, started_at ON mcp_calls
    WHEN NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.connection_id IS NOT OLD.connection_id
      OR NEW.connection_revision IS NOT OLD.connection_revision OR NEW.method IS NOT OLD.method OR NEW.tool IS NOT OLD.tool
      OR NEW.purpose IS NOT OLD.purpose OR NEW.attempt IS NOT OLD.attempt OR NEW.started_at IS NOT OLD.started_at
      OR NEW.tool_call_id IS NOT OLD.tool_call_id
      OR (NEW.rollout_id IS NOT OLD.rollout_id AND NEW.rollout_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'a call''s identity never changes; its attribution can only be cleared'); END`,
  `CREATE TRIGGER mcp_calls_closed_final BEFORE UPDATE OF status, ended_at, sent_bytes, received_bytes, error ON mcp_calls
    WHEN OLD.status <> 'running'
    BEGIN SELECT RAISE(ABORT, 'a closed MCP call is a record'); END`
]
