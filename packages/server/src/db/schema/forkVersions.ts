// Migration 0055: versions a fork owns, and the flags a fork sets on versions
// (spec/FORK-INDEPENDENCE-DELTA.md §2.2, implementation unit 4).
//
// A swipe belongs to its message: whichever fork makes it, it's in every fork's picker there
// (CHATS.md "Forks", owner 2026-10-26). So a version a fork owns (`versions.fork_id` set) is
// only ever a copy standing in for one of the message's own versions: an amend of a user's
// message that another fork can see writes the copy X′ and a `replace` X → X′ in the amending
// fork. The copy is shown only where a fork's `replace` names it, in its original's place.
// Its `source_version_id` is that original, which is one of the message's own.
//
// Stars and "hidden from the arrows" are per fork too: `star` and `picker_hide` overrides,
// keyed by the message's own version. The versions' columns are frozen from here on, as
// selections are since 0054.

const raise = (message: string) => `SELECT RAISE(ABORT, '${message.replaceAll("'", "''")}')`

export const forkVersions = [
  // No foreign key, as for slots.fork_id: forks only go with their chat.
  `ALTER TABLE versions ADD COLUMN fork_id TEXT`,
  `CREATE INDEX versions_fork ON versions(fork_id) WHERE fork_id IS NOT NULL`,

  `CREATE TRIGGER versions_fork_copy BEFORE INSERT ON versions WHEN NEW.fork_id IS NOT NULL
    AND ((SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT (SELECT chat_id FROM slots WHERE id = NEW.slot_id)
      OR NOT EXISTS (SELECT 1 FROM versions o WHERE o.id = NEW.source_version_id AND o.slot_id = NEW.slot_id
        AND o.fork_id IS NULL))
    BEGIN ${raise("a fork's own version is in its chat and stands in for one of its message's own")}; END`,
  // Its source never changes either (versions_source_fixed), except going with its row.
  `CREATE TRIGGER versions_fork_fixed BEFORE UPDATE OF fork_id ON versions WHEN NEW.fork_id IS NOT OLD.fork_id
    BEGIN ${raise("a version keeps its fork")}; END`,
  `CREATE TRIGGER versions_flags_frozen BEFORE UPDATE OF starred, hidden ON versions
    WHEN NEW.starred IS NOT OLD.starred OR NEW.hidden IS NOT OLD.hidden
    BEGIN ${raise("a version keeps the flags it was inserted with; a fork sets them with an override")}; END`,

  // A replacement names one of a message's own versions and, unless it's undone, a copy
  // standing in for it; it says where the message is.
  `CREATE TRIGGER fork_overrides_replace_own BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'replace'
    AND (NOT EXISTS (SELECT 1 FROM versions o JOIN slots s ON s.id = o.slot_id WHERE o.id = NEW.target_id
        AND o.fork_id IS NULL AND s.id = NEW.slot_id AND s.depth = NEW.slot_depth)
      OR (NEW.value_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM versions c WHERE c.id = NEW.value_id
        AND c.source_version_id = NEW.target_id AND c.fork_id IS NOT NULL)))
    BEGIN ${raise("a replacement stands a copy in for one of its message's own versions")}; END`,
  `CREATE TRIGGER fork_overrides_replace_update_own BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind = 'replace' AND NEW.value_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM versions c
      WHERE c.id = NEW.value_id AND c.source_version_id = NEW.target_id AND c.fork_id IS NOT NULL)
    BEGIN ${raise("a replacement stands a copy in for one of its message's own versions")}; END`,
  // A flag is set or cleared on one of a message's own versions.
  `CREATE TRIGGER fork_overrides_flag_own BEFORE INSERT ON fork_overrides WHEN NEW.kind IN ('star', 'picker_hide')
    AND (NEW.flag IS NULL OR NEW.value_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM versions o JOIN slots s
      ON s.id = o.slot_id WHERE o.id = NEW.target_id AND o.fork_id IS NULL AND s.id = NEW.slot_id
        AND s.depth = NEW.slot_depth))
    BEGIN ${raise("a flag is set on one of its message's own versions")}; END`,
  `CREATE TRIGGER fork_overrides_flag_set BEFORE UPDATE OF flag ON fork_overrides
    WHEN NEW.kind IN ('star', 'picker_hide') AND NEW.flag IS NULL
    BEGIN ${raise("a flag is set on one of its message's own versions")}; END`,
  // A selection names one of its message's own versions; a copy shows through its replacement.
  `CREATE TRIGGER fork_overrides_select_message_own BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'select'
    AND (SELECT fork_id FROM versions WHERE id = NEW.value_id) IS NOT NULL
    BEGIN ${raise("a selection names one of its message's own versions")}; END`,
  `CREATE TRIGGER fork_overrides_select_update_message_own BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind = 'select' AND (SELECT fork_id FROM versions WHERE id = NEW.value_id) IS NOT NULL
    BEGIN ${raise("a selection names one of its message's own versions")}; END`
]
