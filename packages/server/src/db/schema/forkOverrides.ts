// Migration 0054: the overlay of what belongs to a fork (spec/FORK-INDEPENDENCE-DELTA.md
// §2.2). A fork sees its own rows, its parent's up to the moment it was made, its
// grandparent's up to the moment the parent was made, and so on: `forks.lineage_json`
// lists them as `[[fork, bound], …]`, itself first with no bound. Every per-fork write takes
// the next `chats.state_seq` as its `seq`, so a fork made later reads it and one made earlier
// doesn't (db/forkState.ts).
//
// What a fork changes is written as a row of its own, never onto a shared slot: a slot's
// `selected_version_id` is the selection it was inserted with (or had at this migration),
// and a trigger refuses any change to it. Only selections are overrides so far; the other
// kinds are for the units after it.

const raise = (message: string) => `SELECT RAISE(ABORT, '${message.replaceAll("'", "''")}')`

export const forkOverrides = [
  `CREATE TABLE fork_overrides (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    fork_id TEXT NOT NULL REFERENCES forks(id) ON DELETE CASCADE,
    -- The chat's state_seq when written; a row updated in place takes the newer one.
    seq INTEGER NOT NULL CHECK (seq > 0),
    kind TEXT NOT NULL CHECK (kind IN ('select', 'replace', 'delete_slot', 'delete_version', 'hide', 'star',
      'picker_hide', 'summary_revision', 'summary_choice', 'suppress_event')),
    target_id TEXT NOT NULL,
    -- The slot the row is about, and its depth, for reading a window of a path.
    slot_id TEXT,
    slot_depth INTEGER,
    value_id TEXT,
    flag INTEGER CHECK (flag IS NULL OR flag IN (0, 1)),
    bin_item_id TEXT REFERENCES bin_items(id) ON DELETE SET NULL,
    changeset_id TEXT REFERENCES changesets(id) ON DELETE SET NULL,
    summaries_done INTEGER NOT NULL DEFAULT 0 CHECK (summaries_done IN (0, 1)),
    -- Who chose it: the user, or an ST re-import following the file (which the user's choice
    -- then overrules: stImportWrites.ts).
    origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'import'))
  ) STRICT`,
  `CREATE INDEX fork_overrides_chat ON fork_overrides(chat_id)`,
  `CREATE INDEX fork_overrides_point ON fork_overrides(fork_id, kind, target_id, seq)`,
  `CREATE INDEX fork_overrides_window ON fork_overrides(fork_id, slot_depth, seq)`,
  `CREATE INDEX fork_overrides_target ON fork_overrides(target_id, kind)`,
  `CREATE INDEX fork_overrides_bin_item ON fork_overrides(bin_item_id) WHERE bin_item_id IS NOT NULL`,
  `CREATE INDEX fork_overrides_changeset ON fork_overrides(changeset_id) WHERE changeset_id IS NOT NULL`,

  `CREATE TRIGGER fork_overrides_same_chat BEFORE INSERT ON fork_overrides
    WHEN (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
      OR (NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id)
    BEGIN ${raise("an override is in its fork's chat")}; END`,
  // A selection names a version of its slot, and says where the slot is.
  `CREATE TRIGGER fork_overrides_select_own_version BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'select'
    AND (NEW.slot_id IS NOT NEW.target_id OR NEW.slot_depth IS NOT (SELECT depth FROM slots WHERE id = NEW.target_id)
      OR (SELECT slot_id FROM versions WHERE id = NEW.value_id) IS NOT NEW.target_id)
    BEGIN ${raise("a selection names a version of its slot")}; END`,
  `CREATE TRIGGER fork_overrides_select_update_own_version BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind = 'select' AND (SELECT slot_id FROM versions WHERE id = NEW.value_id) IS NOT NEW.target_id
    BEGIN ${raise("a selection names a version of its slot")}; END`,
  // In place, a row only takes a newer value (forkState.ts says when that's allowed).
  `CREATE TRIGGER fork_overrides_identity_fixed BEFORE UPDATE OF id, chat_id, fork_id, kind, target_id, slot_id, slot_depth
    ON fork_overrides BEGIN ${raise("an override keeps its fork, kind and target")}; END`,
  `CREATE TRIGGER fork_overrides_seq_forward BEFORE UPDATE OF seq ON fork_overrides WHEN NEW.seq < OLD.seq
    BEGIN ${raise("an override's seq only moves forward")}; END`,

  // Lineage: computed once when the fork is made, never changed. A chat's first fork has
  // only itself; a fork made from another is inserted with its lineage (forkState.ts).
  `ALTER TABLE forks ADD COLUMN lineage_json TEXT CHECK (lineage_json IS NULL OR json_valid(lineage_json))`,
  // Forks made before this have only themselves: they were made at state 0, and no row has seq 0.
  `UPDATE forks SET lineage_json = json_array(json_array(id, NULL))`,
  `CREATE TRIGGER forks_lineage_given BEFORE INSERT ON forks
    WHEN (NEW.lineage_json IS NULL AND NEW.parent_fork_id IS NOT NULL)
      OR (NEW.lineage_json IS NOT NULL AND NEW.lineage_json ->> '$[0][0]' IS NOT NEW.id)
    BEGIN ${raise("a fork made from another is inserted with its lineage, itself first")}; END`,
  `CREATE TRIGGER forks_lineage_root AFTER INSERT ON forks WHEN NEW.lineage_json IS NULL BEGIN
    UPDATE forks SET lineage_json = json_array(json_array(NEW.id, NULL)) WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER forks_lineage_fixed BEFORE UPDATE OF lineage_json ON forks
    WHEN OLD.lineage_json IS NOT NULL AND NEW.lineage_json IS NOT OLD.lineage_json
    BEGIN ${raise("a fork keeps its lineage")}; END`,

  // The base selection is frozen: a fork's choice is an override (§2.2).
  `CREATE TRIGGER slots_selection_frozen BEFORE UPDATE OF selected_version_id ON slots
    WHEN NEW.selected_version_id IS NOT OLD.selected_version_id
    BEGIN ${raise("a slot keeps the selection it was inserted with; a fork selects with an override")}; END`,

  // A deleted version that any fork shows shortens that fork's history (historyChanges.ts).
  `DROP TRIGGER history_reduced_version`,
  `CREATE TRIGGER history_reduced_version AFTER UPDATE OF deleted_at ON versions
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    BEGIN
      INSERT INTO history_changes
        SELECT id, chat_id, depth, 1 FROM slots WHERE id = NEW.slot_id AND (selected_version_id = NEW.id
          OR EXISTS (SELECT 1 FROM fork_overrides o WHERE o.target_id = NEW.slot_id AND o.kind = 'select'
            AND o.value_id = NEW.id))
      ON CONFLICT(slot_id) DO UPDATE SET revision = revision + 1;
    END`
]
