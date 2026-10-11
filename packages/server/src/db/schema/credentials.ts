// Keys as credentials bound to hosts (spec/PROVIDERS.md §5, spec/PLUGINS.md §6.1). A key
// is stored once, connections reference it, and it's sent only to the origins it was
// entered for. Pointing it at a new origin takes the key typed again, which code acting
// as the user without knowing the key can't do (owner, 2026-10-11).
//
// connections.api_key_enc and key_hint from 0005 are retired. The table keeps them,
// because altering 0005's CHECKs would mean rebuilding a table other tables reference.
// Triggers keep them empty, and they go when migrations are squashed for the first release.
// The migration refuses to run if any connection already holds a key (migrations.ts).

export const credentials = [
  `CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    -- Encrypted with the server secret, bound to "credential:<id>:key".
    key_enc BLOB NOT NULL,
    key_hint TEXT NOT NULL,
    -- Origins (scheme://host[:port]) the key may be sent to.
    origins_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(origins_json)),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX credentials_owner ON credentials(owner_user_id)`,

  `ALTER TABLE connections ADD COLUMN credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL`,
  `CREATE INDEX connections_credential ON connections(credential_id) WHERE credential_id IS NOT NULL`,

  // A connection uses only its owner's credentials, and a purged connection keeps none.
  `CREATE TRIGGER connections_credential_owner BEFORE INSERT ON connections
    WHEN NEW.credential_id IS NOT NULL
      AND (SELECT owner_user_id FROM credentials WHERE id = NEW.credential_id) IS NOT NEW.owner_user_id
    BEGIN SELECT RAISE(ABORT, 'a connection can only use its owner''s credentials'); END`,
  `CREATE TRIGGER connections_credential_owner_update BEFORE UPDATE OF credential_id, owner_user_id ON connections
    WHEN NEW.credential_id IS NOT NULL
      AND (SELECT owner_user_id FROM credentials WHERE id = NEW.credential_id) IS NOT NEW.owner_user_id
    BEGIN SELECT RAISE(ABORT, 'a connection can only use its owner''s credentials'); END`,
  `CREATE TRIGGER connections_purged_no_credential BEFORE UPDATE OF purged_at, credential_id ON connections
    WHEN NEW.purged_at IS NOT NULL AND NEW.credential_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a purged connection keeps no credential'); END`,

  // The retired per-connection key columns stay empty.
  `CREATE TRIGGER connections_no_inline_key BEFORE INSERT ON connections
    WHEN NEW.api_key_enc IS NOT NULL OR NEW.key_hint IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'keys are stored as credentials'); END`,
  `CREATE TRIGGER connections_no_inline_key_update BEFORE UPDATE OF api_key_enc, key_hint ON connections
    WHEN NEW.api_key_enc IS NOT NULL OR NEW.key_hint IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'keys are stored as credentials'); END`
]

// Secrets bound to where they were entered (spec/PROVIDERS.md §5, migration 0008):
// - Custom header values often carry credentials too, so they're sent only to the origin
//   they were set for. Rows from before have none, and must be set again.
// - A credential made from a key typed into one connection belongs to it: typing a new
//   key there deletes the old one, rather than keeping a possibly leaked key at rest.
export const secretBindings = [
  `ALTER TABLE connections ADD COLUMN headers_origin TEXT`,
  `ALTER TABLE credentials ADD COLUMN connection_owned INTEGER NOT NULL DEFAULT 0 CHECK (connection_owned IN (0, 1))`
]
