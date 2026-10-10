// Library: layered, versioned documents (cards, presets, lorebooks, notes, preset
// overlays). DATA-MODEL.md §3. Revisions are immutable snapshots, like git commits;
// refs are the movable pointers users pick.

export const library = [
  `CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('card', 'preset', 'lorebook', 'note', 'preset_overlay')),
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  ) STRICT`,
  `CREATE INDEX entities_owner_kind ON entities(owner_user_id, kind) WHERE archived_at IS NULL`,

  // seq is the rowid alias, so the FTS index keyed on it survives VACUUM.
  `CREATE TABLE entity_revisions (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    entity_id TEXT NOT NULL REFERENCES entities(id),
    parents TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parents) AND json_type(parents) = 'array'),
    doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
    doc_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('import', 'user', 'agent', 'changeset', 'merge')),
    origin_ref TEXT,
    message TEXT,
    -- Plain text extracted from doc_json for full-text search.
    search_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX entity_revisions_entity ON entity_revisions(entity_id, seq)`,
  `CREATE INDEX entity_revisions_hash ON entity_revisions(entity_id, doc_hash)`,

  `CREATE TABLE entity_refs (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entities(id),
    ref_kind TEXT NOT NULL CHECK (ref_kind IN ('upstream', 'variant', 'chat_override')),
    head_revision_id TEXT NOT NULL REFERENCES entity_revisions(id),
    follows_ref_id TEXT REFERENCES entity_refs(id),
    merge_base_revision_id TEXT REFERENCES entity_revisions(id),
    label TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    chat_id TEXT REFERENCES chats(id) DEFERRABLE INITIALLY DEFERRED,
    source_path TEXT,
    source_hash TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    CHECK ((ref_kind = 'chat_override') = (chat_id IS NOT NULL)),
    CHECK (ref_kind = 'upstream' OR follows_ref_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX entity_refs_entity ON entity_refs(entity_id)`,
  `CREATE INDEX entity_refs_chat ON entity_refs(chat_id) WHERE chat_id IS NOT NULL`,
  `CREATE INDEX entity_refs_follows ON entity_refs(follows_ref_id) WHERE follows_ref_id IS NOT NULL`,

  // Folders are tags; the reserved tag 'persona' is the persona folder (DESIGN §2.2).
  `CREATE TABLE entity_tags (
    entity_id TEXT NOT NULL REFERENCES entities(id),
    tag TEXT NOT NULL,
    PRIMARY KEY (entity_id, tag)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX entity_tags_tag ON entity_tags(tag, entity_id)`,

  // A revision's head must belong to the ref's entity.
  `CREATE TRIGGER entity_refs_head_same_entity
    BEFORE INSERT ON entity_refs
    WHEN (SELECT entity_id FROM entity_revisions WHERE id = NEW.head_revision_id) IS NOT NEW.entity_id
    BEGIN SELECT RAISE(ABORT, 'entity_refs.head_revision_id belongs to another entity'); END`,
  `CREATE TRIGGER entity_refs_head_same_entity_update
    BEFORE UPDATE OF head_revision_id ON entity_refs
    WHEN (SELECT entity_id FROM entity_revisions WHERE id = NEW.head_revision_id) IS NOT NEW.entity_id
    BEGIN SELECT RAISE(ABORT, 'entity_refs.head_revision_id belongs to another entity'); END`
]
