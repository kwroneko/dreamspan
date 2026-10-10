// The recycle bin (DESIGN §6.2): deletes mark rows instead of removing them, so they
// disappear from where they were and can be restored in place. Two independent sections,
// each with its own capacity: deleted items (explicit deletes of things with an
// identity) and recovered text (passively saved draft text).

export const bin = [
  `ALTER TABLE chats ADD COLUMN deleted_at INTEGER`,
  `ALTER TABLE chats ADD COLUMN bin_item_id TEXT`,
  `ALTER TABLE slots ADD COLUMN deleted_at INTEGER`,
  `ALTER TABLE slots ADD COLUMN bin_item_id TEXT`,
  `ALTER TABLE slots ADD COLUMN purged_at INTEGER`,
  `ALTER TABLE versions ADD COLUMN deleted_at INTEGER`,
  `ALTER TABLE versions ADD COLUMN bin_item_id TEXT`,
  `ALTER TABLE versions ADD COLUMN purged_at INTEGER`,
  `ALTER TABLE entities ADD COLUMN deleted_at INTEGER`,
  `ALTER TABLE entities ADD COLUMN bin_item_id TEXT`,
  `ALTER TABLE entities ADD COLUMN purged_at INTEGER`,
  `CREATE INDEX slots_bin_item ON slots(bin_item_id) WHERE bin_item_id IS NOT NULL`,
  `CREATE INDEX versions_bin_item ON versions(bin_item_id) WHERE bin_item_id IS NOT NULL`,

  `CREATE TABLE bin_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('chat', 'message', 'branch', 'version', 'entity')),
    target_id TEXT NOT NULL,
    -- The chat an item belongs to (null for entities), so deleting the chat for good
    -- takes its items along.
    chat_id TEXT,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
    byte_size INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX bin_items_user ON bin_items(user_id, deleted_at)`,
  `CREATE INDEX bin_items_chat ON bin_items(chat_id) WHERE chat_id IS NOT NULL`,

  `CREATE TABLE recovered_texts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    -- The draft it came from.
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_field TEXT NOT NULL,
    source_label TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('commit', 'discard')),
    content TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX recovered_texts_user ON recovered_texts(user_id, created_at)`,

  // Model output stays frozen, except that deleting it for good empties it.
  `DROP TRIGGER versions_model_content_frozen`,
  `CREATE TRIGGER versions_model_content_frozen BEFORE UPDATE OF content ON versions
    WHEN OLD.writer = 'model' AND OLD.status <> 'generating' AND NEW.content IS NOT OLD.content
      AND NOT (NEW.purged_at IS NOT NULL AND NEW.content = '')
    BEGIN SELECT RAISE(ABORT, 'model-written versions are immutable once generated; create a new version'); END`
]
