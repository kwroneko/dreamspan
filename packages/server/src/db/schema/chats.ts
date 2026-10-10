// Chats and the message graph: slots (positions), versions (alternatives in place),
// lanes (threads), merges. DATA-MODEL.md §4.
//
// slots.selected_version_id and versions.slot_id reference each other, so both
// foreign keys are deferred: a slot and its first version are inserted in one
// transaction (version first, then slot).

export const chats = [
  `CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('rp', 'workshop')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'archived')),
    title TEXT NOT NULL DEFAULT '',
    title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
    cover_media_id TEXT REFERENCES media_assets(id),
    active_leaf_slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER
  ) STRICT`,
  // Recents sort by last message, never by last opened (DESIGN §2.1).
  `CREATE INDEX chats_recent ON chats(owner_user_id, last_message_at DESC) WHERE status = 'active'`,

  `CREATE TABLE lanes (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    forked_from_slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX lanes_chat ON lanes(chat_id)`,

  `CREATE TABLE slots (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    lane_id TEXT NOT NULL REFERENCES lanes(id),
    parent_slot_id TEXT REFERENCES slots(id),
    depth INTEGER NOT NULL CHECK (depth >= 0),
    selected_version_id TEXT NOT NULL REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,
    context_excluded INTEGER NOT NULL DEFAULT 0 CHECK (context_excluded IN (0, 1)),
    placement_group_id TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_visited_at INTEGER,
    CHECK ((parent_slot_id IS NULL) = (depth = 0))
  ) STRICT`,
  `CREATE INDEX slots_parent ON slots(parent_slot_id)`,
  `CREATE INDEX slots_chat_depth ON slots(chat_id, depth)`,
  `CREATE INDEX slots_placement_group ON slots(placement_group_id) WHERE placement_group_id IS NOT NULL`,

  // Extra parents of merge slots. Ordinal 0 duplicates slots.parent_slot_id.
  `CREATE TABLE slot_parents (
    slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    parent_slot_id TEXT NOT NULL REFERENCES slots(id),
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (slot_id, ordinal)
  ) STRICT, WITHOUT ROWID`,

  // seq is the rowid alias, so the FTS index keyed on it survives VACUUM.
  `CREATE TABLE versions (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('generating', 'complete', 'stopped', 'failed', 'interrupted')),
    speaker_entity_id TEXT REFERENCES entities(id),
    writer TEXT NOT NULL CHECK (writer IN ('human', 'model')),
    content TEXT NOT NULL DEFAULT '',
    macro_mode TEXT NOT NULL CHECK (macro_mode IN ('template', 'verbatim')),
    context_form TEXT,
    display_form TEXT,
    reasoning TEXT,
    frozen_macros TEXT CHECK (frozen_macros IS NULL OR json_valid(frozen_macros)),
    origin TEXT NOT NULL CHECK (origin IN
      ('generated', 'user_written', 'edited', 'greeting', 'imported', 'changeset', 'scratchpad')),
    source_version_id TEXT REFERENCES versions(id),
    greeting_ref TEXT CHECK (greeting_ref IS NULL OR json_valid(greeting_ref)),
    direction TEXT,
    rollout_id TEXT REFERENCES rollouts(id) DEFERRABLE INITIALLY DEFERRED,
    connection_id TEXT REFERENCES connections(id),
    model_id TEXT REFERENCES models(id),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    changeset_id TEXT REFERENCES changesets(id) DEFERRABLE INITIALLY DEFERRED,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (slot_id, ordinal),
    CHECK (status <> 'failed' OR error_json IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX versions_rollout ON versions(rollout_id) WHERE rollout_id IS NOT NULL`,

  // Earlier contents of amended user-written versions (DESIGN §3.1), written by a trigger.
  `CREATE TABLE version_history (
    id INTEGER PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    replaced_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX version_history_version ON version_history(version_id, id)`,

  `CREATE TABLE version_attachments (
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    media_id TEXT NOT NULL REFERENCES media_assets(id),
    kind TEXT NOT NULL CHECK (kind IN ('image')),
    alt_text TEXT,
    PRIMARY KEY (version_id, ordinal)
  ) STRICT, WITHOUT ROWID`
]
