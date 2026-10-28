// Migration 0053: forks (spec/FORK-INDEPENDENCE-DELTA.md §2.1, §5 steps 2 to 4). A fork is
// what the user sees as one chat line: history from the first message to its tip. It's a
// row, because a leaf can't be its identity: a tip moves on every message, moves up when
// its last message is deleted, and can be a message another fork shares (a fork made at a
// message before anything is sent in it).
//
// `chats.active_leaf_slot_id` stays, as the current fork's tip: triggers keep the two
// equal in both directions, so whatever still reads the chat's leaf reads the current fork.
// Writers move forks' tips.

const raise = (message: string) => `SELECT RAISE(ABORT, '${message.replaceAll("'", "''")}')`

/** The table, its indexes and the new columns elsewhere. Rows are written by the migration. */
export const forkTables = [
  `CREATE TABLE forks (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- The fork it was made from (lineage); null for a chat's first.
    parent_fork_id TEXT REFERENCES forks(id) DEFERRABLE INITIALLY DEFERRED,
    -- The chat's state_seq when it was made.
    branched_at INTEGER NOT NULL DEFAULT 0,
    -- The message it was made at: its history is root to base, then what it appends.
    base_slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    -- Its path ends here; null before the first message.
    tip_slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    name TEXT,
    name_user INTEGER NOT NULL DEFAULT 0 CHECK (name_user IN (0, 1)),
    pinned_at INTEGER,
    created_at INTEGER NOT NULL,
    last_chatted_at INTEGER,
    deleted_at INTEGER,
    bin_item_id TEXT REFERENCES bin_items(id) ON DELETE SET NULL,
    purged_at INTEGER,
    row_version INTEGER NOT NULL DEFAULT 1
  ) STRICT`,
  `CREATE INDEX forks_chat ON forks(chat_id)`,
  `CREATE INDEX forks_parent ON forks(parent_fork_id) WHERE parent_fork_id IS NOT NULL`,
  `CREATE INDEX forks_base ON forks(base_slot_id) WHERE base_slot_id IS NOT NULL`,
  `CREATE INDEX forks_tip ON forks(tip_slot_id) WHERE tip_slot_id IS NOT NULL`,
  `CREATE INDEX forks_bin_item ON forks(bin_item_id) WHERE bin_item_id IS NOT NULL`,

  // The columns added elsewhere name forks without a foreign key, as chains do: forks only
  // go with their chat, and triggers below keep each in its row's chat.
  `ALTER TABLE chats ADD COLUMN current_fork_id TEXT`,
  `ALTER TABLE chats ADD COLUMN state_seq INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX chats_current_fork ON chats(current_fork_id) WHERE current_fork_id IS NOT NULL`,
  // Provenance only: the fork that appended the slot. The path is defined by tips.
  `ALTER TABLE slots ADD COLUMN fork_id TEXT`,
  `CREATE INDEX slots_fork ON slots(fork_id) WHERE fork_id IS NOT NULL`,
  `ALTER TABLE rollouts ADD COLUMN fork_id TEXT`,
  `CREATE INDEX rollouts_fork ON rollouts(fork_id) WHERE fork_id IS NOT NULL`,
  // The fork a queued message posts in.
  `ALTER TABLE queued_messages ADD COLUMN fork_id TEXT`,
  `CREATE INDEX queued_messages_fork ON queued_messages(fork_id) WHERE fork_id IS NOT NULL`
]

/** Created once every chat has its forks. */
export const forkTriggers = [
  // A chat starts with one fork, whose id is the chat's, so no writer can make a chat without.
  `CREATE TRIGGER chats_first_fork AFTER INSERT ON chats BEGIN
    INSERT INTO forks (id, chat_id, tip_slot_id, created_at)
      VALUES (NEW.id, NEW.id, NEW.active_leaf_slot_id, NEW.created_at);
    UPDATE chats SET current_fork_id = NEW.id WHERE id = NEW.id;
  END`,

  // The chat's active leaf is the current fork's tip, whichever of them a statement moves.
  `CREATE TRIGGER forks_tip_mirrored AFTER UPDATE OF tip_slot_id ON forks BEGIN
    UPDATE chats SET active_leaf_slot_id = NEW.tip_slot_id
    WHERE id = NEW.chat_id AND current_fork_id = NEW.id AND active_leaf_slot_id IS NOT NEW.tip_slot_id;
  END`,
  `CREATE TRIGGER chats_current_fork_mirrored AFTER UPDATE OF current_fork_id ON chats BEGIN
    UPDATE chats SET active_leaf_slot_id = (SELECT tip_slot_id FROM forks WHERE id = NEW.current_fork_id)
    WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER chats_active_leaf_mirrored AFTER UPDATE OF active_leaf_slot_id ON chats
    WHEN NEW.current_fork_id IS NOT NULL BEGIN
    UPDATE forks SET tip_slot_id = NEW.active_leaf_slot_id
    WHERE id = NEW.current_fork_id AND tip_slot_id IS NOT NEW.active_leaf_slot_id;
  END`,

  // References stay inside their chat, and a fork never moves to another.
  `CREATE TRIGGER forks_chat_fixed BEFORE UPDATE OF chat_id ON forks
    WHEN NEW.chat_id IS NOT OLD.chat_id
    BEGIN ${raise("forks rows never move to another chat")}; END`,
  ...["INSERT", "UPDATE OF parent_fork_id, base_slot_id, tip_slot_id"].map(
    (event, i) => `CREATE TRIGGER forks_same_chat${i === 0 ? "" : "_update"} BEFORE ${event} ON forks
    WHEN (NEW.parent_fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.parent_fork_id) IS NOT NEW.chat_id)
      OR (NEW.base_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.base_slot_id) IS NOT NEW.chat_id)
      OR (NEW.tip_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.tip_slot_id) IS NOT NEW.chat_id)
    BEGIN ${raise("a fork's parent, base and tip are in its chat")}; END`
  ),
  // The parent, base and moment a fork was made at never change.
  `CREATE TRIGGER forks_origin_fixed BEFORE UPDATE OF parent_fork_id, base_slot_id, branched_at ON forks
    WHEN NEW.parent_fork_id IS NOT OLD.parent_fork_id OR NEW.base_slot_id IS NOT OLD.base_slot_id
      OR NEW.branched_at IS NOT OLD.branched_at
    BEGIN ${raise("a fork keeps the parent, base and moment it was made at")}; END`,
  `CREATE TRIGGER chats_current_fork_own BEFORE UPDATE OF current_fork_id ON chats
    WHEN NEW.current_fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.current_fork_id) IS NOT NEW.id
    BEGIN ${raise("a chat's current fork is one of its forks")}; END`,
  ...["INSERT", "UPDATE OF fork_id"].map(
    (event, i) => `CREATE TRIGGER slots_fork_same_chat${i === 0 ? "" : "_update"} BEFORE ${event} ON slots
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN ${raise("a slot's fork is in its chat")}; END`
  ),
  ...["INSERT", "UPDATE OF fork_id"].map(
    (event, i) => `CREATE TRIGGER rollouts_fork_same_chat${i === 0 ? "" : "_update"} BEFORE ${event} ON rollouts
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN ${raise("a rollout's fork is in its chat")}; END`
  ),
  ...["INSERT", "UPDATE OF fork_id"].map(
    (
      event,
      i
    ) => `CREATE TRIGGER queued_messages_fork_same_chat${i === 0 ? "" : "_update"} BEFORE ${event} ON queued_messages
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN ${raise("a queued message's fork is in its chat")}; END`
  )
]
