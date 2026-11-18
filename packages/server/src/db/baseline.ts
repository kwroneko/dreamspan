import { forkLabelSchema } from "./forkLabels.ts"
import { mcpSchema } from "./mcpSchema.ts"

// The schema, created whole. Nobody has run an earlier version of this software, so there
// is no chain of migrations to replay: while that holds, a schema change edits this file and
// the deploy starts from an empty data directory (ARCHITECTURE.md, Migrations).
//
// Generated from the 56-step chain it replaces (tables, indexes, triggers, views); the
// chain's only rows were its ledger, so there is nothing to seed. Full-text tables create
// their shadow tables themselves.
const raise = (message: string) => `SELECT RAISE(ABORT, '${message.replaceAll("'", "''")}')`

/** An item made by a deletion in a fork names it: `origin_json.forkId`. */
const namesFork = (item: string) =>
  `EXISTS (SELECT 1 FROM bin_items b WHERE b.id = ${item} AND b.origin_json ->> '$.forkId' IS NOT NULL)`

/** Moves chat `chat`'s shell stamp (an SQL expression), so its forks' summaries are stale. */
const bumpChat = (chat: string) => `UPDATE chats SET shell_stamp = shell_stamp + 1 WHERE id = ${chat};`

/** Moves the shell stamp of the owner of entity `entity`, so every summary of theirs is stale. */
const bumpOwnerOf = (entity: string) => `INSERT INTO shell_user_stamps (user_id, stamp)
  SELECT owner_user_id, 1 FROM entities WHERE id = ${entity} ON CONFLICT (user_id) DO UPDATE SET stamp = stamp + 1;`

/** Moves user `user`'s shell stamp (an SQL expression). */
const bumpUser = (user: string) => `INSERT INTO shell_user_stamps (user_id, stamp) VALUES (${user}, 1)
  ON CONFLICT (user_id) DO UPDATE SET stamp = stamp + 1;`

/**
 * The shell's fork summaries (db/forkSummaries.ts) and the triggers that make them stale: every
 * insert, delete and update of what the walk reads moves the chat's stamp, and a purge (what
 * `withoutPurged` drops) the owner's. One indexed update a row, so an import's batch of 100
 * messages costs a few hundred.
 */
const shellSummaries: ReadonlyArray<string> = [
  `CREATE TABLE fork_summaries (
    fork_id TEXT PRIMARY KEY REFERENCES forks(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    -- The computation's format, and the chat's and owner's stamps it was computed at.
    format INTEGER NOT NULL,
    stamp INTEGER NOT NULL,
    user_stamp INTEGER NOT NULL,
    preview TEXT NOT NULL,
    -- A template preview (a greeting): the JSON of who its {{char}} and {{user}} follow, else null.
    preview_macro TEXT CHECK (preview_macro IS NULL OR json_valid(preview_macro)),
    messages INTEGER NOT NULL,
    leaf TEXT,
    end_at INTEGER,
    -- Where it parts from the fork it was made from: its first own message's time (else its
    -- making) and how many messages it shares (forkSummaries.ts); null for a chat's first.
    split_at INTEGER,
    split_after INTEGER,
    -- Entity ids only: names and avatars are read with the summary.
    cast_json TEXT NOT NULL CHECK (json_valid(cast_json)),
    joined_json TEXT NOT NULL CHECK (json_valid(joined_json)),
    departed_json TEXT NOT NULL CHECK (json_valid(departed_json)),
    activity_json TEXT NOT NULL CHECK (json_valid(activity_json)),
    added_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(added_json)),
    -- The threads it's in (spec/THREADS.md §4.3): [split id, ordinal] pairs, innermost first.
    threads_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(threads_json) AND json_type(threads_json) = 'array')
  ) STRICT`,
  `CREATE TABLE shell_user_stamps (user_id TEXT PRIMARY KEY, stamp INTEGER NOT NULL) STRICT`,
  // The chat stamp at which a write last reached the fork's summary (db/summaryValidity.ts):
  // one computed at that stamp or later is valid. No row: none since the chat's first noted write.
  `CREATE TABLE fork_shell_stamps (
    fork_id TEXT PRIMARY KEY REFERENCES forks(id) ON DELETE CASCADE,
    stamp INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`,
  // The chat's stamp after the last write whose reach the writer noted. While it is the chat's
  // stamp, every move of the stamp since a summary was computed reached its fork's stamp above.
  `CREATE TABLE chat_shell_tracked (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    stamp INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE TRIGGER shell_slots_insert AFTER INSERT ON slots BEGIN ${bumpChat("NEW.chat_id")} END`,
  // Not chain_id: the database assigns it once, in the inserting statement.
  `CREATE TRIGGER shell_slots_update AFTER UPDATE OF chat_id, parent_slot_id, depth, selected_version_id, created_at,
    deleted_at, purged_at, inserted ON slots BEGIN ${bumpChat("NEW.chat_id")} END`,
  `CREATE TRIGGER shell_slots_delete AFTER DELETE ON slots BEGIN ${bumpChat("OLD.chat_id")} END`,
  // A message's first version is inserted before its slot, whose insert moves the stamp.
  `CREATE TRIGGER shell_versions_insert AFTER INSERT ON versions
    BEGIN ${bumpChat("(SELECT chat_id FROM slots WHERE id = NEW.slot_id)")} END`,
  `CREATE TRIGGER shell_versions_update AFTER UPDATE OF slot_id, speaker_entity_id, status, origin, source_version_id,
    created_at, deleted_at, purged_at, fork_id ON versions
    WHEN NEW.slot_id IS NOT OLD.slot_id OR NEW.speaker_entity_id IS NOT OLD.speaker_entity_id
      OR (NEW.status = 'failed') IS NOT (OLD.status = 'failed')
      OR NEW.origin IS NOT OLD.origin OR NEW.source_version_id IS NOT OLD.source_version_id
      OR NEW.created_at IS NOT OLD.created_at OR NEW.deleted_at IS NOT OLD.deleted_at
      OR NEW.purged_at IS NOT OLD.purged_at OR NEW.fork_id IS NOT OLD.fork_id
    BEGIN ${bumpChat("(SELECT chat_id FROM slots WHERE id = NEW.slot_id)")} END`,
  `CREATE TRIGGER shell_versions_delete AFTER DELETE ON versions
    BEGIN ${bumpChat("(SELECT chat_id FROM slots WHERE id = OLD.slot_id)")} END`,
  `CREATE TRIGGER shell_version_texts_update AFTER UPDATE OF content, cast_json, presence_json ON version_texts
    WHEN NEW.content IS NOT OLD.content OR NEW.cast_json IS NOT OLD.cast_json OR NEW.presence_json IS NOT OLD.presence_json
    BEGIN ${bumpChat("(SELECT s.chat_id FROM versions v JOIN slots s ON s.id = v.slot_id WHERE v.seq = NEW.version_seq)")} END`,
  // The kinds the walk reads; the others (stars, summaries, hides) leave it alone.
  ...(["insert", "update", "delete"] as const).map((op) => {
    const row = op === "delete" ? "OLD" : "NEW"
    return `CREATE TRIGGER shell_fork_overrides_${op} AFTER ${op.toUpperCase()} ON fork_overrides
    WHEN ${row}.kind IN ('select', 'replace', 'delete_slot', 'insert', 'move', 'suppress_event')
    BEGIN ${bumpChat(`${row}.chat_id`)} END`
  }),
  `CREATE TRIGGER shell_state_events_insert AFTER INSERT ON state_events BEGIN ${bumpChat("NEW.chat_id")} END`,
  `CREATE TRIGGER shell_state_events_update AFTER UPDATE OF chat_id, slot_id, version_id, seq, key, scope, value_json,
    fork_id, fork_seq, superseded_by_changeset ON state_events BEGIN ${bumpChat("NEW.chat_id")} END`,
  `CREATE TRIGGER shell_state_events_delete AFTER DELETE ON state_events BEGIN ${bumpChat("OLD.chat_id")} END`,
  `CREATE TRIGGER shell_forks_insert AFTER INSERT ON forks BEGIN ${bumpChat("NEW.chat_id")} END`,
  `CREATE TRIGGER shell_forks_update AFTER UPDATE OF chat_id, parent_fork_id, tip_slot_id, deleted_at, purged_at
    ON forks BEGIN ${bumpChat("NEW.chat_id")} END`,
  `CREATE TRIGGER shell_forks_delete AFTER DELETE ON forks BEGIN ${bumpChat("OLD.chat_id")} END`,
  `CREATE TRIGGER shell_entities_purge AFTER UPDATE OF purged_at ON entities WHEN NEW.purged_at IS NOT OLD.purged_at
    BEGIN ${bumpUser("NEW.owner_user_id")} END`,
  `CREATE TRIGGER shell_entities_delete AFTER DELETE ON entities BEGIN ${bumpUser("OLD.owner_user_id")} END`,
  `CREATE TRIGGER shell_entity_refs_delete AFTER DELETE ON entity_refs BEGIN ${bumpOwnerOf("OLD.entity_id")} END`,
  `CREATE TRIGGER shell_entity_revisions_delete AFTER DELETE ON entity_revisions BEGIN ${bumpOwnerOf("OLD.entity_id")} END`
]

/** Moves chat `chat`'s LCM stamp (an SQL expression): summary facts planners keep are stale. */
const bumpLcm = (chat: string) => `UPDATE chats SET lcm_stamp = lcm_stamp + 1 WHERE id = ${chat};`
/** SQL: whether slot `slot` is an input of some summary, so its effective version can change one. */
const summaryInput = (slot: string) => `EXISTS (SELECT 1 FROM summary_inputs WHERE slot_id = ${slot})`
/** SQL: the chat of version `version` (an id expression). */
const versionChat = (version: string) =>
  `(SELECT s.chat_id FROM versions v JOIN slots s ON s.id = v.slot_id WHERE v.id = ${version})`
const versionSlot = (version: string) => `(SELECT slot_id FROM versions WHERE id = ${version})`
const ops = ["insert", "update", "delete"] as const
const rowOf = (op: (typeof ops)[number]) => (op === "delete" ? "OLD" : "NEW")

/**
 * The LCM stamp (db/lcmPlanCache.ts): what a reader's kept summary facts are valid for. Every
 * write that can change a sealed summary's header, revision, lineage, validity or freshness in
 * any fork moves its chat's stamp. Appending does not: a new slot or version is no summary's
 * input, so the facts for a path stay those of its extension; a new summary is found by its
 * rowid, not by the stamp. A slot or version that no summary has as an input moves nothing
 * either, so writing, swiping and editing recent messages keep the facts. Kinds of override
 * that never reach a summary (stars, picker hides) are left out; every other kind moves it.
 */
const lcmStamp: ReadonlyArray<string> = [
  // Slot ids, chats and parents never change (slots_shape_fixed, slots_parent_same_chat).
  `CREATE TRIGGER lcm_stamp_slots_update AFTER UPDATE ON slots WHEN ${summaryInput("NEW.id")}
    BEGIN ${bumpLcm("NEW.chat_id")} END`,
  `CREATE TRIGGER lcm_stamp_slots_delete AFTER DELETE ON slots BEGIN ${bumpLcm("OLD.chat_id")} END`,
  `CREATE TRIGGER lcm_stamp_versions_update AFTER UPDATE ON versions
    WHEN ${summaryInput("NEW.slot_id")} OR ${summaryInput("OLD.slot_id")}
    BEGIN ${bumpLcm("(SELECT chat_id FROM slots WHERE id = NEW.slot_id)")} END`,
  `CREATE TRIGGER lcm_stamp_versions_delete AFTER DELETE ON versions WHEN ${summaryInput("OLD.slot_id")}
    BEGIN ${bumpLcm("(SELECT chat_id FROM slots WHERE id = OLD.slot_id)")} END`,
  `CREATE TRIGGER lcm_stamp_version_texts_update AFTER UPDATE ON version_texts
    WHEN ${summaryInput("(SELECT slot_id FROM versions WHERE seq = NEW.version_seq)")}
    BEGIN ${bumpLcm("(SELECT s.chat_id FROM versions v JOIN slots s ON s.id = v.slot_id WHERE v.seq = NEW.version_seq)")} END`,
  ...ops.flatMap((op) => [
    `CREATE TRIGGER lcm_stamp_version_history_${op} AFTER ${op.toUpperCase()} ON version_history
    WHEN ${summaryInput(versionSlot(`${rowOf(op)}.version_id`))}
    BEGIN ${bumpLcm(versionChat(`${rowOf(op)}.version_id`))} END`,
    `CREATE TRIGGER lcm_stamp_version_attachments_${op} AFTER ${op.toUpperCase()} ON version_attachments
    WHEN ${summaryInput(versionSlot(`${rowOf(op)}.version_id`))}
    BEGIN ${bumpLcm(versionChat(`${rowOf(op)}.version_id`))} END`,
    // A message's own choices reach a summary only through its inputs; every other kind may.
    `CREATE TRIGGER lcm_stamp_fork_overrides_${op} AFTER ${op.toUpperCase()} ON fork_overrides
    WHEN ${rowOf(op)}.kind NOT IN ('star', 'picker_hide') AND (
      ${rowOf(op)}.kind NOT IN ('select', 'replace', 'delete_slot', 'delete_version', 'hide')
      OR ${rowOf(op)}.slot_id IS NULL OR ${summaryInput(`${rowOf(op)}.slot_id`)}${
        op === "update"
          ? ` OR OLD.kind IS NOT NEW.kind OR OLD.slot_id IS NOT NEW.slot_id OR ${summaryInput("OLD.slot_id")}`
          : ""
      })
    BEGIN ${bumpLcm(`${rowOf(op)}.chat_id`)} END`,
    `CREATE TRIGGER lcm_stamp_summary_revisions_${op} AFTER ${op.toUpperCase()} ON summary_revisions
    WHEN coalesce((SELECT sealed FROM summaries WHERE id = ${rowOf(op)}.summary_id), 0) = 1
    BEGIN ${bumpLcm(`(SELECT chat_id FROM summaries WHERE id = ${rowOf(op)}.summary_id)`)} END`,
    `CREATE TRIGGER lcm_stamp_summary_inputs_${op} AFTER ${op.toUpperCase()} ON summary_inputs
    WHEN coalesce((SELECT sealed FROM summaries WHERE id = ${rowOf(op)}.summary_id), 0) = 1
    BEGIN ${bumpLcm(`(SELECT chat_id FROM summaries WHERE id = ${rowOf(op)}.summary_id)`)} END`,
    `CREATE TRIGGER lcm_stamp_summary_parents_${op} AFTER ${op.toUpperCase()} ON summary_parents
    WHEN coalesce((SELECT sealed FROM summaries WHERE id = ${rowOf(op)}.summary_id), 0) = 1
    BEGIN ${bumpLcm(`(SELECT chat_id FROM summaries WHERE id = ${rowOf(op)}.summary_id)`)} END`,
    `CREATE TRIGGER lcm_stamp_summary_choices_${op} AFTER ${op.toUpperCase()} ON lcm_summary_choices
    BEGIN ${bumpLcm(`(SELECT chat_id FROM summaries WHERE id = ${rowOf(op)}.summary_id)`)} END`,
    `CREATE TRIGGER lcm_stamp_changesets_${op} AFTER ${op.toUpperCase()} ON changesets
    BEGIN ${bumpLcm(`${rowOf(op)}.chat_id`)} END`,
    `CREATE TRIGGER lcm_stamp_changeset_items_${op} AFTER ${op.toUpperCase()} ON changeset_items
    BEGIN ${bumpLcm(`(SELECT chat_id FROM changesets WHERE id = ${rowOf(op)}.changeset_id)`)} END`,
    `CREATE TRIGGER lcm_stamp_chat_merges_${op} AFTER ${op.toUpperCase()} ON chat_merges
    BEGIN ${bumpLcm(`${rowOf(op)}.chat_id`)} END`,
    // A published range's hide reaches the slots it holds (effectiveOverrideSql "hide").
    `CREATE TRIGGER lcm_stamp_lcm_enable_slots_${op} AFTER ${op.toUpperCase()} ON lcm_enable_slots
    BEGIN ${bumpLcm(`(SELECT chat_id FROM lcm_enable_runs WHERE id = ${rowOf(op)}.run_id)`)} END`
  ]),
  // Sealed changes are fenced here. Ordinary completions insert and seal atomically and
  // are found by rowid; staged adoption fences its late seal through publication below.
  `CREATE TRIGGER lcm_stamp_summaries_update AFTER UPDATE ON summaries WHEN OLD.sealed = 1
    BEGIN ${bumpLcm("NEW.chat_id")} ${bumpLcm("OLD.chat_id")} END`,
  `CREATE TRIGGER lcm_stamp_summaries_delete AFTER DELETE ON summaries BEGIN ${bumpLcm("OLD.chat_id")} END`,
  // A completed explicit rerun replaces its source (summaryRows "replacement").
  `CREATE TRIGGER lcm_stamp_jobs_insert AFTER INSERT ON summarization_jobs
    WHEN NEW.source_summary_id IS NOT NULL AND NEW.explicit_requested = 1 AND NEW.status = 'complete'
    BEGIN ${bumpLcm("NEW.chat_id")} END`,
  `CREATE TRIGGER lcm_stamp_jobs_update AFTER UPDATE ON summarization_jobs
    WHEN (NEW.source_summary_id IS NOT NULL OR OLD.source_summary_id IS NOT NULL)
      AND (NEW.explicit_requested = 1 OR OLD.explicit_requested = 1)
      AND (NEW.status = 'complete' OR OLD.status = 'complete')
    BEGIN ${bumpLcm("NEW.chat_id")} ${bumpLcm("OLD.chat_id")} END`,
  `CREATE TRIGGER lcm_stamp_jobs_delete AFTER DELETE ON summarization_jobs
    WHEN OLD.source_summary_id IS NOT NULL AND OLD.explicit_requested = 1 AND OLD.status = 'complete'
    BEGIN ${bumpLcm("OLD.chat_id")} END`,
  ...ops.map(
    (op) => `CREATE TRIGGER lcm_stamp_lcm_enable_runs_${op} AFTER ${op.toUpperCase()} ON lcm_enable_runs
    ${op === "update" ? "WHEN NEW.published IS NOT OLD.published OR NEW.published = 1" : `WHEN ${rowOf(op)}.published = 1`}
    BEGIN ${bumpLcm(`${rowOf(op)}.chat_id`)} END`
  ),
  `CREATE TRIGGER lcm_stamp_forks_update AFTER UPDATE OF chat_id, parent_fork_id, branched_at, deleted_at, purged_at
    ON forks BEGIN ${bumpLcm("NEW.chat_id")} ${bumpLcm("OLD.chat_id")} END`,
  `CREATE TRIGGER lcm_stamp_forks_delete AFTER DELETE ON forks BEGIN ${bumpLcm("OLD.chat_id")} END`,
  // Labels are dropped only with their fork or by rebuildForkLabels, which rewrites every step.
  `CREATE TRIGGER lcm_stamp_fork_labels_delete AFTER DELETE ON fork_labels BEGIN ${bumpLcm("OLD.chat_id")} END`,
  `CREATE TRIGGER lcm_stamp_chats_update AFTER UPDATE OF owner_user_id, deleted_at ON chats
    BEGIN ${bumpLcm("NEW.id")} END`
]

/** The names of the LCM stamp's triggers: a reader keeps no facts on a database missing any. */
export const lcmStampTriggers: ReadonlyArray<string> = lcmStamp.map((s) => /CREATE TRIGGER (\w+)/.exec(s)![1]!)

/**
 * Parallel threads in one chat (spec/THREADS.md §4): a thread is a fork; these say which forks
 * run alongside each other from a message S. A split is frozen (its label only moves under a
 * paused rebuild of the chat's labels, db/forkLabels.ts); a member changes only its name and
 * extras. Which thread a fork is in is derived (§4.3, db/threads.ts), never stored per message.
 */
const threadSchema: ReadonlyArray<string> = [
  `CREATE TABLE thread_splits (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- S: the message the threads continue from.
    slot_id TEXT NOT NULL REFERENCES slots(id),
    -- F: the branch it was started in, which continues as its first thread.
    fork_id TEXT NOT NULL REFERENCES forks(id),
    -- F's point when it was made (before its new threads' forks): visible where label <= point < F's end.
    fork_label BLOB NOT NULL,
    -- The chat's state_seq when it was made, from which a rebuild recomputes the label.
    seq INTEGER NOT NULL CHECK (seq > 0),
    -- Who started it: a registered storage kind (user, rollout, import).
    origin TEXT NOT NULL DEFAULT 'user',
    origin_ref TEXT,
    -- Reserved: a reply that started it.
    version_id TEXT REFERENCES versions(id) ON DELETE CASCADE,
    -- Its Undo, while that's in the bin.
    bin_item_id TEXT REFERENCES bin_items(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX thread_splits_chat ON thread_splits(chat_id)`,
  `CREATE INDEX thread_splits_slot ON thread_splits(slot_id)`,
  `CREATE INDEX thread_splits_fork ON thread_splits(fork_id)`,
  `CREATE INDEX thread_splits_version ON thread_splits(version_id) WHERE version_id IS NOT NULL`,
  `CREATE INDEX thread_splits_bin_item ON thread_splits(bin_item_id) WHERE bin_item_id IS NOT NULL`,
  `CREATE TRIGGER thread_splits_same_chat BEFORE INSERT ON thread_splits
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id
      OR (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
      OR (NEW.version_id IS NOT NULL AND (SELECT s.chat_id FROM versions v JOIN slots s ON s.id = v.slot_id
        WHERE v.id = NEW.version_id) IS NOT NEW.chat_id)
    BEGIN ${raise("a thread split's message, branch and reply are in its chat")}; END`,
  `CREATE TRIGGER thread_splits_frozen BEFORE UPDATE OF id, chat_id, slot_id, fork_id, seq, origin, origin_ref,
    version_id, created_at ON thread_splits
    BEGIN ${raise("a thread split never changes")}; END`,
  `CREATE TRIGGER thread_splits_label_fixed BEFORE UPDATE OF fork_label ON thread_splits
    WHEN NEW.fork_label IS NOT OLD.fork_label AND NOT EXISTS (SELECT 1 FROM fork_label_pause)
    BEGIN ${raise("a thread split keeps its label")}; END`,
  `CREATE TABLE thread_members (
    split_id TEXT NOT NULL REFERENCES thread_splits(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    -- The fork that starts this thread; its later branches are in the thread too.
    fork_id TEXT NOT NULL REFERENCES forks(id),
    -- 1: made by this split at S from F; 0: F continuing.
    starts INTEGER NOT NULL CHECK (starts IN (0, 1)),
    name TEXT,
    name_user INTEGER NOT NULL DEFAULT 0 CHECK (name_user IN (0, 1)),
    -- Display extras later (a colour).
    meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json) AND json_type(meta_json) = 'object'),
    row_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (split_id, ordinal)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX thread_members_fork ON thread_members(fork_id)`,
  // A fork starts at most one thread; a split has at most one continuing member.
  `CREATE UNIQUE INDEX thread_members_starts ON thread_members(fork_id) WHERE starts = 1`,
  `CREATE UNIQUE INDEX thread_members_continuing ON thread_members(split_id) WHERE starts = 0`,
  `CREATE TRIGGER thread_members_fork BEFORE INSERT ON thread_members
    WHEN (SELECT f.chat_id FROM forks f WHERE f.id = NEW.fork_id)
        IS NOT (SELECT x.chat_id FROM thread_splits x WHERE x.id = NEW.split_id)
      OR (NEW.starts = 0 AND NEW.fork_id IS NOT (SELECT x.fork_id FROM thread_splits x WHERE x.id = NEW.split_id))
      OR (NEW.starts = 1 AND NOT EXISTS (SELECT 1 FROM forks f JOIN thread_splits x ON x.id = NEW.split_id
        WHERE f.id = NEW.fork_id AND f.parent_fork_id = x.fork_id AND f.base_slot_id = x.slot_id))
    BEGIN ${raise("a thread is its split's branch continuing, or a branch made from it at the split's message")}; END`,
  `CREATE TRIGGER thread_members_fixed BEFORE UPDATE OF split_id, ordinal, fork_id, starts ON thread_members
    BEGIN ${raise("a thread keeps its split, place and branch")}; END`,
  `CREATE TABLE thread_sends (
    slot_id TEXT PRIMARY KEY REFERENCES slots(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX thread_sends_group ON thread_sends(group_id)`,
  `CREATE INDEX thread_sends_chat ON thread_sends(chat_id)`,
  `CREATE TRIGGER thread_sends_same_chat BEFORE INSERT ON thread_sends
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id
      OR EXISTS (SELECT 1 FROM thread_sends t WHERE t.group_id = NEW.group_id AND t.chat_id IS NOT NEW.chat_id)
    BEGIN ${raise("a send group's messages are in one chat")}; END`,
  `CREATE TRIGGER thread_sends_frozen BEFORE UPDATE ON thread_sends
    BEGIN ${raise("a send group never changes")}; END`,
  // The per-branch correction of who was present (§3.4, §16.2 [D] 2026-11-12): a fork counts a
  // character away for one message of its path. Its key is "<slot id>:<card id>".
  `CREATE INDEX fork_overrides_presence ON fork_overrides(slot_id, target_id) WHERE kind = 'presence_away'`,
  `CREATE TRIGGER fork_overrides_presence_away BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'presence_away'
    AND (NEW.flag IS NULL OR NEW.slot_id IS NULL OR NEW.slot_depth IS NOT (SELECT depth FROM slots WHERE id = NEW.slot_id)
      OR NEW.value_id IS NULL OR NOT json_valid(NEW.value_id) OR json_type(NEW.value_id) <> 'object'
      OR length(NEW.target_id) <= length(NEW.slot_id) + 1
      OR substr(NEW.target_id, 1, length(NEW.slot_id) + 1) IS NOT NEW.slot_id || ':')
    BEGIN ${raise("a presence correction names a message of its chat and a card")}; END`,
  `CREATE TRIGGER fork_overrides_presence_away_update BEFORE UPDATE OF flag, value_id ON fork_overrides
    WHEN NEW.kind = 'presence_away' AND (NEW.flag IS NULL OR NEW.value_id IS NULL
      OR NOT json_valid(NEW.value_id) OR json_type(NEW.value_id) <> 'object')
    BEGIN ${raise("a presence correction names a message of its chat and a card")}; END`,
  // A compact branch-local correction of recorded presence. Its frozen chain spans and
  // version cutoff describe existing history; flags enable/disable it through fork lineage.
  ...["INSERT", "UPDATE OF value_id, flag"].map(
    (event, i) =>
      `CREATE TRIGGER fork_overrides_presence_range_${i} BEFORE ${event} ON fork_overrides
      WHEN NEW.kind = 'presence_range' AND (
        NEW.flag IS NULL OR NEW.flag NOT IN (0,1) OR NEW.slot_id IS NULL OR NEW.value_id IS NULL
        OR NOT json_valid(NEW.value_id)
        OR json_type(NEW.value_id, '$.away') NOT IN ('true','false')
        OR json_type(NEW.value_id, '$.away') IS NULL
        OR json_type(NEW.value_id, '$.cutoff') IS NOT 'integer' OR NEW.value_id ->> '$.cutoff' < 0
        OR json_type(NEW.value_id, '$.identities') IS NOT 'array' OR json_array_length(NEW.value_id, '$.identities') = 0
        OR json_type(NEW.value_id, '$.spans') IS NOT 'array'
        OR EXISTS (SELECT 1 FROM json_each(NEW.value_id, '$.identities') c WHERE NOT EXISTS (
          SELECT 1 FROM entities e JOIN chats chat ON chat.owner_user_id=e.owner_user_id
          WHERE e.id=c.value AND e.kind='card' AND chat.id=NEW.chat_id))
        OR EXISTS (SELECT 1 FROM json_each(NEW.value_id, '$.spans') span
          WHERE json_type(span.value, '$.lo') IS NOT 'integer' OR json_type(span.value, '$.hi') IS NOT 'integer'
            OR span.value ->> '$.lo' < 0 OR span.value ->> '$.hi' < span.value ->> '$.lo'
            OR NOT EXISTS (SELECT 1 FROM slots s WHERE s.chat_id=NEW.chat_id AND s.chain_id=span.value ->> '$.chain')))
      BEGIN ${raise("a presence range names its chat's cards and chain intervals")}; END`
  ),
  // Starting threads changes what the branch it was started in is (db/forkSummaries.ts).
  `CREATE TRIGGER shell_thread_splits_insert AFTER INSERT ON thread_splits BEGIN ${bumpChat("NEW.chat_id")} END`
]

export const baseline: ReadonlyArray<string> = [
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at INTEGER NOT NULL,
    disabled_at INTEGER
  , password_hash TEXT) STRICT`,
  `CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    field TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    images_json TEXT CHECK (images_json IS NULL OR json_valid(images_json)),
    -- Compressed edit history: survives a refresh and recovers from Ctrl-A plus a stray key.
    base_revision TEXT,
    -- A library field's session a save or checkpoint ended: the revision now holding its text.
    committed_revision TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    cleared_version INTEGER NOT NULL DEFAULT 0,
    deletions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(deletions_json)),
    updated_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'committed', 'discarded')), created_at INTEGER NOT NULL DEFAULT 0, session INTEGER NOT NULL DEFAULT 1, text_version INTEGER NOT NULL DEFAULT 1, speaker_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL, reply_from_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    guidance INTEGER NOT NULL DEFAULT 0 CHECK (guidance IN (0, 1)),
    -- The composer's Next set to No one: a send asks for no reply until another choice (DESIGN §2.3).
    no_replies INTEGER NOT NULL DEFAULT 0 CHECK (no_replies IN (0, 1)),
    UNIQUE (user_id, target_kind, target_id, field)
  ) STRICT`,
  `CREATE TABLE plugin_data (
    plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 64),
    owner_user_id TEXT NOT NULL,
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
    value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(CAST(value_json AS BLOB)) <= 524288),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, owner_user_id, key)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX plugin_data_owner ON plugin_data(owner_user_id)`,
  `CREATE TRIGGER plugin_data_owner_insert BEFORE INSERT ON plugin_data
    WHEN NEW.owner_user_id <> '' AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_user_id)
    BEGIN SELECT RAISE(ABORT, 'plugin data needs an owner'); END`,
  `CREATE TRIGGER plugin_data_identity_fixed BEFORE UPDATE OF plugin_id, owner_user_id, key ON plugin_data
    BEGIN SELECT RAISE(ABORT, 'plugin data never changes identity'); END`,
  `CREATE TRIGGER plugin_data_user_deleted AFTER DELETE ON users
    BEGIN DELETE FROM plugin_data WHERE owner_user_id = OLD.id; END`,
  `CREATE TABLE settings (
    scope TEXT NOT NULL CHECK (scope IN ('app', 'user', 'device')),
    scope_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id, key),
    CHECK (scope <> 'app' OR scope_id = '')
  ) STRICT, WITHOUT ROWID`,
  `CREATE TRIGGER settings_identity_fixed BEFORE UPDATE OF scope, scope_id, key ON settings
    WHEN NEW.scope IS NOT OLD.scope OR NEW.scope_id IS NOT OLD.scope_id OR NEW.key IS NOT OLD.key
    BEGIN SELECT RAISE(ABORT, 'settings never change identity'); END`,
  `CREATE TRIGGER settings_owner_insert BEFORE INSERT ON settings
    WHEN (NEW.scope = 'user' AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.scope_id))
      OR (NEW.scope = 'device' AND (NOT json_valid(NEW.scope_id)
        OR NOT EXISTS (SELECT 1 FROM users WHERE id = json_extract(NEW.scope_id, '$[0]'))))
    BEGIN SELECT RAISE(ABORT, 'settings need an owner'); END`,
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
  // Saved card media (spec/SAVED-MEDIA.md). Each account's remote media addresses, one row per
  // address whichever entries name it, and its saved file once downloaded. `once`: approved for
  // these files only, not by the account's list of sites.
  `CREATE TABLE saved_media (
    id INTEGER PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    url TEXT NOT NULL CHECK (length(url) <= 8192),
    host TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'font')),
    state TEXT NOT NULL CHECK (state IN ('approval', 'pending', 'saved', 'failed', 'declined')),
    media_id TEXT REFERENCES media_assets(id),
    reason TEXT,
    once INTEGER NOT NULL DEFAULT 0 CHECK (once IN (0, 1)),
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_user_id, url),
    CHECK ((state = 'saved') = (media_id IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX saved_media_state ON saved_media(state, updated_at) WHERE state = 'pending'`,
  `CREATE INDEX saved_media_owner_host ON saved_media(owner_user_id, host, state)`,
  `CREATE INDEX saved_media_media ON saved_media(media_id) WHERE media_id IS NOT NULL`,
  `CREATE TRIGGER saved_media_owner_fixed BEFORE UPDATE OF owner_user_id, url ON saved_media
    WHEN NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.url IS NOT OLD.url
    BEGIN SELECT RAISE(ABORT, 'saved_media never changes owner or address'); END`,
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
  `CREATE INDEX jobs_queue ON jobs(status, request_class, run_after) WHERE status IN ('pending', 'processing')`,
  // ST folder imports as the user sees them (ARCHITECTURE.md §13): one row per run, its
  // progress written at most about once a second, its report when it ends.
  `CREATE TABLE st_import_jobs (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    mode TEXT NOT NULL CHECK (mode IN ('path', 'upload')),
    source TEXT NOT NULL,
    root TEXT,
    prefix TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled', 'interrupted')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL,
    seen_at INTEGER,
    files_total INTEGER NOT NULL DEFAULT 0,
    files_done INTEGER NOT NULL DEFAULT 0,
    bytes_total INTEGER NOT NULL DEFAULT 0,
    bytes_done INTEGER NOT NULL DEFAULT 0,
    current_file TEXT,
    counts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts_json)),
    attention INTEGER NOT NULL DEFAULT 0,
    report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
    not_sent_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(not_sent_json)),
    error TEXT
  ) STRICT`,
  `CREATE INDEX st_import_jobs_owner ON st_import_jobs(owner_user_id, started_at)`,
  `CREATE INDEX st_import_jobs_running ON st_import_jobs(status) WHERE status = 'running'`,
  // A confirmed re-import's parsed batches of the chat file it's reading (ARCHITECTURE.md §13
  // "Re-import preview"), held until the file's last part is in and matches the check: then
  // they go into the chat in one transaction (`StImportCommitChat`), or none of them does.
  // Released on file drop and job end, at the user's next run, and at startup.
  `CREATE TABLE st_import_stage (
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    import_id TEXT NOT NULL,
    path TEXT NOT NULL,
    seq INTEGER NOT NULL,
    batch_json TEXT NOT NULL CHECK (json_valid(batch_json)),
    PRIMARY KEY (import_id, path, seq)
  ) STRICT`,
  `CREATE INDEX st_import_stage_owner ON st_import_stage(owner_user_id)`,
  `CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  , deleted_at INTEGER, bin_item_id TEXT, purged_at INTEGER, forked_from_entity_id TEXT REFERENCES entities(id), forked_from_revision_id TEXT REFERENCES entity_revisions(id) ON DELETE SET NULL, forked_in_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL, forked_at INTEGER) STRICT`,
  `CREATE INDEX entities_owner_kind ON entities(owner_user_id, kind) WHERE archived_at IS NULL`,
  `CREATE TABLE entity_revisions (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    entity_id TEXT NOT NULL REFERENCES entities(id),
    parents TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parents) AND json_type(parents) = 'array'),
    doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
    doc_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    origin TEXT NOT NULL,
    origin_ref TEXT,
    message TEXT,
    -- Plain text extracted from doc_json for full-text search.
    search_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  ) STRICT`,
  // A card revision's summary, what the card lists read (`cardSummary` in cards.ts): written
  // with the revision, in its insert's transaction, so no list parses a document, which can be
  // megabytes with a lorebook. A table of its own, not columns of entity_revisions: a column
  // after doc_json is reached only through its overflow pages, which is the read it saves.
  // `fields` is name, nickname, character_version, avatar_media_id, character_book.name,
  // avatar_crop and extensions.talkativeness as the document has them (a JSON array); `book`
  // whether it embeds a lorebook, `book_entries` how many entries that has.
  `CREATE TABLE card_summaries (
    revision_id TEXT PRIMARY KEY,
    fields TEXT NOT NULL,
    book INTEGER NOT NULL,
    book_entries INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE TRIGGER card_summaries_insert AFTER INSERT ON entity_revisions
    WHEN (SELECT kind FROM entities WHERE id = NEW.entity_id) = 'card'
    BEGIN INSERT INTO card_summaries (revision_id, fields, book, book_entries) VALUES (NEW.id,
      json_extract(NEW.doc_json, '$.name', '$.nickname', '$.character_version', '$.avatar_media_id',
        '$.character_book.name', '$.avatar_crop', '$.extensions.talkativeness'),
      coalesce(json_type(NEW.doc_json, '$.character_book') = 'object', 0),
      CASE WHEN json_type(NEW.doc_json, '$.character_book.entries') = 'array'
        THEN json_array_length(NEW.doc_json, '$.character_book.entries') ELSE 0 END); END`,
  `CREATE TRIGGER card_summaries_delete AFTER DELETE ON entity_revisions
    BEGIN DELETE FROM card_summaries WHERE revision_id = OLD.id; END`,
  // Saved card media (spec/SAVED-MEDIA.md): which addresses each revision names (its map from
  // address to saved file, through saved_media), and the revisions still to be read for them.
  // Every revision insert queues itself, whatever path wrote it (import, edit, fork, merge,
  // restore), unless its document can't name a remote address.
  `CREATE TABLE revision_media (
    revision_id TEXT NOT NULL REFERENCES entity_revisions(id) ON DELETE CASCADE,
    media INTEGER NOT NULL REFERENCES saved_media(id) ON DELETE CASCADE,
    PRIMARY KEY (revision_id, media)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX revision_media_media ON revision_media(media)`,
  `CREATE TABLE saved_media_scans (
    revision_id TEXT PRIMARY KEY REFERENCES entity_revisions(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    queued_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX saved_media_scans_owner ON saved_media_scans(owner_user_id, queued_at)`,
  `CREATE INDEX saved_media_scans_queued ON saved_media_scans(queued_at)`,
  `CREATE TRIGGER saved_media_scans_queue AFTER INSERT ON entity_revisions
    WHEN instr(NEW.doc_json, '//') > 0
    BEGIN INSERT INTO saved_media_scans (revision_id, owner_user_id, queued_at)
      SELECT NEW.id, owner_user_id, NEW.created_at FROM entities WHERE id = NEW.entity_id; END`,
  `CREATE INDEX entity_revisions_entity ON entity_revisions(entity_id, seq)`,
  // Archive eligibility reads these columns without following doc_json's overflow pages.
  `CREATE INDEX entity_revisions_activity ON entity_revisions(entity_id, origin, created_at, parents)`,
  `CREATE INDEX entity_revisions_hash ON entity_revisions(entity_id, doc_hash)`,
  // An entity's one ref: its head, what it last merged (from its own import line or, for a
  // fork, its parent's revisions: so it may name another entity's revision), its label and
  // import source. A fork is an entity of its own (`entities.forked_from_*`, spec/LIBRARY-FORKS.md).
  `CREATE TABLE entity_refs (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL UNIQUE REFERENCES entities(id),
    head_revision_id TEXT NOT NULL REFERENCES entity_revisions(id),
    merge_base_revision_id TEXT REFERENCES entity_revisions(id) ON DELETE SET NULL,
    label TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    source_path TEXT,
    source_hash TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    st_added_basis INTEGER CHECK (st_added_basis BETWEEN 0 AND 3)
  ) STRICT`,
  `CREATE TABLE library_merges (
    revision_id TEXT PRIMARY KEY REFERENCES entity_revisions(id) ON DELETE CASCADE,
    ref_id TEXT NOT NULL REFERENCES entity_refs(id) ON DELETE CASCADE,
    ours_revision_id TEXT NOT NULL REFERENCES entity_revisions(id) ON DELETE CASCADE,
    base_revision_id TEXT REFERENCES entity_revisions(id) ON DELETE SET NULL,
    theirs_revision_id TEXT REFERENCES entity_revisions(id) ON DELETE SET NULL,
    source_ref_id TEXT REFERENCES entity_refs(id) ON DELETE SET NULL,
    selection_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    undone_by_revision_id TEXT REFERENCES entity_revisions(id) ON DELETE SET NULL
  ) STRICT`,
  `CREATE INDEX library_merges_ref ON library_merges(ref_id, created_at)`,
  `CREATE INDEX library_merges_ours ON library_merges(ours_revision_id)`,
  `CREATE INDEX library_merges_base ON library_merges(base_revision_id) WHERE base_revision_id IS NOT NULL`,
  `CREATE INDEX library_merges_theirs ON library_merges(theirs_revision_id)`,
  `CREATE INDEX library_merges_source ON library_merges(source_ref_id) WHERE source_ref_id IS NOT NULL`,
  `CREATE INDEX library_merges_undo ON library_merges(undone_by_revision_id) WHERE undone_by_revision_id IS NOT NULL`,
  `CREATE TABLE entity_tags (
    entity_id TEXT NOT NULL REFERENCES entities(id),
    tag TEXT NOT NULL,
    PRIMARY KEY (entity_id, tag)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX entity_tags_tag ON entity_tags(tag, entity_id)`,
  // A card added from a card source (spec/CARD-SOURCES.md §8): which source card it is, so a
  // results page finds the user's cards among its ids in one indexed lookup and a second add
  // finds the first. `adopted`: added from the source; `recognized`: imported as a file the
  // source's adapter claimed.
  `CREATE TABLE card_origins (
    entity_id TEXT PRIMARY KEY REFERENCES entities(id),
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    source_id TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    remote_version TEXT NOT NULL,
    current_remote_id TEXT,
    remote_locator TEXT,
    seen_version TEXT,
    seen_remote_id TEXT,
    remote_sha256 TEXT NOT NULL,
    -- adopted: added from the source (also a newer version added as a separate card);
    -- recognized: an imported file whose bytes matched the archive's; linked: an imported file
    -- whose source link names the entry, without a byte match (owner, 2026-11-16), whose
    -- version is unknown ('') until one is taken.
    recognized_by TEXT NOT NULL CHECK (recognized_by IN ('adopted', 'recognized', 'linked')),
    -- "Ignore future updates" (owner, 2026-11-16): no badges or notices while it's set.
    ignore_updates INTEGER NOT NULL DEFAULT 0 CHECK (ignore_updates IN (0, 1)),
    created_at INTEGER NOT NULL,
    CHECK (remote_version <> '' OR recognized_by = 'linked')
  ) STRICT`,
  // Several of the user's cards can track one archive entry (a newer version added as a
  // separate card, owner 2026-11-16), so this is a lookup, not a uniqueness rule.
  `CREATE INDEX card_origins_remote ON card_origins(owner_user_id, source_id, remote_id)`,
  `CREATE INDEX card_origins_current ON card_origins(owner_user_id, source_id, current_remote_id)`,
  // The same file imported from disk (§3.7's third check; the join to entities adds the owner).
  `CREATE INDEX entity_refs_source_hash ON entity_refs(source_hash) WHERE source_hash IS NOT NULL`,
  `CREATE TRIGGER entity_refs_head_same_entity
    BEFORE INSERT ON entity_refs
    WHEN (SELECT entity_id FROM entity_revisions WHERE id = NEW.head_revision_id) IS NOT NEW.entity_id
    BEGIN SELECT RAISE(ABORT, 'entity_refs.head_revision_id belongs to another entity'); END`,
  `CREATE TRIGGER entity_refs_head_same_entity_update
    BEFORE UPDATE OF head_revision_id ON entity_refs
    WHEN (SELECT entity_id FROM entity_revisions WHERE id = NEW.head_revision_id) IS NOT NEW.entity_id
    BEGIN SELECT RAISE(ABORT, 'entity_refs.head_revision_id belongs to another entity'); END`,
  `CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'archived')),
    title TEXT NOT NULL DEFAULT '',
    title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
    cover_media_id TEXT REFERENCES media_assets(id),
    active_leaf_slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER,
    added_at INTEGER,
    st_group_id TEXT,
    st_added_basis INTEGER CHECK (st_added_basis BETWEEN 0 AND 3)
  , deleted_at INTEGER, bin_item_id TEXT, current_fork_id TEXT, state_seq INTEGER NOT NULL DEFAULT 0,
    -- Moved by triggers on every write the shell's fork summaries read (fork_summaries).
    shell_stamp INTEGER NOT NULL DEFAULT 0,
    -- Moved by triggers on every write that can change a summary planners have read (lcmStamp below).
    lcm_stamp INTEGER NOT NULL DEFAULT 0) STRICT`,
  `CREATE INDEX chats_st_group ON chats(owner_user_id, st_group_id) WHERE st_group_id IS NOT NULL`,
  `CREATE INDEX chats_recent ON chats(owner_user_id, last_message_at DESC) WHERE status = 'active'`,
  `CREATE TABLE slots (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    parent_slot_id TEXT REFERENCES slots(id),
    depth INTEGER NOT NULL CHECK (depth >= 0),
    selected_version_id TEXT NOT NULL REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,
    context_excluded INTEGER NOT NULL DEFAULT 0 CHECK (context_excluded IN (0, 1)),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_visited_at INTEGER, deleted_at INTEGER, bin_item_id TEXT, purged_at INTEGER, branch_deleted INTEGER NOT NULL DEFAULT 0 CHECK (branch_deleted IN (0, 1)), hidden_by_user INTEGER NOT NULL DEFAULT 0 CHECK (hidden_by_user IN (0, 1)), st_import_row_version INTEGER NOT NULL DEFAULT 1 CHECK (st_import_row_version > 0), chain_id TEXT, fork_id TEXT,
    -- Inserted between messages (spec/MESSAGE-INSERT.md §2.2): placed per fork by an insert override.
    inserted INTEGER NOT NULL DEFAULT 0 CHECK (inserted IN (0, 1)),
    CHECK ((parent_slot_id IS NULL) = (depth = 0))
  ) STRICT`,
  `CREATE INDEX slots_parent ON slots(parent_slot_id)`,
  // Cover the plain shell tree: cold library reads need no scattered slot records.
  `CREATE INDEX slots_chat_depth ON slots(chat_id, depth, id, parent_slot_id, created_at, deleted_at, purged_at, selected_version_id)`,
  // Hot graph/flag reads never visit the payload's overflow pages.
  `CREATE TABLE versions (
    seq INTEGER PRIMARY KEY REFERENCES version_texts(version_seq) DEFERRABLE INITIALLY DEFERRED,
    id TEXT NOT NULL UNIQUE,
    slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('generating', 'complete', 'stopped', 'failed', 'interrupted')),
    speaker_entity_id TEXT REFERENCES entities(id),
    writer TEXT NOT NULL CHECK (writer IN ('human', 'model')),
    content_length INTEGER NOT NULL DEFAULT 0 CHECK (content_length >= 0),
    macro_mode TEXT NOT NULL CHECK (macro_mode IN ('template', 'verbatim')),
    origin TEXT NOT NULL,
    source_version_id TEXT REFERENCES versions(id),
    -- How a reply's speaker was chosen (SpeakerPick): {"by":"auto"} while the decision model
    -- is to choose, then its pick, or {"by":"order"} when Auto's pick stood.
    speaker_pick_json TEXT CHECK (speaker_pick_json IS NULL OR json_valid(speaker_pick_json)),
    rollout_id TEXT REFERENCES rollouts(id) DEFERRABLE INITIALLY DEFERRED,
    connection_id TEXT REFERENCES connections(id),
    model_id TEXT REFERENCES models(id),
    starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    changeset_id TEXT REFERENCES changesets(id) DEFERRABLE INITIALLY DEFERRED,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    bin_item_id TEXT,
    purged_at INTEGER,
    mark TEXT,
    fork_id TEXT,
    -- Creation provenance, distinct from the fork owning a replacement copy. Fork deletion
    -- retains tombstones; chat deletion removes both versions and forks in one transaction.
    authoring_fork_id TEXT NOT NULL REFERENCES forks(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE version_texts (
    version_seq INTEGER PRIMARY KEY REFERENCES versions(seq) ON DELETE CASCADE,
    cast_json TEXT CHECK (cast_json IS NULL OR (json_valid(cast_json) AND json_type(cast_json) = 'array')),
    -- Who of the cast was away and who was a narrator when it was written (@rp/shared/knowledge.ts,
    -- spec/CHARACTER-CONTEXT.md §9.1): {"away": [ids], "narrators": [ids]}; NULL when neither.
    presence_json TEXT CHECK (presence_json IS NULL OR (json_valid(presence_json) AND json_type(presence_json) = 'object')),
    content TEXT NOT NULL DEFAULT '',
    context_form TEXT,
    display_form TEXT,
    reasoning TEXT,
    raw_content TEXT,
    raw_reasoning TEXT,
    raw_sections TEXT CHECK (raw_sections IS NULL OR json_valid(raw_sections)),
    rewrite_json TEXT CHECK (rewrite_json IS NULL OR json_valid(rewrite_json)),
    reply_sections TEXT CHECK (reply_sections IS NULL OR json_valid(reply_sections)),
    frozen_macros TEXT CHECK (frozen_macros IS NULL OR json_valid(frozen_macros)),
    greeting_ref TEXT CHECK (greeting_ref IS NULL OR json_valid(greeting_ref)),
    direction TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
    recorded_model_json TEXT CHECK (recorded_model_json IS NULL OR json_valid(recorded_model_json)),
    recorded_generation_json TEXT CHECK (recorded_generation_json IS NULL OR json_valid(recorded_generation_json))
  ) STRICT`,
  // The deferred reverse FK requires one payload per version at commit, including empty ones.
  // Corrections scan only versions that recorded presence, without fetching their prose.
  `CREATE INDEX version_texts_presence ON version_texts(version_seq, presence_json) WHERE presence_json IS NOT NULL`,
  `CREATE TRIGGER version_texts_identity_fixed BEFORE UPDATE OF version_seq ON version_texts
    WHEN NEW.version_seq IS NOT OLD.version_seq
    BEGIN SELECT RAISE(ABORT, 'a version payload never changes owner'); END`,
  `CREATE TRIGGER version_texts_retained BEFORE DELETE ON version_texts
    WHEN EXISTS (SELECT 1 FROM versions WHERE seq = OLD.version_seq)
    BEGIN SELECT RAISE(ABORT, 'delete the version to delete its payload'); END`,
  // Counts and emptiness checks stay on metadata, using SQLite's character-count semantics.
  // A bulk copy states its length up front; the trigger corrects only a missing or wrong one.
  `CREATE TRIGGER version_texts_length_insert AFTER INSERT ON version_texts
    WHEN (SELECT content_length FROM versions WHERE seq = NEW.version_seq) IS NOT length(NEW.content) BEGIN
    UPDATE versions SET content_length = length(NEW.content) WHERE seq = NEW.version_seq;
  END`,
  `CREATE TRIGGER version_texts_length_update AFTER UPDATE OF content ON version_texts
    WHEN NEW.content IS NOT OLD.content BEGIN
    UPDATE versions SET content_length = length(NEW.content) WHERE seq = NEW.version_seq;
  END`,
  `CREATE TRIGGER versions_length_derived BEFORE UPDATE OF content_length ON versions
    WHEN NEW.content_length IS NOT (SELECT length(content) FROM version_texts WHERE version_seq = NEW.seq)
    BEGIN SELECT RAISE(ABORT, 'a version length comes from its payload'); END`,
  // Text consumers explicitly opt into this flattened view. Metadata consumers use versions.
  // The write triggers keep bulk INSERT/SELECT and copies atomic without a main-thread shim.
  `CREATE VIEW version_records AS SELECT v.*, t.cast_json, t.presence_json, t.content, t.context_form, t.display_form, t.reasoning, t.raw_content, t.raw_reasoning, t.raw_sections, t.rewrite_json, t.reply_sections, t.frozen_macros, t.greeting_ref, t.direction, t.error_json, t.usage_json, t.recorded_model_json, t.recorded_generation_json
    FROM versions v JOIN version_texts t ON t.version_seq = v.seq`,
  `CREATE TRIGGER version_records_insert INSTEAD OF INSERT ON version_records BEGIN
    INSERT INTO versions (seq, id, slot_id, ordinal, status, speaker_entity_id, speaker_pick_json, writer, macro_mode, origin, source_version_id, rollout_id, connection_id, model_id, starred, hidden, changeset_id, created_at, updated_at, deleted_at, bin_item_id, purged_at, mark, fork_id, authoring_fork_id) VALUES (
      NEW.seq, NEW.id, NEW.slot_id, NEW.ordinal, NEW.status, NEW.speaker_entity_id, NEW.speaker_pick_json, NEW.writer, NEW.macro_mode, NEW.origin, NEW.source_version_id, NEW.rollout_id, NEW.connection_id, NEW.model_id, coalesce(NEW.starred, 0), coalesce(NEW.hidden, 0), NEW.changeset_id, NEW.created_at, NEW.updated_at, NEW.deleted_at, NEW.bin_item_id, NEW.purged_at, NEW.mark, NEW.fork_id, NEW.authoring_fork_id);
    INSERT INTO version_texts(version_seq, cast_json, presence_json, content, context_form, display_form, reasoning, raw_content, raw_reasoning, raw_sections, rewrite_json, reply_sections, frozen_macros, greeting_ref, direction, error_json, usage_json, recorded_model_json, recorded_generation_json) VALUES (
      (SELECT seq FROM versions WHERE id = NEW.id), NEW.cast_json, NEW.presence_json, coalesce(NEW.content, ''), NEW.context_form, NEW.display_form, NEW.reasoning, NEW.raw_content, NEW.raw_reasoning, NEW.raw_sections, NEW.rewrite_json, NEW.reply_sections, NEW.frozen_macros, NEW.greeting_ref, NEW.direction, NEW.error_json, NEW.usage_json, NEW.recorded_model_json, NEW.recorded_generation_json);
  END`,
  `CREATE TRIGGER version_records_update INSTEAD OF UPDATE ON version_records BEGIN
    -- History uses the amendment's timestamp; the purge guard needs its bin authorization.
    UPDATE versions SET updated_at = NEW.updated_at, purged_at = NEW.purged_at, bin_item_id = NEW.bin_item_id WHERE seq = OLD.seq
      AND (updated_at IS NOT NEW.updated_at OR purged_at IS NOT NEW.purged_at OR bin_item_id IS NOT NEW.bin_item_id);
    UPDATE version_texts SET cast_json = NEW.cast_json, presence_json = NEW.presence_json, content = NEW.content, context_form = NEW.context_form, display_form = NEW.display_form, reasoning = NEW.reasoning, raw_content = NEW.raw_content, raw_reasoning = NEW.raw_reasoning, raw_sections = NEW.raw_sections, rewrite_json = NEW.rewrite_json, reply_sections = NEW.reply_sections, frozen_macros = NEW.frozen_macros, greeting_ref = NEW.greeting_ref, direction = NEW.direction, error_json = NEW.error_json, usage_json = NEW.usage_json, recorded_model_json = NEW.recorded_model_json, recorded_generation_json = NEW.recorded_generation_json
      WHERE version_seq = OLD.seq AND (cast_json IS NOT NEW.cast_json OR presence_json IS NOT NEW.presence_json OR content IS NOT NEW.content OR context_form IS NOT NEW.context_form OR display_form IS NOT NEW.display_form OR reasoning IS NOT NEW.reasoning OR raw_content IS NOT NEW.raw_content OR raw_reasoning IS NOT NEW.raw_reasoning OR raw_sections IS NOT NEW.raw_sections OR rewrite_json IS NOT NEW.rewrite_json OR reply_sections IS NOT NEW.reply_sections OR frozen_macros IS NOT NEW.frozen_macros OR greeting_ref IS NOT NEW.greeting_ref OR direction IS NOT NEW.direction OR error_json IS NOT NEW.error_json OR usage_json IS NOT NEW.usage_json OR recorded_model_json IS NOT NEW.recorded_model_json OR recorded_generation_json IS NOT NEW.recorded_generation_json);
    -- Finalize only after saving text, while the old generating status still permits writes.
    UPDATE versions SET seq = NEW.seq, id = NEW.id, slot_id = NEW.slot_id, ordinal = NEW.ordinal, status = NEW.status, speaker_entity_id = NEW.speaker_entity_id, speaker_pick_json = NEW.speaker_pick_json, writer = NEW.writer, macro_mode = NEW.macro_mode, origin = NEW.origin, source_version_id = NEW.source_version_id, rollout_id = NEW.rollout_id, connection_id = NEW.connection_id, model_id = NEW.model_id, starred = NEW.starred, hidden = NEW.hidden, changeset_id = NEW.changeset_id, created_at = NEW.created_at, deleted_at = NEW.deleted_at, bin_item_id = NEW.bin_item_id, mark = NEW.mark, fork_id = NEW.fork_id, authoring_fork_id = NEW.authoring_fork_id
      WHERE seq = OLD.seq AND (seq IS NOT NEW.seq OR id IS NOT NEW.id OR slot_id IS NOT NEW.slot_id OR ordinal IS NOT NEW.ordinal OR status IS NOT NEW.status OR speaker_entity_id IS NOT NEW.speaker_entity_id OR speaker_pick_json IS NOT NEW.speaker_pick_json OR writer IS NOT NEW.writer OR macro_mode IS NOT NEW.macro_mode OR origin IS NOT NEW.origin OR source_version_id IS NOT NEW.source_version_id OR rollout_id IS NOT NEW.rollout_id OR connection_id IS NOT NEW.connection_id OR model_id IS NOT NEW.model_id OR starred IS NOT NEW.starred OR hidden IS NOT NEW.hidden OR changeset_id IS NOT NEW.changeset_id OR created_at IS NOT NEW.created_at OR deleted_at IS NOT NEW.deleted_at OR bin_item_id IS NOT NEW.bin_item_id OR mark IS NOT NEW.mark OR fork_id IS NOT NEW.fork_id OR authoring_fork_id IS NOT NEW.authoring_fork_id);
  END`,
  `CREATE TRIGGER version_texts_failed_error_insert BEFORE INSERT ON version_texts
    WHEN NEW.error_json IS NULL AND EXISTS (
      SELECT 1 FROM versions WHERE seq = NEW.version_seq AND status = 'failed' AND purged_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'failed versions require an error payload'); END`,
  `CREATE TRIGGER versions_failed_error_update BEFORE UPDATE OF status ON versions
    WHEN NEW.status = 'failed' AND NEW.purged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM version_texts WHERE version_seq = NEW.seq AND error_json IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'failed versions require an error payload'); END`,
  `CREATE TRIGGER version_texts_failed_error BEFORE UPDATE OF error_json ON version_texts
    WHEN NEW.error_json IS NULL AND EXISTS (
      SELECT 1 FROM versions WHERE seq = OLD.version_seq AND status = 'failed' AND purged_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'failed versions require an error payload'); END`,
  `CREATE INDEX versions_authoring_fork ON versions(authoring_fork_id)`,
  `CREATE TRIGGER versions_authoring_fork_fixed BEFORE UPDATE OF authoring_fork_id ON versions
    WHEN NEW.authoring_fork_id IS NOT OLD.authoring_fork_id
    BEGIN SELECT RAISE(ABORT, 'a version keeps its authoring fork'); END`,
  `CREATE TRIGGER versions_authoring_fork_chat BEFORE INSERT ON versions
    WHEN EXISTS (SELECT 1 FROM slots s JOIN forks f ON f.id = NEW.authoring_fork_id
      WHERE s.id = NEW.slot_id AND s.chat_id <> f.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a version was written in a fork of its chat'); END`,
  `CREATE TRIGGER versions_authoring_fork_chat_update BEFORE UPDATE OF slot_id ON versions
    WHEN EXISTS (SELECT 1 FROM slots s JOIN forks f ON f.id = NEW.authoring_fork_id
      WHERE s.id = NEW.slot_id AND s.chat_id <> f.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a version was written in a fork of its chat'); END`,
  `CREATE TRIGGER slots_version_authoring_fork_chat AFTER INSERT ON slots
    WHEN EXISTS (SELECT 1 FROM versions v JOIN forks f ON f.id = v.authoring_fork_id
      WHERE v.slot_id = NEW.id AND f.chat_id <> NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a version was written in a fork of its chat'); END`,
  `CREATE INDEX versions_rollout ON versions(rollout_id) WHERE rollout_id IS NOT NULL`,
  // Startup's InterruptGenerations finds the few generating versions without scanning every
  // message: 8.5 s at 500,000 messages before (fux1).
  `CREATE INDEX versions_generating ON versions(id) WHERE status = 'generating'`,
  // Every retained swipe by slot, with its seq (the rowid every index entry carries):
  // participation reads all of a slot's swipes from these pages and finds their casts by seq
  // (version_participants_seq). It is the slot's only version index, and a narrow one: a bulk
  // rewrite adds one swipe to each of thousands of slots, dirtying about a leaf page per slot of
  // every slot-keyed index, more the wider its entries (a second index for a UNIQUE constraint
  // doubled them, perfshell3; the 36-character id here cost a fifth of the commit's pages,
  // stack4). The trigger below keeps ordinals unique by probing it (versions_identity_fixed
  // keeps slot and ordinal from changing after insert).
  `CREATE INDEX versions_shell ON versions(slot_id, ordinal, purged_at)`,
  // The shown version's shell metadata, by id (the shell joins on slot and id): a new version's
  // id sorts after the old ones, so a bulk rewrite appends to these pages instead of dirtying one
  // per slot.
  `CREATE INDEX versions_shell_meta ON versions(id, slot_id, purged_at, status, speaker_entity_id, origin, created_at, content_length)`,
  `CREATE TRIGGER versions_slot_ordinal_unique BEFORE INSERT ON versions
    WHEN EXISTS (SELECT 1 FROM versions WHERE slot_id = NEW.slot_id AND ordinal = NEW.ordinal)
    BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: versions.slot_id, versions.ordinal'); END`,
  // Human authors are sparse among model swipes; include the predicate columns too
  // so SQLite can answer from the index without opening version records.
  `CREATE INDEX versions_slot_human_authors ON versions(slot_id, writer, speaker_entity_id, origin, created_at, purged_at, ordinal)
    WHERE writer = 'human' AND speaker_entity_id IS NOT NULL AND purged_at IS NULL`,
  // An indexed projection of each version's cast and author; no join event establishes
  // historical participation. Copies carry cast_json with their other version fields.
  // version_seq is the version's seq (set only by these triggers; a version's seq never
  // changes), so a slot's swipes reach their casts from versions_shell without the id.
  `CREATE TABLE version_participants (
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    version_seq INTEGER NOT NULL,
    PRIMARY KEY (entity_id, version_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX version_participants_version ON version_participants(version_id, entity_id)`,
  `CREATE INDEX version_participants_seq ON version_participants(version_seq, entity_id)`,
  `CREATE TRIGGER version_participants_insert AFTER INSERT ON versions BEGIN
    INSERT OR IGNORE INTO version_participants(version_id, entity_id, version_seq)
      SELECT NEW.id, NEW.speaker_entity_id, NEW.seq WHERE NEW.speaker_entity_id IS NOT NULL;
  END`,
  `CREATE TRIGGER version_participants_speaker AFTER UPDATE OF speaker_entity_id ON versions
    WHEN NEW.speaker_entity_id IS NOT OLD.speaker_entity_id BEGIN
    DELETE FROM version_participants WHERE version_id = NEW.id;
    INSERT OR IGNORE INTO version_participants(version_id, entity_id, version_seq)
      SELECT NEW.id, c.value, NEW.seq FROM version_texts t, json_each(t.cast_json) c WHERE t.version_seq = NEW.seq
        AND NOT EXISTS (SELECT 1 FROM json_each(t.presence_json, '$.away') a WHERE a.value = c.value)
      UNION SELECT NEW.id, NEW.speaker_entity_id, NEW.seq WHERE NEW.speaker_entity_id IS NOT NULL;
  END`,
  `CREATE TRIGGER version_participants_cast_insert AFTER INSERT ON version_texts
    BEGIN
    DELETE FROM version_participants WHERE version_id = (SELECT id FROM versions WHERE seq = NEW.version_seq);
    INSERT OR IGNORE INTO version_participants(version_id, entity_id, version_seq)
      SELECT v.id, j.value, v.seq FROM versions v, json_each(NEW.cast_json) j WHERE v.seq = NEW.version_seq
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.presence_json, '$.away') a WHERE a.value = j.value)
      UNION SELECT id, speaker_entity_id, seq FROM versions WHERE seq = NEW.version_seq AND speaker_entity_id IS NOT NULL;
  END`,
  `CREATE TRIGGER version_participants_cast AFTER UPDATE OF cast_json, presence_json ON version_texts
    WHEN NEW.cast_json IS NOT OLD.cast_json OR NEW.presence_json IS NOT OLD.presence_json BEGIN
    DELETE FROM version_participants WHERE version_id = (SELECT id FROM versions WHERE seq = NEW.version_seq);
    INSERT OR IGNORE INTO version_participants(version_id, entity_id, version_seq)
      SELECT v.id, j.value, v.seq FROM versions v, json_each(NEW.cast_json) j WHERE v.seq = NEW.version_seq
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.presence_json, '$.away') a WHERE a.value = j.value)
      UNION SELECT id, speaker_entity_id, seq FROM versions WHERE seq = NEW.version_seq AND speaker_entity_id IS NOT NULL;
  END`,
  `CREATE VIEW card_chat_membership AS
    SELECT DISTINCT p.entity_id, s.chat_id FROM version_participants p
      CROSS JOIN versions v ON v.id = p.version_id CROSS JOIN slots s ON s.id = v.slot_id
    WHERE v.purged_at IS NULL AND s.purged_at IS NULL`,
  `CREATE TABLE version_history (
    id INTEGER PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    replaced_at INTEGER NOT NULL,
    -- The version's complete image set before this amendment.
    images_json TEXT CHECK (images_json IS NULL OR json_valid(images_json)),
    -- Its thinking before this amendment, as JSON (a string, or null for none); NULL: not recorded.
    reasoning_json TEXT CHECK (reasoning_json IS NULL OR json_valid(reasoning_json)),
    -- Its reply sections before this amendment (the thinking an edit changes without reasoning); NULL: none.
    sections_json TEXT CHECK (sections_json IS NULL OR json_valid(sections_json))
  ) STRICT`,
  `CREATE INDEX version_history_version ON version_history(version_id, id)`,
  `CREATE TABLE version_attachments (
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    media_id TEXT NOT NULL REFERENCES media_assets(id),
    kind TEXT NOT NULL,
    alt_text TEXT,
    PRIMARY KEY (version_id, ordinal)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE composer_images (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    media_id TEXT REFERENCES media_assets(id),
    alt_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','sent','removed')),
    CHECK (status <> 'active' OR media_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX composer_images_draft ON composer_images(draft_id, status)`,
  `CREATE TABLE state_events (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    slot_id TEXT REFERENCES slots(id) ON DELETE CASCADE,
    version_id TEXT REFERENCES versions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    key TEXT NOT NULL,
    scope TEXT,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    origin TEXT NOT NULL,
    origin_ref TEXT,
    created_at INTEGER NOT NULL,
    superseded_by_changeset TEXT REFERENCES changesets(id), slot_chain_id TEXT, slot_depth INTEGER,
    fork_id TEXT REFERENCES forks(id), fork_seq INTEGER,
    -- Its fork's point when written (db/forkLabels.ts): visible where label <= point < the fork's end.
    fork_label BLOB,
    CHECK ((fork_id IS NULL AND fork_seq IS NULL) OR (fork_id IS NOT NULL AND fork_seq IS NOT NULL AND fork_seq > 0)),
    CHECK (key <> 'card.swap' OR (slot_id IS NULL AND version_id IS NULL AND scope IS NULL AND fork_id IS NOT NULL)),
    CHECK (version_id IS NULL OR slot_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX state_events_position ON state_events(chat_id, slot_id, seq)`,
  `CREATE TABLE rollouts (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
      ('created', 'running', 'completed', 'stopped', 'failed', 'interrupted', 'discarded')),
    slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    leaf_slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    parent_rollout_id TEXT REFERENCES rollouts(id),
    role TEXT NOT NULL,
    connection_id TEXT REFERENCES connections(id),
    model_id TEXT REFERENCES models(id),
    request_class TEXT NOT NULL CHECK (request_class IN ('interactive', 'idle', 'background')),
    -- Provider-reported usage, rolled up. NULL means unknown, not zero (as in reference-harness).
    llm_requests INTEGER,
    usage_input_tokens INTEGER,
    usage_output_tokens INTEGER,
    usage_cache_read_tokens INTEGER,
    usage_cache_write_tokens INTEGER,
    usage_cost REAL,
    cache_observed_json TEXT CHECK (cache_observed_json IS NULL OR json_valid(cache_observed_json)),
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  , context_issues_json TEXT
    CHECK (context_issues_json IS NULL OR json_valid(context_issues_json)), history_start_slot_id TEXT, history_start_depth INTEGER, history_depth INTEGER, fork_id TEXT,
    -- Agent rollouts (spec/AGENTIC.md §9): tool calls so far, and the orchestration mode it ran in.
    step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0), mode TEXT) STRICT`,
  `CREATE INDEX rollouts_chat ON rollouts(chat_id, created_at DESC)`,
  `CREATE INDEX rollouts_slot ON rollouts(slot_id) WHERE slot_id IS NOT NULL`,
  `CREATE INDEX rollouts_live ON rollouts(status, updated_at) WHERE status IN ('created', 'running', 'interrupted')`,
  `CREATE TABLE rollout_payloads (
    rollout_id TEXT PRIMARY KEY REFERENCES rollouts(id) ON DELETE CASCADE,
    context_snapshot_json TEXT CHECK (context_snapshot_json IS NULL OR json_valid(context_snapshot_json)),
    transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json))
  , sent_context_json TEXT
      CHECK (sent_context_json IS NULL OR json_valid(sent_context_json))) STRICT`,
  `CREATE TABLE lore_activations (
    rollout_id TEXT PRIMARY KEY REFERENCES rollouts(id) ON DELETE CASCADE,
    entries_json TEXT NOT NULL CHECK (json_valid(entries_json)),
    message_offset INTEGER NOT NULL DEFAULT 0 CHECK (message_offset IN (0, 1))
  ) STRICT`,
  `CREATE TABLE rollout_receipts (
    rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    is_error INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0, 1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (rollout_id, tool_call_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE rollout_effects (
    rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    kind TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    title TEXT NOT NULL,
    undo_json TEXT CHECK (undo_json IS NULL OR (json_valid(undo_json) AND json_type(undo_json) = 'object')),
    undo_result_json TEXT CHECK (undo_result_json IS NULL OR (json_valid(undo_result_json) AND json_type(undo_result_json) = 'object')),
    undone_at INTEGER CHECK (undone_at IS NULL OR undone_at >= created_at),
    created_at INTEGER NOT NULL,
    CHECK ((undone_at IS NULL) = (undo_result_json IS NULL)),
    PRIMARY KEY (rollout_id, tool_call_id, seq),
    FOREIGN KEY (rollout_id, tool_call_id) REFERENCES rollout_receipts(rollout_id, tool_call_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX rollout_effects_target ON rollout_effects(target_kind, target_id)`,
  `CREATE INDEX rollout_effects_call ON rollout_effects(tool_call_id, rollout_id)`,
  `CREATE TRIGGER rollout_effects_owner BEFORE INSERT ON rollout_effects BEGIN
    SELECT RAISE(ABORT, 'effect target must belong to the workshop owner') WHERE NOT EXISTS (
      SELECT 1 FROM rollouts r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = NEW.rollout_id AND r.kind = 'workshop'
        AND (NEW.target_kind NOT IN ('entity', 'chat')
          OR (NEW.target_kind = 'entity' AND EXISTS (SELECT 1 FROM entities e WHERE e.id = NEW.target_id AND e.owner_user_id = c.owner_user_id))
          OR (NEW.target_kind = 'chat' AND EXISTS (SELECT 1 FROM chats t WHERE t.id = NEW.target_id AND t.owner_user_id = c.owner_user_id)))
    );
    SELECT RAISE(ABORT, 'library effect must target an entity') WHERE NEW.kind IN ('library.create', 'library.revise') AND NEW.target_kind <> 'entity';
    SELECT RAISE(ABORT, 'chat effect must target a chat') WHERE NEW.kind = 'chat.create' AND NEW.target_kind <> 'chat';
    SELECT RAISE(ABORT, 'library recipe must name its target ref and row version') WHERE NEW.kind IN ('library.create', 'library.revise') AND (
      NOT EXISTS (SELECT 1 FROM entity_refs f WHERE f.id = json_extract(NEW.undo_json, '$.refId') AND f.entity_id = NEW.target_id)
      OR json_type(NEW.undo_json, '$.rowVersion') IS NOT 'integer' OR json_extract(NEW.undo_json, '$.rowVersion') < 0
    );
    SELECT RAISE(ABORT, 'revision recipe must retain its previous row version') WHERE NEW.kind = 'library.revise' AND (
      json_type(NEW.undo_json, '$.beforeRowVersion') IS NOT 'integer' OR json_extract(NEW.undo_json, '$.beforeRowVersion') < 0
    );
    SELECT RAISE(ABORT, 'chat creation recipe must retain its state stamp') WHERE NEW.kind = 'chat.create'
      AND json_type(NEW.undo_json, '$.stamp') IS NOT 'text';
    SELECT RAISE(ABORT, 'creation recipe must name target ref and revision') WHERE NEW.kind = 'library.create' AND (
      NOT EXISTS (SELECT 1 FROM entity_refs f WHERE f.id = json_extract(NEW.undo_json, '$.refId') AND f.entity_id = NEW.target_id)
      OR NOT EXISTS (SELECT 1 FROM entity_revisions v WHERE v.id = json_extract(NEW.undo_json, '$.head') AND v.entity_id = NEW.target_id)
    );
    SELECT RAISE(ABORT, 'revision recipe must name target revisions') WHERE NEW.kind = 'library.revise' AND (
      NOT EXISTS (SELECT 1 FROM entity_revisions v WHERE v.id = json_extract(NEW.undo_json, '$.before') AND v.entity_id = NEW.target_id)
      OR NOT EXISTS (SELECT 1 FROM entity_revisions v WHERE v.id = json_extract(NEW.undo_json, '$.head') AND v.entity_id = NEW.target_id)
    );
  END`,
  `CREATE TRIGGER rollout_effects_identity BEFORE UPDATE ON rollout_effects BEGIN
    SELECT RAISE(ABORT, 'effect identity is immutable') WHERE NEW.rollout_id <> OLD.rollout_id OR NEW.tool_call_id <> OLD.tool_call_id
      OR NEW.seq <> OLD.seq OR NEW.kind <> OLD.kind OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id
      OR NEW.title <> OLD.title OR NEW.created_at <> OLD.created_at;
    SELECT RAISE(ABORT, 'effect cannot be undone twice') WHERE OLD.undone_at IS NOT NULL;
    SELECT RAISE(ABORT, 'effect updates must record undo') WHERE NEW.undone_at IS NULL;
    SELECT RAISE(ABORT, 'undo recipe is retained') WHERE NEW.undo_json IS NOT OLD.undo_json;
    SELECT RAISE(ABORT, 'revision undo must name a restored target revision and row version') WHERE NEW.kind = 'library.revise' AND (
      NOT EXISTS (SELECT 1 FROM entity_revisions v WHERE v.id = json_extract(NEW.undo_result_json, '$.restoredHead') AND v.entity_id = NEW.target_id)
      OR json_type(NEW.undo_result_json, '$.restoredRowVersion') IS NOT 'integer' OR json_extract(NEW.undo_result_json, '$.restoredRowVersion') < 0
    );
  END`,
  `CREATE TABLE rollout_branches (
    rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    branch_no INTEGER NOT NULL CHECK (branch_no >= 1),
    parent_branch_no INTEGER NOT NULL DEFAULT 0,
    fork_index INTEGER NOT NULL,
    reason TEXT NOT NULL,
    messages_json TEXT NOT NULL CHECK (json_valid(messages_json)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (rollout_id, branch_no)
  ) STRICT, WITHOUT ROWID`,
  // What the assistant may do in each workshop (spec/WORKSHOP.md §3.4): one row a workshop,
  // capability and target (empty for the whole capability; a plugin id, say, for P3's trust),
  // written only by the owner's own RPC, never by a tool. No row: the registered default.
  `CREATE TABLE workshop_grants (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 200),
    target TEXT NOT NULL DEFAULT '' CHECK (length(target) <= 200),
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('off', 'ask', 'allow')),
    expires_at INTEGER,
    updated_at INTEGER NOT NULL,
    CHECK (expires_at IS NULL OR expires_at > updated_at),
    PRIMARY KEY (chat_id, capability, target)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX workshop_grants_owner ON workshop_grants(owner_user_id)`,
  `CREATE TRIGGER workshop_grants_owner BEFORE INSERT ON workshop_grants BEGIN
    SELECT RAISE(ABORT, 'grant must belong to the workshop owner') WHERE NOT EXISTS (
      SELECT 1 FROM chats c WHERE c.id = NEW.chat_id AND c.owner_user_id = NEW.owner_user_id
    );
  END`,
  `CREATE TRIGGER workshop_grants_identity BEFORE UPDATE ON workshop_grants BEGIN
    SELECT RAISE(ABORT, 'grant identity is immutable') WHERE NEW.chat_id <> OLD.chat_id
      OR NEW.capability <> OLD.capability OR NEW.target <> OLD.target OR NEW.owner_user_id <> OLD.owner_user_id;
  END`,
  // A tool call that asked the user first (§3.4), bound to its rollout, call id and arguments'
  // digest: pending while it waits, then allowed, declined or cancelled (a stop), and used once
  // an allowed call starts. A resume reads it to know whether the call can have run.
  `CREATE TABLE tool_approvals (
    rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    capability TEXT NOT NULL,
    prompt_json TEXT NOT NULL CHECK (json_valid(prompt_json) AND json_type(prompt_json) = 'object'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'cancelled', 'used')),
    answer TEXT CHECK (answer IS NULL OR answer IN ('allow', 'allow_chat', 'deny')),
    note TEXT,
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    CHECK ((answer IS NULL) = (answered_at IS NULL)),
    CHECK (status NOT IN ('allowed', 'denied', 'used') OR answer IS NOT NULL),
    PRIMARY KEY (rollout_id, tool_call_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX tool_approvals_call ON tool_approvals(tool_call_id, rollout_id)`,
  `CREATE TRIGGER tool_approvals_identity BEFORE UPDATE ON tool_approvals BEGIN
    SELECT RAISE(ABORT, 'approval identity is immutable') WHERE NEW.rollout_id <> OLD.rollout_id
      OR NEW.tool_call_id <> OLD.tool_call_id OR NEW.digest <> OLD.digest OR NEW.capability <> OLD.capability
      OR NEW.created_at <> OLD.created_at;
    SELECT RAISE(ABORT, 'an answered approval is final') WHERE OLD.answer IS NOT NULL
      AND (NEW.answer IS NOT OLD.answer OR NEW.answered_at IS NOT OLD.answered_at OR NEW.note IS NOT OLD.note
        OR NOT (NEW.status = OLD.status OR (OLD.status = 'allowed' AND NEW.status = 'used')));
  END`,
  `CREATE TABLE changeset_groups (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
    origin TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE changesets (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    origin TEXT NOT NULL,
    rollout_id TEXT REFERENCES rollouts(id),
    fork_id TEXT NOT NULL REFERENCES forks(id), seq INTEGER NOT NULL,
    group_id TEXT NOT NULL REFERENCES changeset_groups(id),
    status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'reverted', 'partially_reverted')),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX changesets_chat ON changesets(chat_id, created_at DESC)`,
  `CREATE TABLE changeset_items (
    id INTEGER PRIMARY KEY,
    changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
    reverted_at INTEGER
  ) STRICT`,
  `CREATE INDEX changeset_items_changeset ON changeset_items(changeset_id)`,
  `CREATE INDEX changeset_items_before_version ON changeset_items(before_json ->> '$.id') WHERE target_kind='version_replace'`,
  `CREATE INDEX changeset_items_after_version ON changeset_items(after_json ->> '$.id') WHERE target_kind='version_replace'`,
  `CREATE TABLE changeset_reverts (
    changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    fork_id TEXT NOT NULL REFERENCES forks(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES changeset_items(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, PRIMARY KEY (fork_id, item_id)
  ) STRICT`,
  `CREATE INDEX changesets_group ON changesets(group_id)`,
  `CREATE INDEX changesets_fork ON changesets(fork_id)`,
  `CREATE INDEX changeset_reverts_item ON changeset_reverts(item_id)`,
  `CREATE INDEX changeset_reverts_changeset ON changeset_reverts(changeset_id)`,
  `CREATE TRIGGER changeset_text_purged AFTER UPDATE OF purged_at ON versions
    WHEN NEW.purged_at IS NOT NULL AND OLD.purged_at IS NULL BEGIN
      UPDATE changeset_items SET before_json=json_set(before_json, '$.content', '')
        WHERE target_kind='version_replace' AND before_json ->> '$.id'=NEW.id;
      UPDATE changeset_items SET after_json=json_set(after_json, '$.content', '')
        WHERE target_kind='version_replace' AND after_json ->> '$.id'=NEW.id;
    END`,
  `CREATE TRIGGER changeset_state_deleted AFTER DELETE ON state_events BEGIN
      UPDATE changeset_items SET before_json=json_set(before_json, '$.content', '')
        WHERE target_kind='state_event' AND before_json ->> '$.id'=OLD.id;
      UPDATE changeset_items SET after_json=json_set(after_json, '$.content', '')
        WHERE target_kind='state_event' AND after_json ->> '$.id'=OLD.id;
    END`,

  `CREATE TRIGGER changesets_fork_owner BEFORE INSERT ON changesets WHEN NOT EXISTS (
    SELECT 1 FROM forks f JOIN chats c ON c.id = f.chat_id JOIN changeset_groups g ON g.id = NEW.group_id
    WHERE f.id = NEW.fork_id AND c.id = NEW.chat_id AND c.owner_user_id = g.owner_user_id)
    BEGIN SELECT RAISE(ABORT, 'changeset fork and group must belong to its chat owner'); END`,
  `CREATE TRIGGER entity_revisions_immutable BEFORE UPDATE OF seq, id, entity_id, parents, doc_json, doc_hash, schema_version, origin, origin_ref, search_text, created_at ON entity_revisions
    BEGIN SELECT RAISE(ABORT, 'entity revisions are immutable'); END`,
  `CREATE TRIGGER rollout_snapshot_frozen BEFORE UPDATE OF context_snapshot_json ON rollout_payloads
    WHEN OLD.context_snapshot_json IS NOT NULL AND NEW.context_snapshot_json IS NOT OLD.context_snapshot_json
    BEGIN SELECT RAISE(ABORT, 'a rollout context snapshot is frozen once written'); END`,
  `CREATE TRIGGER versions_amend_history AFTER UPDATE OF content ON version_texts
    WHEN NEW.content IS NOT OLD.content AND EXISTS (
      SELECT 1 FROM versions WHERE seq = OLD.version_seq AND writer = 'human' AND status <> 'generating')
    BEGIN
      INSERT INTO version_history(version_id, content, replaced_at, images_json, reasoning_json, sections_json)
      SELECT v.id, OLD.content, v.updated_at, (SELECT json_group_array(json_object(
        'mediaId', media_id, 'altText', coalesce(alt_text, ''))) FROM
        (SELECT media_id, alt_text FROM version_attachments WHERE version_id = v.id ORDER BY ordinal)),
        json_quote(OLD.reasoning), OLD.reply_sections
      FROM versions v WHERE v.seq = OLD.version_seq;
    END`,
  `CREATE TRIGGER versions_identity_fixed BEFORE UPDATE OF seq, id, slot_id, ordinal, writer, origin ON versions
    WHEN NEW.seq IS NOT OLD.seq OR NEW.id IS NOT OLD.id OR NEW.slot_id IS NOT OLD.slot_id OR NEW.ordinal IS NOT OLD.ordinal
      OR NEW.writer IS NOT OLD.writer OR NEW.origin IS NOT OLD.origin
    BEGIN SELECT RAISE(ABORT, 'a version''s identity, slot, writer and origin never change'); END`,
  `CREATE TRIGGER state_events_immutable BEFORE UPDATE OF chat_id, slot_id, version_id, seq, key, scope, value_json, origin, fork_id, fork_seq ON state_events
    BEGIN SELECT RAISE(ABORT, 'state events are immutable; supersede them with a changeset'); END`,
  `CREATE TRIGGER slots_parent_same_chat BEFORE INSERT ON slots
    WHEN NEW.parent_slot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM slots p WHERE p.id = NEW.parent_slot_id AND p.chat_id = NEW.chat_id AND p.depth + 1 = NEW.depth)
    BEGIN SELECT RAISE(ABORT, 'a slot''s parent must be in the same chat, one level up'); END`,
  `CREATE TRIGGER slots_shape_fixed BEFORE UPDATE OF chat_id, parent_slot_id, depth ON slots
    WHEN NEW.chat_id IS NOT OLD.chat_id
      OR NEW.parent_slot_id IS NOT OLD.parent_slot_id OR NEW.depth IS NOT OLD.depth
    BEGIN SELECT RAISE(ABORT, 'the graph is append-only: a slot never moves'); END`,
  `CREATE TRIGGER slots_selection_own_version BEFORE INSERT ON slots
    WHEN (SELECT slot_id FROM versions WHERE id = NEW.selected_version_id) IS NOT NEW.id
    BEGIN SELECT RAISE(ABORT, 'a slot can only select one of its own versions'); END`,
  `CREATE TRIGGER slots_selection_own_version_update BEFORE UPDATE OF selected_version_id ON slots
    WHEN (SELECT slot_id FROM versions WHERE id = NEW.selected_version_id) IS NOT NEW.id
    BEGIN SELECT RAISE(ABORT, 'a slot can only select one of its own versions'); END`,
  `CREATE TRIGGER chats_leaf_own_slot BEFORE UPDATE OF active_leaf_slot_id ON chats
    WHEN NEW.active_leaf_slot_id IS NOT NULL
      AND (SELECT chat_id FROM slots WHERE id = NEW.active_leaf_slot_id) IS NOT NEW.id
    BEGIN SELECT RAISE(ABORT, 'a chat''s active leaf must be one of its slots'); END`,
  `CREATE TRIGGER state_events_position_valid BEFORE INSERT ON state_events
    WHEN (NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id)
      OR (NEW.version_id IS NOT NULL AND (SELECT slot_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.slot_id)
    BEGIN SELECT RAISE(ABORT, 'a state event''s slot must be in its chat, and its version in that slot'); END`,
  `CREATE VIRTUAL TABLE versions_fts USING fts5(
    content, content='version_texts', content_rowid='version_seq',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  )`,
  `CREATE TRIGGER versions_fts_insert AFTER INSERT ON version_texts
    WHEN (SELECT status FROM versions WHERE seq = NEW.version_seq) <> 'generating'
    BEGIN INSERT INTO versions_fts(rowid, content) VALUES (NEW.version_seq, NEW.content); END`,
  `CREATE TRIGGER versions_fts_text AFTER UPDATE OF content ON version_texts
    WHEN NEW.content IS NOT OLD.content AND (SELECT status FROM versions WHERE seq = NEW.version_seq) <> 'generating'
    BEGIN
      INSERT INTO versions_fts(versions_fts, rowid, content) VALUES ('delete', OLD.version_seq, OLD.content);
      INSERT INTO versions_fts(rowid, content) VALUES (NEW.version_seq, NEW.content);
    END`,
  `CREATE TRIGGER versions_fts_status AFTER UPDATE OF status ON versions
    WHEN NEW.status IS NOT OLD.status BEGIN
      INSERT INTO versions_fts(versions_fts, rowid, content)
        SELECT 'delete', OLD.seq, content FROM version_texts WHERE version_seq = OLD.seq AND OLD.status <> 'generating';
      INSERT INTO versions_fts(rowid, content)
        SELECT NEW.seq, content FROM version_texts WHERE version_seq = NEW.seq AND NEW.status <> 'generating';
    END`,
  // Run before the parent disappears: its status determines whether FTS has this row.
  `CREATE TRIGGER versions_fts_delete BEFORE DELETE ON versions WHEN OLD.status <> 'generating'
    BEGIN INSERT INTO versions_fts(versions_fts, rowid, content)
      SELECT 'delete', OLD.seq, content FROM version_texts WHERE version_seq = OLD.seq; END`,
  `CREATE VIRTUAL TABLE entity_revisions_fts USING fts5(
    search_text, content='entity_revisions', content_rowid='seq',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  )`,
  `CREATE TRIGGER entity_revisions_fts_insert AFTER INSERT ON entity_revisions
    BEGIN INSERT INTO entity_revisions_fts (rowid, search_text) VALUES (NEW.seq, NEW.search_text); END`,
  `CREATE INDEX drafts_active ON drafts(user_id, updated_at DESC) WHERE status = 'active'`,
  `CREATE TABLE draft_history (
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('edit', 'restore', 'revision')),
    first_at INTEGER NOT NULL,
    at INTEGER NOT NULL,
    start INTEGER NOT NULL CHECK (start >= 0),
    removed TEXT NOT NULL,
    images_before_json TEXT,
    images_after_json TEXT,
    inserted TEXT NOT NULL, displaced INTEGER NOT NULL DEFAULT 0 CHECK (displaced IN (0, 1)),
    PRIMARY KEY (draft_id, seq)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TRIGGER drafts_gc_chat AFTER DELETE ON chats
    BEGIN DELETE FROM drafts WHERE target_kind IN ('composer', 'queue_edit', 'insert') AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_version AFTER DELETE ON versions
    BEGIN DELETE FROM drafts WHERE target_kind = 'version_edit' AND target_id = OLD.id; END`,
  `CREATE TRIGGER drafts_gc_slot AFTER DELETE ON slots
    BEGIN
      DELETE FROM drafts WHERE target_kind = 'scratchpad' AND target_id = OLD.id;
      DELETE FROM drafts WHERE target_kind = 'composer' AND target_id = OLD.chat_id AND field = OLD.id;
    END`,
  `CREATE TRIGGER drafts_gc_ref AFTER DELETE ON entity_refs
    BEGIN DELETE FROM drafts WHERE target_kind = 'entity_field'
      AND (target_id = OLD.id OR (target_id > OLD.id || '/' AND target_id < OLD.id || '0')); END`,
  `CREATE INDEX slots_bin_item ON slots(bin_item_id) WHERE bin_item_id IS NOT NULL`,
  `CREATE INDEX versions_bin_item ON versions(bin_item_id) WHERE bin_item_id IS NOT NULL`,
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
  `CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    -- The provider chosen for it (providerDefinitions.ts), which sets its defaults, and the
    -- defaults the user changed: only the changes are stored.
    provider TEXT NOT NULL,
    provider_settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_settings_json)),
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
    purged_at INTEGER, credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL, headers_origin TEXT, cache_revision INTEGER NOT NULL DEFAULT 0,
    CHECK ((api_key_enc IS NULL) = (key_hint IS NULL)),
    CHECK ((proxy_mode = 'custom') = (proxy_url_enc IS NOT NULL)),
    CHECK (purged_at IS NULL OR (api_key_enc IS NULL AND headers_enc IS NULL AND proxy_url_enc IS NULL AND base_url IS NULL))
  ) STRICT`,
  `CREATE INDEX connections_owner ON connections(owner_user_id)`,
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
  `CREATE TABLE llm_requests (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    connection_id TEXT NOT NULL REFERENCES connections(id),
    model_id TEXT REFERENCES models(id),
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    rollout_id TEXT REFERENCES rollouts(id) ON DELETE SET NULL,
    version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
    purpose TEXT NOT NULL,
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
    estimated_input INTEGER,
    input_tokenizer TEXT,
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
    -- The rates cost was priced with (per million tokens: input, read, write, writeLong,
    -- output), beside its formula: a later recalculation applies only to rows priced from a
    -- price table or the user's rules, never to a provider-reported charge, which has none.
    cost_rates_json TEXT CHECK (cost_rates_json IS NULL OR (json_valid(cost_rates_json) AND cost IS NOT NULL
      AND cost_formula IS NOT 'reported')),
    -- The network route the request took (direct and why, or the proxy by scheme, host and
    -- port), for the requests that went out.
    route_json TEXT CHECK (route_json IS NULL OR json_valid(route_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)), cache_stagger_json TEXT CHECK (cache_stagger_json IS NULL OR json_valid(cache_stagger_json)), cache_identity_json TEXT CHECK (cache_identity_json IS NULL OR json_valid(cache_identity_json)), backfill_id TEXT REFERENCES jobs(id), reserved_tokens INTEGER, reserved_cost REAL, reserved_currency TEXT,
    CHECK ((status = 'running') = (ended_at IS NULL)),
    CHECK ((cost IS NULL) = (cost_currency IS NULL) AND (cost IS NULL) = (cost_formula IS NULL))
  ) STRICT`,
  `CREATE INDEX llm_requests_text_calibration ON llm_requests(owner_user_id, connection_id, model_key, input_tokenizer, started_at DESC, id DESC) WHERE estimated_input > 0 AND status='complete' AND usage_source='reported' AND input_uncached IS NOT NULL`,
  `CREATE INDEX llm_requests_owner ON llm_requests(owner_user_id, started_at)`,
  // Image token figures (ARCHITECTURE §6): a provider's exact count of one image for one model,
  // by content hash, so an image is counted once; and ledger samples that calibrate models
  // without a published formula.
  `CREATE TABLE image_token_counts (
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL,
    model_key TEXT NOT NULL,
    detail TEXT NOT NULL,
    tokens INTEGER NOT NULL CHECK (tokens >= 0),
    counted_at INTEGER NOT NULL,
    PRIMARY KEY (owner_user_id, sha256, kind, model_key, detail)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE image_token_samples (
    id INTEGER PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    model_key TEXT NOT NULL,
    images INTEGER NOT NULL CHECK (images > 0),
    pixels INTEGER NOT NULL CHECK (pixels >= 0),
    tokens INTEGER NOT NULL CHECK (tokens >= 0),
    -- 'reported': the provider's own image figure; 'derived': reported input less the text estimate.
    source TEXT NOT NULL CHECK (source IN ('reported', 'derived')),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX image_token_samples_model ON image_token_samples(owner_user_id, connection_id, model_key, id)`,
  `CREATE INDEX llm_requests_connection ON llm_requests(connection_id, started_at)`,
  `CREATE INDEX llm_requests_running ON llm_requests(status) WHERE status = 'running'`,
  `CREATE INDEX llm_requests_rollout ON llm_requests(rollout_id) WHERE rollout_id IS NOT NULL`,
  `CREATE TABLE summary_responses (
    request_id TEXT PRIMARY KEY REFERENCES llm_requests(id) ON DELETE CASCADE,
    rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    response TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX summary_responses_rollout ON summary_responses(rollout_id)`,
  `CREATE TRIGGER summary_responses_request_rollout BEFORE INSERT ON summary_responses
    WHEN (SELECT rollout_id FROM llm_requests WHERE id=NEW.request_id) IS NOT NEW.rollout_id
    BEGIN SELECT RAISE(ABORT, 'summary response must belong to its request rollout'); END`,
  `CREATE TRIGGER summary_responses_immutable BEFORE UPDATE ON summary_responses
    BEGIN SELECT RAISE(ABORT, 'summary responses are immutable'); END`,

  `CREATE INDEX llm_requests_version ON llm_requests(version_id) WHERE version_id IS NOT NULL`,
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
  `CREATE TRIGGER llm_requests_attribution_fixed BEFORE UPDATE OF chat_id, rollout_id, version_id ON llm_requests
    WHEN (NEW.chat_id IS NOT NULL AND NEW.chat_id IS NOT OLD.chat_id)
      OR (NEW.rollout_id IS NOT NULL AND NEW.rollout_id IS NOT OLD.rollout_id)
      OR (NEW.version_id IS NOT NULL AND NEW.version_id IS NOT OLD.version_id)
    BEGIN SELECT RAISE(ABORT, 'a request''s attribution can only be cleared, never moved'); END`,
  `CREATE TRIGGER llm_requests_closed_frozen BEFORE UPDATE ON llm_requests
    WHEN OLD.status <> 'running' AND (
      NEW.status IS NOT OLD.status OR NEW.ended_at IS NOT OLD.ended_at OR NEW.first_token_at IS NOT OLD.first_token_at
      OR NEW.response_model IS NOT OLD.response_model OR NEW.upstream IS NOT OLD.upstream
      OR NEW.estimated_input IS NOT OLD.estimated_input OR NEW.input_tokenizer IS NOT OLD.input_tokenizer
      OR NEW.input_uncached IS NOT OLD.input_uncached OR NEW.cache_read IS NOT OLD.cache_read
      OR NEW.cache_write IS NOT OLD.cache_write OR NEW.cache_write_long IS NOT OLD.cache_write_long
      OR NEW.output IS NOT OLD.output OR NEW.reasoning IS NOT OLD.reasoning OR NEW.usage_source IS NOT OLD.usage_source
      OR NEW.raw_usage_json IS NOT OLD.raw_usage_json OR NEW.reported_cost IS NOT OLD.reported_cost
      OR NEW.error_json IS NOT OLD.error_json OR NEW.route_json IS NOT OLD.route_json)
    BEGIN SELECT RAISE(ABORT, 'a closed request is a record; only its cost can be recomputed'); END`,
  // An explicit recompute (spec/PRICES.md) re-prices a closed row that was priced from rates
  // (a price table, an override or a price endpoint): its cost, currency, formula and rates
  // change together, and it stays priced from rates. A provider-reported charge, or a row
  // priced from no rates, is never recomputed.
  `CREATE TRIGGER llm_requests_recompute_priced BEFORE UPDATE OF cost, cost_currency, cost_formula, cost_rates_json
    ON llm_requests
    WHEN OLD.status <> 'running' AND (NEW.cost IS NOT OLD.cost OR NEW.cost_currency IS NOT OLD.cost_currency
      OR NEW.cost_formula IS NOT OLD.cost_formula OR NEW.cost_rates_json IS NOT OLD.cost_rates_json)
      AND (OLD.cost_rates_json IS NULL OR OLD.cost_formula IS 'reported'
        OR NEW.cost_rates_json IS NULL OR NEW.cost_formula IS 'reported')
    BEGIN SELECT RAISE(ABORT, 'only a closed request priced from rates can be recomputed, and from rates'); END`,
  `CREATE TABLE "bin_items" (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    chat_id TEXT,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
    byte_size INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX bin_items_user ON bin_items(user_id, deleted_at)`,
  `CREATE INDEX bin_items_chat ON bin_items(chat_id) WHERE chat_id IS NOT NULL`,
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
  , connection_owned INTEGER NOT NULL DEFAULT 0 CHECK (connection_owned IN (0, 1))) STRICT`,
  `CREATE INDEX credentials_owner ON credentials(owner_user_id)`,
  `CREATE INDEX connections_credential ON connections(credential_id) WHERE credential_id IS NOT NULL`,
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
  `CREATE TRIGGER connections_no_inline_key BEFORE INSERT ON connections
    WHEN NEW.api_key_enc IS NOT NULL OR NEW.key_hint IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'keys are stored as credentials'); END`,
  `CREATE TRIGGER connections_no_inline_key_update BEFORE UPDATE OF api_key_enc, key_hint ON connections
    WHEN NEW.api_key_enc IS NOT NULL OR NEW.key_hint IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'keys are stored as credentials'); END`,
  `CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX sessions_user ON sessions(user_id)`,
  `CREATE INDEX bin_items_target ON bin_items(target_id)`,
  `CREATE INDEX slots_selected_version ON slots(selected_version_id)`,
  `CREATE INDEX versions_source ON versions(source_version_id) WHERE source_version_id IS NOT NULL`,
  `CREATE INDEX state_events_slot ON state_events(slot_id) WHERE slot_id IS NOT NULL`,
  `CREATE INDEX state_events_version ON state_events(version_id) WHERE version_id IS NOT NULL`,
  `CREATE INDEX chats_active_leaf ON chats(active_leaf_slot_id) WHERE active_leaf_slot_id IS NOT NULL`,
  `CREATE INDEX rollouts_leaf_slot ON rollouts(leaf_slot_id) WHERE leaf_slot_id IS NOT NULL`,
  `CREATE INDEX rollouts_parent ON rollouts(parent_rollout_id) WHERE parent_rollout_id IS NOT NULL`,
  `CREATE INDEX changesets_rollout ON changesets(rollout_id) WHERE rollout_id IS NOT NULL`,
  `CREATE INDEX versions_changeset ON versions(changeset_id) WHERE changeset_id IS NOT NULL`,
  `CREATE INDEX state_events_superseded ON state_events(superseded_by_changeset) WHERE superseded_by_changeset IS NOT NULL`,
  `CREATE INDEX entity_refs_head ON entity_refs(head_revision_id)`,
  `CREATE INDEX entity_refs_merge_base ON entity_refs(merge_base_revision_id) WHERE merge_base_revision_id IS NOT NULL`,
  `CREATE INDEX connections_preset_override ON connections(preset_override_ref_id) WHERE preset_override_ref_id IS NOT NULL`,
  `CREATE INDEX drafts_target ON drafts(target_kind, target_id, field)`,
  `CREATE TRIGGER versions_generation_ends_once BEFORE UPDATE OF status ON versions
    WHEN NEW.status = 'generating' AND OLD.status <> 'generating'
    BEGIN SELECT RAISE(ABORT, 'a version never goes back to generating'); END`,
  `CREATE TRIGGER versions_purge_final BEFORE UPDATE OF purged_at ON versions
    WHEN OLD.purged_at IS NOT NULL AND NEW.purged_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'a purged version stays purged'); END`,
  `CREATE TRIGGER slots_purge_final BEFORE UPDATE OF purged_at ON slots
    WHEN OLD.purged_at IS NOT NULL AND NEW.purged_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'a purged slot stays purged'); END`,
  `CREATE TRIGGER versions_source_same_slot BEFORE INSERT ON versions
    WHEN NEW.source_version_id IS NOT NULL
      AND (SELECT slot_id FROM versions WHERE id = NEW.source_version_id) IS NOT NEW.slot_id
    BEGIN SELECT RAISE(ABORT, 'a version''s source must be another version of its slot'); END`,
  `CREATE TRIGGER versions_source_fixed BEFORE UPDATE OF source_version_id ON versions
    WHEN NEW.source_version_id IS NOT NULL AND NEW.source_version_id IS NOT OLD.source_version_id
    BEGIN SELECT RAISE(ABORT, 'a version''s source never changes'); END`,
  `CREATE TRIGGER versions_source_cleared AFTER DELETE ON versions
    BEGIN UPDATE versions SET source_version_id = NULL WHERE source_version_id = OLD.id; END`,
  `CREATE TRIGGER chats_leaf_own_slot_insert BEFORE INSERT ON chats
    WHEN NEW.active_leaf_slot_id IS NOT NULL
      AND (SELECT chat_id FROM slots WHERE id = NEW.active_leaf_slot_id) IS NOT NEW.id
    BEGIN SELECT RAISE(ABORT, 'a chat''s active leaf must be one of its slots'); END`,
  `CREATE TRIGGER rollouts_slot_id_same_chat BEFORE INSERT ON rollouts WHEN NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'rollouts.slot_id must be in the same chat'); END`,
  `CREATE TRIGGER rollouts_slot_id_same_chat_update BEFORE UPDATE OF slot_id, chat_id
      ON rollouts WHEN NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'rollouts.slot_id must be in the same chat'); END`,
  `CREATE TRIGGER rollouts_leaf_slot_id_same_chat BEFORE INSERT ON rollouts WHEN NEW.leaf_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.leaf_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'rollouts.leaf_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER rollouts_leaf_slot_id_same_chat_update BEFORE UPDATE OF leaf_slot_id, chat_id
      ON rollouts WHEN NEW.leaf_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.leaf_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'rollouts.leaf_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER rollouts_parent_rollout_id_same_chat BEFORE INSERT ON rollouts WHEN NEW.parent_rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.parent_rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'rollouts.parent_rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER rollouts_parent_rollout_id_same_chat_update BEFORE UPDATE OF parent_rollout_id, chat_id
      ON rollouts WHEN NEW.parent_rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.parent_rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'rollouts.parent_rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER changesets_rollout_id_same_chat BEFORE INSERT ON changesets WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'changesets.rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER changesets_rollout_id_same_chat_update BEFORE UPDATE OF rollout_id, chat_id
      ON changesets WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'changesets.rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER versions_rollout_id_same_chat BEFORE INSERT ON versions WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT (SELECT chat_id FROM slots WHERE id = NEW.slot_id) BEGIN SELECT RAISE(ABORT, 'versions.rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER versions_rollout_id_same_chat_update BEFORE UPDATE OF rollout_id, slot_id
      ON versions WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT (SELECT chat_id FROM slots WHERE id = NEW.slot_id) BEGIN SELECT RAISE(ABORT, 'versions.rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER versions_changeset_id_same_chat BEFORE INSERT ON versions WHEN NEW.changeset_id IS NOT NULL AND (SELECT chat_id FROM changesets WHERE id = NEW.changeset_id) IS NOT (SELECT chat_id FROM slots WHERE id = NEW.slot_id) BEGIN SELECT RAISE(ABORT, 'versions.changeset_id must be in the same chat'); END`,
  `CREATE TRIGGER versions_changeset_id_same_chat_update BEFORE UPDATE OF changeset_id, slot_id
      ON versions WHEN NEW.changeset_id IS NOT NULL AND (SELECT chat_id FROM changesets WHERE id = NEW.changeset_id) IS NOT (SELECT chat_id FROM slots WHERE id = NEW.slot_id) BEGIN SELECT RAISE(ABORT, 'versions.changeset_id must be in the same chat'); END`,
  `CREATE TRIGGER state_events_superseded_by_changeset_same_chat BEFORE INSERT ON state_events WHEN NEW.superseded_by_changeset IS NOT NULL AND (SELECT chat_id FROM changesets WHERE id = NEW.superseded_by_changeset) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'state_events.superseded_by_changeset must be in the same chat'); END`,
  `CREATE TRIGGER state_events_superseded_by_changeset_same_chat_update BEFORE UPDATE OF superseded_by_changeset, chat_id
      ON state_events WHEN NEW.superseded_by_changeset IS NOT NULL AND (SELECT chat_id FROM changesets WHERE id = NEW.superseded_by_changeset) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'state_events.superseded_by_changeset must be in the same chat'); END`,
  `CREATE TRIGGER rollouts_chat_fixed BEFORE UPDATE OF chat_id ON rollouts
      WHEN NEW.chat_id IS NOT OLD.chat_id
      BEGIN SELECT RAISE(ABORT, 'rollouts rows never move to another chat'); END`,
  `CREATE TRIGGER changesets_chat_fixed BEFORE UPDATE OF chat_id ON changesets
      WHEN NEW.chat_id IS NOT OLD.chat_id
      BEGIN SELECT RAISE(ABORT, 'changesets rows never move to another chat'); END`,
  `CREATE TRIGGER bin_items_chat_fixed BEFORE UPDATE OF chat_id ON bin_items
      WHEN NEW.chat_id IS NOT OLD.chat_id
      BEGIN SELECT RAISE(ABORT, 'bin_items rows never move to another chat'); END`,
  `CREATE TRIGGER chats_owner_fixed BEFORE UPDATE OF owner_user_id ON chats
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN SELECT RAISE(ABORT, 'chats never change owner'); END`,
  `CREATE TRIGGER entities_owner_fixed BEFORE UPDATE OF owner_user_id ON entities
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN SELECT RAISE(ABORT, 'entities never change owner'); END`,
  `CREATE TRIGGER connections_owner_fixed BEFORE UPDATE OF owner_user_id ON connections
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN SELECT RAISE(ABORT, 'connections never change owner'); END`,
  `CREATE TRIGGER entity_revisions_fts_delete AFTER DELETE ON entity_revisions
    BEGIN INSERT INTO entity_revisions_fts (entity_revisions_fts, rowid, search_text) VALUES ('delete', OLD.seq, OLD.search_text); END`,
  `CREATE TRIGGER credentials_owner_fixed BEFORE UPDATE OF owner_user_id ON credentials
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN SELECT RAISE(ABORT, 'credentials never change owner'); END`,
  `CREATE TRIGGER sessions_owner_fixed BEFORE UPDATE OF user_id ON sessions
      WHEN NEW.user_id IS NOT OLD.user_id
      BEGIN SELECT RAISE(ABORT, 'sessions never change owner'); END`,
  `CREATE TRIGGER drafts_owner_fixed BEFORE UPDATE OF user_id ON drafts
      WHEN NEW.user_id IS NOT OLD.user_id
      BEGIN SELECT RAISE(ABORT, 'drafts never change owner'); END`,
  `CREATE TRIGGER bin_items_owner_fixed BEFORE UPDATE OF user_id ON bin_items
      WHEN NEW.user_id IS NOT OLD.user_id
      BEGIN SELECT RAISE(ABORT, 'bin_items never change owner'); END`,
  `CREATE TRIGGER recovered_texts_owner_fixed BEFORE UPDATE OF user_id ON recovered_texts
      WHEN NEW.user_id IS NOT OLD.user_id
      BEGIN SELECT RAISE(ABORT, 'recovered_texts never change owner'); END`,
  `CREATE TRIGGER media_refs_owner_fixed BEFORE UPDATE OF owner_user_id ON media_refs
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN SELECT RAISE(ABORT, 'media_refs never change owner'); END`,
  `CREATE TRIGGER jobs_owner_fixed BEFORE UPDATE OF owner_user_id ON jobs
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN SELECT RAISE(ABORT, 'jobs never change owner'); END`,
  `CREATE TRIGGER llm_requests_owner_fixed BEFORE UPDATE OF owner_user_id ON llm_requests
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN SELECT RAISE(ABORT, 'llm_requests never change owner'); END`,
  `CREATE TRIGGER entity_refs_entity_fixed BEFORE UPDATE OF entity_id ON entity_refs
    WHEN NEW.entity_id IS NOT OLD.entity_id
    BEGIN SELECT RAISE(ABORT, 'a ref never moves to another entity'); END`,
  `CREATE TABLE queued_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- The reply it waits for: the slot, not a version, so it posts after whichever version
    -- ends up selected.
    reply_slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    -- Order among the entries waiting in a chat.
    seq INTEGER NOT NULL,
    -- A message to post, or a reply to generate.
    kind TEXT NOT NULL CHECK (kind IN ('message', 'generate')),
    content TEXT NOT NULL,
    -- As on versions: the typed text before regex scripts rewrote it, and what they did.
    raw_content TEXT,
    rewrite_json TEXT CHECK (rewrite_json IS NULL OR json_valid(rewrite_json)),
    speaker_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    -- For 'message': who replies to it once it posts, picked when it was sent, as an
    -- immediate send's reply is.
    reply_speaker_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
    -- For 'generate': the one-turn direction the reply gets.
    direction TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, no_reply INTEGER NOT NULL DEFAULT 0 CHECK (no_reply IN (0, 1)), fork_id TEXT,
    images_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(images_json)),
    -- 1: a reply of a round (DESIGN §2.3), queued by the server behind the round's reply before it.
    round INTEGER NOT NULL DEFAULT 0 CHECK (round IN (0, 1)),
    -- 1: its round stopped (Stop, a failed reply, a restart) and waits for Continue round.
    held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
    -- 1: its reply's speaker is for the decision model to choose when it posts (Auto's pick if it can't).
    auto_pick INTEGER NOT NULL DEFAULT 0 CHECK (auto_pick IN (0, 1)),
    -- A copy of a message sent to several threads that queued behind a reply: its group, so
    -- the post writes its thread_sends row (spec/THREADS.md §6.2).
    send_group TEXT,
    -- A round's entry: the slot of the round's first reply, once there is one, so the turns
    -- already decided can be shown (DESIGN §2.3).
    round_start_slot_id TEXT REFERENCES slots(id) ON DELETE SET NULL,
    -- A side chat's story position for the reply this entry asks for (spec/WORKSHOP.md §4).
    story_at_json TEXT CHECK (story_at_json IS NULL OR json_valid(story_at_json)),
    CHECK (round = 0 OR kind = 'generate'),
    CHECK (held = 0 OR round = 1),
    CHECK (kind = 'generate' OR length(content) > 0 OR json_array_length(images_json) > 0),
    CHECK (kind = 'generate' OR direction IS NULL),
    CHECK (kind = 'message' OR reply_speaker_entity_id IS NULL)
  ) STRICT`,
  `CREATE INDEX queued_messages_reply ON queued_messages(reply_slot_id, seq)`,
  `CREATE INDEX queued_messages_chat ON queued_messages(chat_id, seq)`,
  `CREATE INDEX queued_messages_speaker ON queued_messages(speaker_entity_id)`,
  `CREATE INDEX queued_messages_reply_speaker ON queued_messages(reply_speaker_entity_id)`,
  `CREATE INDEX queued_messages_round_start ON queued_messages(round_start_slot_id) WHERE round_start_slot_id IS NOT NULL`,
  `CREATE TRIGGER queued_messages_chat_fixed BEFORE UPDATE OF chat_id ON queued_messages
    WHEN NEW.chat_id IS NOT OLD.chat_id
    BEGIN SELECT RAISE(ABORT, 'queued messages never move to another chat'); END`,
  `CREATE TRIGGER queued_messages_reply_same_chat BEFORE INSERT ON queued_messages
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.reply_slot_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'queued_messages.reply_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER queued_messages_reply_same_chat_update BEFORE UPDATE OF reply_slot_id ON queued_messages
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.reply_slot_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'queued_messages.reply_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER queued_messages_speaker_owner BEFORE INSERT ON queued_messages
    WHEN NEW.speaker_entity_id IS NOT NULL AND (SELECT owner_user_id FROM entities WHERE id = NEW.speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a queued message speaks as a card of the chat''s owner'); END`,
  `CREATE TRIGGER queued_messages_speaker_owner_update BEFORE UPDATE OF speaker_entity_id ON queued_messages
    WHEN NEW.speaker_entity_id IS NOT NULL AND (SELECT owner_user_id FROM entities WHERE id = NEW.speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a queued message speaks as a card of the chat''s owner'); END`,
  `CREATE TRIGGER queued_messages_reply_speaker_owner BEFORE INSERT ON queued_messages
    WHEN NEW.reply_speaker_entity_id IS NOT NULL
      AND (SELECT owner_user_id FROM entities WHERE id = NEW.reply_speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a queued message''s reply speaks as a card of the chat''s owner'); END`,
  `CREATE TRIGGER queued_messages_reply_speaker_owner_update BEFORE UPDATE OF reply_speaker_entity_id ON queued_messages
    WHEN NEW.reply_speaker_entity_id IS NOT NULL
      AND (SELECT owner_user_id FROM entities WHERE id = NEW.reply_speaker_entity_id)
      IS NOT (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a queued message''s reply speaks as a card of the chat''s owner'); END`,
  `CREATE TABLE composer_save_receipts (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      recovered INTEGER NOT NULL CHECK (recovered IN (0, 1)), displaced_json TEXT
      CHECK (displaced_json IS NULL OR json_valid(displaced_json)),
      PRIMARY KEY (chat_id, operation_id)
    ) STRICT`,
  `CREATE TRIGGER connections_cache_revision AFTER UPDATE OF base_url, proxy_mode, proxy_url_enc,
    credential_id, headers_enc, compat_json, provider_settings_json, deleted_at, purged_at ON connections
    WHEN NEW.base_url IS NOT OLD.base_url OR NEW.proxy_mode IS NOT OLD.proxy_mode
      OR NEW.proxy_url_enc IS NOT OLD.proxy_url_enc OR NEW.credential_id IS NOT OLD.credential_id
      OR NEW.headers_enc IS NOT OLD.headers_enc OR NEW.compat_json IS NOT OLD.compat_json
      OR NEW.provider_settings_json IS NOT OLD.provider_settings_json
      OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.purged_at IS NOT OLD.purged_at
    BEGIN UPDATE connections SET cache_revision = OLD.cache_revision + 1 WHERE id = NEW.id; END`,
  `CREATE TRIGGER credentials_cache_revision AFTER UPDATE OF key_enc ON credentials
    WHEN NEW.key_enc IS NOT OLD.key_enc
    BEGIN UPDATE connections SET cache_revision = cache_revision + 1 WHERE credential_id = NEW.id; END`,
  `CREATE TRIGGER network_cache_insert AFTER INSERT ON settings WHEN NEW.scope = 'app' AND NEW.scope_id = '' AND NEW.key = 'network'
    BEGIN UPDATE connections SET cache_revision = cache_revision + 1; END`,
  `CREATE TRIGGER network_cache_update AFTER UPDATE ON settings WHEN NEW.scope = 'app' AND NEW.scope_id = '' AND NEW.key = 'network'
    BEGIN UPDATE connections SET cache_revision = cache_revision + 1; END`,
  `CREATE INDEX llm_requests_chat ON llm_requests(chat_id, started_at) WHERE chat_id IS NOT NULL`,
  `CREATE TRIGGER llm_requests_stagger_frozen BEFORE UPDATE OF cache_stagger_json ON llm_requests
      WHEN OLD.status <> 'running' AND NEW.cache_stagger_json IS NOT OLD.cache_stagger_json
      BEGIN SELECT RAISE(ABORT, 'a closed request is a record'); END`,
  `CREATE TRIGGER llm_requests_cache_identity_frozen BEFORE UPDATE OF cache_identity_json ON llm_requests
      WHEN OLD.status <> 'running' AND NEW.cache_identity_json IS NOT OLD.cache_identity_json
      BEGIN SELECT RAISE(ABORT, 'a closed request is a record'); END`,
  `CREATE INDEX rollouts_history ON rollouts(chat_id, history_depth DESC, id DESC) WHERE history_depth IS NOT NULL`,
  `CREATE TABLE history_changes (
    slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    -- The fork the reduction was made in; '' for every fork (a message nobody shows).
    fork_id TEXT NOT NULL DEFAULT '',
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    depth INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    -- The chat's state_seq of this reduction.
    seq INTEGER NOT NULL DEFAULT 0,
    -- Its fork's point when written (db/forkLabels.ts); null for every fork.
    label BLOB,
    PRIMARY KEY (slot_id, fork_id, seq)
  ) STRICT`,
  `CREATE INDEX history_changes_depth ON history_changes(chat_id, depth)`,
  `CREATE TRIGGER history_reduced_slot AFTER UPDATE OF deleted_at ON slots
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NOT ${namesFork("NEW.bin_item_id")}
    BEGIN
      INSERT INTO history_changes(slot_id, fork_id, chat_id, depth, revision) VALUES (NEW.id, '', NEW.chat_id, NEW.depth, 1)
      ON CONFLICT(slot_id, fork_id, seq) DO UPDATE SET revision = revision + 1;
    END`,
  `CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level >= 1),
    selected_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) DEFERRABLE INITIALLY DEFERRED,
    first_slot_id TEXT NOT NULL REFERENCES slots(id),
    last_slot_id TEXT NOT NULL REFERENCES slots(id),
    slot_count INTEGER NOT NULL CHECK (slot_count >= 1),
    -- NULL: a summary of the whole path (shared context, narrators). Otherwise the sorted card ids
    -- whose separate view it summarizes: who held exactly its inputs over its range
    -- (spec/CHARACTER-CONTEXT.md §9.1).
    audience_json TEXT CHECK (audience_json IS NULL OR (json_valid(audience_json) AND json_type(audience_json) = 'array')),
    status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'truncated', 'superseded', 'failed')),
    sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)), error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)), batch_id TEXT, rollout_id TEXT REFERENCES rollouts(id),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    -- The images a level-1 summary was written with (db/lcmImages.ts): {"limit": N|null, "sent": [media ids], "withheld": [media ids]}.
    -- NULL when its inputs' versions had no images, so freshness needs no image read.
    images_json TEXT CHECK (images_json IS NULL OR json_valid(images_json))
  ) STRICT`,
  // The implicit rowid suffix supports max(rowid) and the per-chat rowid delta without
  // scanning summaries on unrelated forks. (chat_id, level) cannot bound that delta.
  `CREATE INDEX summaries_chat ON summaries(chat_id)`,
  `CREATE INDEX summaries_chat_level ON summaries(chat_id, level)`,
  `CREATE INDEX summaries_last_slot ON summaries(last_slot_id)`,
  `CREATE INDEX summaries_status ON summaries(chat_id, status, level)`,
  `CREATE TABLE summary_revisions (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    content TEXT NOT NULL,
    rollout_id TEXT REFERENCES rollouts(id),
    token_count INTEGER NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX summary_revisions_summary ON summary_revisions(summary_id, seq)`,
  `CREATE INDEX summary_revisions_rollout ON summary_revisions(rollout_id) WHERE rollout_id IS NOT NULL`,
  `CREATE TABLE summary_inputs (
    summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    slot_id TEXT NOT NULL REFERENCES slots(id),
    version_id TEXT REFERENCES versions(id),
    amend_count INTEGER NOT NULL DEFAULT 0 CHECK (amend_count >= 0), PRIMARY KEY (summary_id, ordinal)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX summary_inputs_slot ON summary_inputs(slot_id)`,
  `CREATE TABLE summary_parents (
    summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL REFERENCES summaries(id),
    ordinal INTEGER NOT NULL, parent_revision_id TEXT NOT NULL REFERENCES summary_revisions(id), UNIQUE (summary_id, ordinal),
    PRIMARY KEY (summary_id, parent_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX summary_parents_parent ON summary_parents(parent_id)`,
  `CREATE TABLE summarization_jobs (
    id TEXT PRIMARY KEY,
    fork_id TEXT REFERENCES forks(id),
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level >= 1),
    first_slot_id TEXT NOT NULL REFERENCES slots(id),
    last_slot_id TEXT NOT NULL REFERENCES slots(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    request_class TEXT NOT NULL DEFAULT 'background' CHECK (request_class IN ('interactive', 'idle', 'background')),
    batch_id TEXT, leaf_slot_id TEXT REFERENCES slots(id), input_token_count INTEGER,
    target_token_count INTEGER NOT NULL,
    -- Level >= 2: the ordered child summary ids (JSON array).
    input_child_ids TEXT CHECK (input_child_ids IS NULL OR json_valid(input_child_ids)),
    absorbed_parent_id TEXT REFERENCES summaries(id),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    best_effort_draft TEXT,
    error TEXT,
    result_summary_id TEXT REFERENCES summaries(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  , clip_tokens INTEGER NOT NULL DEFAULT 6000 CHECK (clip_tokens > 0), claim_epoch INTEGER NOT NULL DEFAULT 0, rollout_id TEXT REFERENCES rollouts(id), prefix_json TEXT CHECK (prefix_json IS NULL OR json_valid(prefix_json)), model_json TEXT CHECK (model_json IS NULL OR json_valid(model_json)), fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)), eager INTEGER NOT NULL DEFAULT 0 CHECK (eager IN (0, 1)), source_summary_id TEXT REFERENCES summaries(id), source_revision_id TEXT REFERENCES summary_revisions(id), rerun_ids_json TEXT CHECK (rerun_ids_json IS NULL OR json_valid(rerun_ids_json)), explicit_requested INTEGER NOT NULL DEFAULT 0 CHECK (explicit_requested IN (0, 1)),
    -- The view the job summarizes, as summaries.audience_json: NULL for the whole path.
    audience_json TEXT CHECK (audience_json IS NULL OR (json_valid(audience_json) AND json_type(audience_json) = 'array'))) STRICT`,
  `CREATE INDEX summarization_jobs_queue ON summarization_jobs(status, created_at) WHERE status IN ('pending', 'processing')`,
  // Two separate contexts can summarize the same range at once, each its own view.
  `CREATE UNIQUE INDEX summarization_jobs_live_segment ON summarization_jobs(chat_id, fork_id, first_slot_id, last_slot_id, level, coalesce(audience_json, ''))
    WHERE status IN ('pending', 'processing')`,
  // A view's audience in one canonical form (sorted, distinct card ids, compact JSON), so the
  // live-job index and audience matching compare like with like (spec/CHARACTER-CONTEXT.md C7).
  ...["summaries", "summarization_jobs"].flatMap((table) =>
    ["INSERT", "UPDATE OF audience_json"].map(
      (
        when
      ) => `CREATE TRIGGER ${table}_audience_canonical_${when === "INSERT" ? "insert" : "update"} BEFORE ${when} ON ${table}
    WHEN NEW.audience_json IS NOT NULL AND json_valid(NEW.audience_json) AND json_type(NEW.audience_json) = 'array'
      AND (json_array_length(NEW.audience_json) = 0
      OR EXISTS (SELECT 1 FROM json_each(NEW.audience_json) WHERE type <> 'text')
      OR NEW.audience_json IS NOT (SELECT json_group_array(value) FROM
        (SELECT DISTINCT value FROM json_each(NEW.audience_json) ORDER BY value)))
    BEGIN SELECT RAISE(ABORT, 'an audience is its sorted, distinct card ids'); END`
    )
  ),
  `CREATE INDEX summary_inputs_version ON summary_inputs(version_id)`,
  `CREATE INDEX summaries_first_slot ON summaries(first_slot_id)`,
  `CREATE INDEX summarization_jobs_fork ON summarization_jobs(fork_id)`,
  `CREATE INDEX summarization_jobs_first_slot ON summarization_jobs(first_slot_id)`,
  `CREATE INDEX summarization_jobs_last_slot ON summarization_jobs(last_slot_id)`,
  `CREATE INDEX summaries_selected_revision ON summaries(selected_revision_id)`,
  `CREATE INDEX summaries_rollout ON summaries(rollout_id) WHERE rollout_id IS NOT NULL`,
  `CREATE INDEX summarization_jobs_result ON summarization_jobs(result_summary_id) WHERE result_summary_id IS NOT NULL`,
  `CREATE INDEX summarization_jobs_absorbed ON summarization_jobs(absorbed_parent_id) WHERE absorbed_parent_id IS NOT NULL`,
  `CREATE TRIGGER summaries_selection_own_revision_insert BEFORE INSERT ON summaries
    WHEN (SELECT summary_id FROM summary_revisions WHERE id = NEW.selected_revision_id) IS NOT NEW.id
    BEGIN SELECT RAISE(ABORT, 'a summary can only select one of its own revisions'); END`,
  `CREATE TRIGGER summaries_first_slot_id_same_chat BEFORE INSERT ON summaries WHEN NEW.first_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.first_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summaries.first_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summaries_first_slot_id_same_chat_update BEFORE UPDATE OF first_slot_id, chat_id
      ON summaries WHEN NEW.first_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.first_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summaries.first_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summaries_last_slot_id_same_chat BEFORE INSERT ON summaries WHEN NEW.last_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.last_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summaries.last_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summaries_last_slot_id_same_chat_update BEFORE UPDATE OF last_slot_id, chat_id
      ON summaries WHEN NEW.last_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.last_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summaries.last_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summaries_rollout_id_same_chat BEFORE INSERT ON summaries WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summaries.rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER summaries_rollout_id_same_chat_update BEFORE UPDATE OF rollout_id, chat_id
      ON summaries WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summaries.rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER summary_inputs_slot_id_same_chat BEFORE INSERT ON summary_inputs WHEN NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT (SELECT chat_id FROM summaries WHERE id = NEW.summary_id) BEGIN SELECT RAISE(ABORT, 'summary_inputs.slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summary_inputs_slot_id_same_chat_update BEFORE UPDATE OF slot_id, summary_id
      ON summary_inputs WHEN NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT (SELECT chat_id FROM summaries WHERE id = NEW.summary_id) BEGIN SELECT RAISE(ABORT, 'summary_inputs.slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summary_inputs_version_in_slot BEFORE INSERT ON summary_inputs
    WHEN NEW.version_id IS NOT NULL AND (SELECT slot_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.slot_id
    BEGIN SELECT RAISE(ABORT, 'a summary input''s version must be in its slot'); END`,
  `CREATE TRIGGER summary_inputs_version_in_slot_update BEFORE UPDATE OF slot_id, version_id ON summary_inputs
    WHEN NEW.version_id IS NOT NULL AND (SELECT slot_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.slot_id
    BEGIN SELECT RAISE(ABORT, 'a summary input''s version must be in its slot'); END`,
  `CREATE TRIGGER summary_parents_parent_id_same_chat BEFORE INSERT ON summary_parents WHEN NEW.parent_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.parent_id) IS NOT (SELECT chat_id FROM summaries WHERE id = NEW.summary_id) BEGIN SELECT RAISE(ABORT, 'summary_parents.parent_id must be in the same chat'); END`,
  `CREATE TRIGGER summary_parents_parent_id_same_chat_update BEFORE UPDATE OF parent_id, summary_id
      ON summary_parents WHEN NEW.parent_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.parent_id) IS NOT (SELECT chat_id FROM summaries WHERE id = NEW.summary_id) BEGIN SELECT RAISE(ABORT, 'summary_parents.parent_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_first_slot_id_same_chat BEFORE INSERT ON summarization_jobs WHEN NEW.first_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.first_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.first_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_first_slot_id_same_chat_update BEFORE UPDATE OF first_slot_id, chat_id
      ON summarization_jobs WHEN NEW.first_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.first_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.first_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_last_slot_id_same_chat BEFORE INSERT ON summarization_jobs WHEN NEW.last_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.last_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.last_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_last_slot_id_same_chat_update BEFORE UPDATE OF last_slot_id, chat_id
      ON summarization_jobs WHEN NEW.last_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.last_slot_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.last_slot_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_absorbed_parent_id_same_chat BEFORE INSERT ON summarization_jobs WHEN NEW.absorbed_parent_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.absorbed_parent_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.absorbed_parent_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_absorbed_parent_id_same_chat_update BEFORE UPDATE OF absorbed_parent_id, chat_id
      ON summarization_jobs WHEN NEW.absorbed_parent_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.absorbed_parent_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.absorbed_parent_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_result_summary_id_same_chat BEFORE INSERT ON summarization_jobs WHEN NEW.result_summary_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.result_summary_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.result_summary_id must be in the same chat'); END`,
  `CREATE TRIGGER summarization_jobs_result_summary_id_same_chat_update BEFORE UPDATE OF result_summary_id, chat_id
      ON summarization_jobs WHEN NEW.result_summary_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.result_summary_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summarization_jobs.result_summary_id must be in the same chat'); END`,
  `CREATE TRIGGER summaries_chat_fixed BEFORE UPDATE OF chat_id ON summaries
      WHEN NEW.chat_id IS NOT OLD.chat_id
      BEGIN SELECT RAISE(ABORT, 'summaries rows never move to another chat'); END`,
  `CREATE TRIGGER summarization_jobs_chat_fixed BEFORE UPDATE OF chat_id ON summarization_jobs
      WHEN NEW.chat_id IS NOT OLD.chat_id
      BEGIN SELECT RAISE(ABORT, 'summarization_jobs rows never move to another chat'); END`,
  `CREATE TRIGGER summary_revisions_immutable BEFORE UPDATE ON summary_revisions
    BEGIN SELECT RAISE(ABORT, 'summary revisions are immutable'); END`,
  `CREATE TRIGGER summaries_selection_own_revision BEFORE UPDATE OF selected_revision_id ON summaries
    WHEN (SELECT summary_id FROM summary_revisions WHERE id = NEW.selected_revision_id) IS NOT NEW.id
    BEGIN SELECT RAISE(ABORT, 'a summary can only select one of its own revisions'); END`,
  `CREATE VIRTUAL TABLE summary_revisions_fts USING fts5(
    content, content='summary_revisions', content_rowid='seq',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  )`,
  `CREATE TRIGGER summary_revisions_fts_insert AFTER INSERT ON summary_revisions
    BEGIN INSERT INTO summary_revisions_fts (rowid, content) VALUES (NEW.seq, NEW.content); END`,
  `CREATE TRIGGER summary_revisions_fts_delete AFTER DELETE ON summary_revisions
    BEGIN INSERT INTO summary_revisions_fts (summary_revisions_fts, rowid, content) VALUES ('delete', OLD.seq, OLD.content); END`,
  `CREATE TRIGGER drafts_gc_summary AFTER DELETE ON summaries
    BEGIN DELETE FROM drafts WHERE target_kind = 'summary_edit' AND target_id = OLD.id; END`,
  `CREATE INDEX summary_parents_revision ON summary_parents(parent_revision_id)`,
  `CREATE INDEX summarization_jobs_batch ON summarization_jobs(batch_id)`,
  `CREATE INDEX summarization_jobs_leaf ON summarization_jobs(leaf_slot_id)`,
  `CREATE TRIGGER summary_parents_own_revision BEFORE INSERT ON summary_parents
    WHEN (SELECT summary_id FROM summary_revisions WHERE id = NEW.parent_revision_id) IS NOT NEW.parent_id
    BEGIN SELECT RAISE(ABORT, 'lineage must pin a revision of its child'); END`,
  `CREATE TRIGGER summaries_start_unsealed BEFORE INSERT ON summaries WHEN NEW.sealed <> 0
    BEGIN SELECT RAISE(ABORT, 'summary lineage must be sealed after insertion'); END`,
  `CREATE TRIGGER summary_inputs_closed BEFORE INSERT ON summary_inputs
      WHEN (SELECT sealed FROM summaries WHERE id = NEW.summary_id) = 1
      BEGIN SELECT RAISE(ABORT, 'sealed summary lineage is closed'); END`,
  `CREATE TRIGGER summary_parents_closed BEFORE INSERT ON summary_parents
      WHEN (SELECT sealed FROM summaries WHERE id = NEW.summary_id) = 1
      BEGIN SELECT RAISE(ABORT, 'sealed summary lineage is closed'); END`,
  `CREATE TRIGGER summary_parents_chain BEFORE INSERT ON summary_parents WHEN NOT EXISTS (
    SELECT 1 FROM summaries s JOIN summaries child ON child.id = NEW.parent_id
      JOIN slots first ON first.id = child.first_slot_id
    WHERE s.id = NEW.summary_id AND s.level > 1 AND child.level < s.level AND child.id <> s.id
      AND child.sealed = 1 AND child.status <> 'failed'
      AND NEW.ordinal >= 0 AND NEW.ordinal = (SELECT count(*) FROM summary_parents WHERE summary_id = s.id)
      AND CASE WHEN NEW.ordinal = 0 THEN child.first_slot_id = s.first_slot_id
      WHEN first.parent_slot_id = (SELECT prev.last_slot_id FROM summary_parents p JOIN summaries prev ON prev.id = p.parent_id
          WHERE p.summary_id = s.id AND p.ordinal = NEW.ordinal - 1) THEN 1
      ELSE EXISTS (WITH RECURSIVE up(id, parent_slot_id, inserted, depth) AS (
          SELECT id, parent_slot_id, inserted, depth FROM slots WHERE id = (SELECT prev.last_slot_id FROM summary_parents p JOIN summaries prev ON prev.id = p.parent_id
            WHERE p.summary_id = NEW.summary_id AND p.ordinal = NEW.ordinal - 1)
          UNION ALL SELECT a.id, a.parent_slot_id, a.inserted, a.depth FROM slots a JOIN up ON a.id = up.parent_slot_id
            WHERE up.inserted = 1 AND up.depth > (SELECT depth FROM slots WHERE id = child.first_slot_id)
        ) SELECT 1 FROM up WHERE up.inserted = 1 AND up.id <> child.first_slot_id
          AND up.parent_slot_id IS first.parent_slot_id AND (first.inserted = 0 OR up.id > first.id)) END
    ) BEGIN SELECT RAISE(ABORT, 'summary children must partition its chain at strictly lower levels'); END`,
  `CREATE TRIGGER summaries_seal BEFORE UPDATE OF sealed ON summaries WHEN OLD.sealed = 0 AND NEW.sealed = 1 AND NOT coalesce((
    CASE WHEN NEW.level = 1 THEN
      (SELECT count(*) FROM summary_inputs WHERE summary_id = NEW.id) = NEW.slot_count
      AND (SELECT slot_id FROM summary_inputs WHERE summary_id = NEW.id ORDER BY ordinal DESC LIMIT 1) = NEW.last_slot_id
      AND NOT EXISTS (SELECT 1 FROM summary_parents WHERE summary_id = NEW.id)
    ELSE
      (SELECT coalesce(sum(child.slot_count),0) FROM summary_parents p JOIN summaries child ON child.id = p.parent_id
        WHERE p.summary_id = NEW.id) = NEW.slot_count
      AND (SELECT child.last_slot_id FROM summary_parents p JOIN summaries child ON child.id = p.parent_id
        WHERE p.summary_id = NEW.id ORDER BY p.ordinal DESC LIMIT 1) = NEW.last_slot_id
      AND NOT EXISTS (SELECT 1 FROM summary_inputs WHERE summary_id = NEW.id)
    END
    ), 0) BEGIN SELECT RAISE(ABORT, 'sealed summary lineage must cover its entire chain'); END`,
  `CREATE TRIGGER summarization_jobs_leaf_same_chat BEFORE INSERT ON summarization_jobs
      WHEN NEW.leaf_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.leaf_slot_id) IS NOT NEW.chat_id
      BEGIN SELECT RAISE(ABORT, 'a summary job''s leaf must be in its chat'); END`,
  `CREATE TRIGGER summarization_jobs_leaf_same_chat_update BEFORE UPDATE OF leaf_slot_id, chat_id ON summarization_jobs
      WHEN NEW.leaf_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.leaf_slot_id) IS NOT NEW.chat_id
      BEGIN SELECT RAISE(ABORT, 'a summary job''s leaf must be in its chat'); END`,
  `CREATE TRIGGER summaries_no_replace BEFORE INSERT ON summaries
    WHEN EXISTS (SELECT 1 FROM summaries WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'summary identities cannot be replaced'); END`,
  `CREATE TRIGGER summary_revisions_no_replace BEFORE INSERT ON summary_revisions
    WHEN EXISTS (SELECT 1 FROM summary_revisions WHERE id = NEW.id OR seq = NEW.seq)
    BEGIN SELECT RAISE(ABORT, 'summary identities cannot be replaced'); END`,
  `CREATE TRIGGER summary_inputs_no_replace BEFORE INSERT ON summary_inputs
    WHEN EXISTS (SELECT 1 FROM summary_inputs WHERE summary_id = NEW.summary_id AND ordinal = NEW.ordinal)
    BEGIN SELECT RAISE(ABORT, 'summary identities cannot be replaced'); END`,
  `CREATE TRIGGER summary_parents_no_replace BEFORE INSERT ON summary_parents
    WHEN EXISTS (SELECT 1 FROM summary_parents WHERE summary_id = NEW.summary_id AND (parent_id = NEW.parent_id OR ordinal = NEW.ordinal))
    BEGIN SELECT RAISE(ABORT, 'summary identities cannot be replaced'); END`,
  `CREATE TRIGGER summary_inputs_immutable BEFORE UPDATE ON summary_inputs BEGIN SELECT RAISE(ABORT, 'summary lineage is immutable'); END`,
  `CREATE TRIGGER summary_inputs_retained BEFORE DELETE ON summary_inputs
      WHEN EXISTS (SELECT 1 FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.id = OLD.summary_id)
      BEGIN SELECT RAISE(ABORT, 'summary lineage lives as long as its chat'); END`,
  `CREATE TRIGGER summary_parents_immutable BEFORE UPDATE ON summary_parents BEGIN SELECT RAISE(ABORT, 'summary lineage is immutable'); END`,
  `CREATE TRIGGER summary_parents_retained BEFORE DELETE ON summary_parents
      WHEN EXISTS (SELECT 1 FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.id = OLD.summary_id)
      BEGIN SELECT RAISE(ABORT, 'summary lineage lives as long as its chat'); END`,
  `CREATE TRIGGER summaries_immutable BEFORE UPDATE ON summaries WHEN
    (OLD.sealed = 1 AND NEW.sealed <> 1) OR NEW.id IS NOT OLD.id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.level IS NOT OLD.level OR
    NEW.first_slot_id IS NOT OLD.first_slot_id OR NEW.last_slot_id IS NOT OLD.last_slot_id OR
    NEW.slot_count IS NOT OLD.slot_count OR NEW.audience_json IS NOT OLD.audience_json OR
    NEW.rollout_id IS NOT OLD.rollout_id OR NEW.error_json IS NOT OLD.error_json OR
    NEW.batch_id IS NOT OLD.batch_id OR NEW.created_at IS NOT OLD.created_at OR NEW.images_json IS NOT OLD.images_json OR
    (NEW.status IS NOT OLD.status AND NEW.status <> 'superseded')
    BEGIN SELECT RAISE(ABORT, 'only summary selection, supersession and row version can change'); END`,
  `CREATE TRIGGER summaries_retained BEFORE DELETE ON summaries
      WHEN EXISTS (SELECT 1 FROM chats c WHERE c.id = OLD.chat_id)
      BEGIN SELECT RAISE(ABORT, 'summaries and revisions live as long as their chat'); END`,
  `CREATE TRIGGER summary_revisions_retained BEFORE DELETE ON summary_revisions
      WHEN EXISTS (SELECT 1 FROM chats c JOIN summaries s ON s.chat_id = c.id WHERE s.id = OLD.summary_id)
      BEGIN SELECT RAISE(ABORT, 'summaries and revisions live as long as their chat'); END`,
  `CREATE TABLE summary_attempts (
    job_id TEXT NOT NULL REFERENCES summarization_jobs(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    rollout_id TEXT NOT NULL UNIQUE REFERENCES rollouts(id) ON DELETE CASCADE,
    PRIMARY KEY (job_id, epoch)
  ) STRICT`,
  `CREATE TRIGGER summary_attempts_same_chat BEFORE INSERT ON summary_attempts
    WHEN (SELECT chat_id FROM summarization_jobs WHERE id=NEW.job_id) IS NOT
      (SELECT chat_id FROM rollouts WHERE id=NEW.rollout_id)
    BEGIN SELECT RAISE(ABORT, 'summary attempt must belong to its job chat'); END`,
  `CREATE TRIGGER summary_attempts_immutable BEFORE UPDATE ON summary_attempts
    BEGIN SELECT RAISE(ABORT, 'summary attempts are immutable'); END`,
  `CREATE INDEX summarization_jobs_rollout ON summarization_jobs(rollout_id)`,
  `CREATE TRIGGER summarization_jobs_rollout_same_chat BEFORE INSERT ON summarization_jobs WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summary rollout must belong to its job chat'); END`,
  `CREATE TRIGGER summarization_jobs_rollout_same_chat_update BEFORE UPDATE OF rollout_id, chat_id ON summarization_jobs WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summary rollout must belong to its job chat'); END`,
  `CREATE INDEX summarization_jobs_chat_status ON summarization_jobs(chat_id, status, level)`,
  `CREATE TABLE summary_reruns (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      summary_id TEXT REFERENCES summaries(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES summarization_jobs(id) ON DELETE CASCADE,
      requested_at INTEGER NOT NULL, model_json TEXT CHECK (model_json IS NULL OR json_valid(model_json)),
      CHECK ((summary_id IS NULL) <> (job_id IS NULL))
    ) STRICT`,
  `CREATE INDEX summary_reruns_chat ON summary_reruns(chat_id)`,
  `CREATE INDEX summary_reruns_summary ON summary_reruns(summary_id) WHERE summary_id IS NOT NULL`,
  `CREATE INDEX summary_reruns_job ON summary_reruns(job_id) WHERE job_id IS NOT NULL`,
  `CREATE TRIGGER summary_reruns_same_chat BEFORE INSERT ON summary_reruns
      WHEN (NEW.summary_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.summary_id) IS NOT NEW.chat_id)
        OR (NEW.job_id IS NOT NULL AND (SELECT chat_id FROM summarization_jobs WHERE id = NEW.job_id) IS NOT NEW.chat_id)
      BEGIN SELECT RAISE(ABORT, 'a rerun request must name something in its own chat'); END`,
  `CREATE TRIGGER summary_reruns_fixed BEFORE UPDATE OF chat_id, summary_id, job_id ON summary_reruns
      BEGIN SELECT RAISE(ABORT, 'a rerun request is withdrawn and asked again, never moved'); END`,
  `CREATE INDEX jobs_lcm_backfill ON jobs(json_extract(payload_json, '$.chatId')) WHERE kind = 'lcm-backfill'`,
  `CREATE TABLE lcm_reply_maintenance (
      fork_id TEXT NOT NULL REFERENCES forks(id),
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      leaf_slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      pins_json TEXT NOT NULL CHECK (json_valid(pins_json)),
      PRIMARY KEY (chat_id, fork_id, leaf_slot_id)
    ) STRICT`,
  `CREATE INDEX summarization_jobs_source ON summarization_jobs(source_summary_id)`,
  `CREATE INDEX summarization_jobs_source_revision ON summarization_jobs(source_revision_id)`,
  `CREATE INDEX lcm_reply_maintenance_fork ON lcm_reply_maintenance(fork_id)`,
  `CREATE INDEX lcm_reply_maintenance_leaf ON lcm_reply_maintenance(leaf_slot_id)`,
  `CREATE TABLE lcm_summary_choices (
      summary_id TEXT PRIMARY KEY REFERENCES summaries(id) ON DELETE CASCADE,
      chosen_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE
    ) STRICT`,
  `CREATE INDEX lcm_summary_choices_chosen ON lcm_summary_choices(chosen_id)`,
  `CREATE INDEX llm_requests_backfill ON llm_requests(backfill_id, status)`,
  `CREATE TABLE lcm_enable_runs (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), cursor TEXT, gathered INTEGER NOT NULL DEFAULT 0,
    copied INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'gather', published INTEGER NOT NULL DEFAULT 0,
    -- The imported summary's images as gathered so far (db/lcmImages.ts), NULL while none was attached.
    images_json TEXT CHECK (images_json IS NULL OR json_valid(images_json))
  ) STRICT`,
  `CREATE UNIQUE INDEX lcm_enable_one_staging ON lcm_enable_runs(chat_id) WHERE published = 0 AND phase <> 'cancelled'`,
  `CREATE TABLE lcm_enable_slots (
    run_id TEXT NOT NULL REFERENCES lcm_enable_runs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    version_id TEXT REFERENCES versions(id), amend_count INTEGER NOT NULL, shown INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(run_id, ordinal)
  ) STRICT`,
  `CREATE INDEX lcm_enable_slots_slot ON lcm_enable_slots(slot_id, shown, run_id)`,
  `CREATE TRIGGER lcm_enable_explicit_visibility AFTER UPDATE OF context_excluded ON slots
    BEGIN UPDATE lcm_enable_slots SET shown = 0 WHERE slot_id = NEW.id; END`,
  `CREATE TRIGGER summary_inputs_chain BEFORE INSERT ON summary_inputs WHEN NOT EXISTS (
    SELECT 1 FROM summaries s JOIN slots i ON i.id = NEW.slot_id
    WHERE s.id = NEW.summary_id AND s.level = 1 AND NEW.ordinal >= 0 AND NEW.ordinal < s.slot_count
      AND NEW.ordinal = coalesce((SELECT ordinal + 1 FROM summary_inputs WHERE summary_id = s.id ORDER BY ordinal DESC LIMIT 1), 0)
      AND CASE WHEN NEW.ordinal = 0 THEN NEW.slot_id = s.first_slot_id
      WHEN i.parent_slot_id = (SELECT slot_id FROM summary_inputs WHERE summary_id = s.id AND ordinal = NEW.ordinal - 1) THEN 1
      ELSE EXISTS (WITH RECURSIVE up(id, parent_slot_id, inserted, depth) AS (
          SELECT id, parent_slot_id, inserted, depth FROM slots WHERE id = (SELECT slot_id FROM summary_inputs WHERE summary_id = NEW.summary_id AND ordinal = NEW.ordinal - 1)
          UNION ALL SELECT a.id, a.parent_slot_id, a.inserted, a.depth FROM slots a JOIN up ON a.id = up.parent_slot_id
            WHERE up.inserted = 1 AND up.depth > (SELECT depth FROM slots WHERE id = NEW.slot_id)
        ) SELECT 1 FROM up WHERE up.inserted = 1 AND up.id <> NEW.slot_id
          AND up.parent_slot_id IS i.parent_slot_id AND (i.inserted = 0 OR up.id > i.id)) END
    ) BEGIN SELECT RAISE(ABORT, 'summary inputs must follow their declared chain in order'); END`,
  `CREATE TRIGGER summaries_chain BEFORE INSERT ON summaries WHEN NOT EXISTS (SELECT 1 FROM lcm_enable_runs r
    WHERE r.id = NEW.id AND r.chat_id = NEW.chat_id AND r.phase = 'copy' AND r.gathered = NEW.slot_count
      AND json_extract(r.payload_json, '$.imported.firstSlotId') = NEW.first_slot_id
      AND json_extract(r.payload_json, '$.imported.lastSlotId') = NEW.last_slot_id)
    AND NOT EXISTS (
    WITH RECURSIVE chain(id, parent_slot_id, n) AS (
      SELECT id, parent_slot_id, 1 FROM slots WHERE id = NEW.last_slot_id AND chat_id = NEW.chat_id
      UNION ALL SELECT s.id, s.parent_slot_id, c.n + 1 FROM slots s JOIN chain c ON s.id = c.parent_slot_id
        WHERE c.n < NEW.slot_count AND s.chat_id = NEW.chat_id
    ) SELECT 1 FROM chain WHERE id = NEW.first_slot_id AND n = NEW.slot_count
    )
    AND NOT EXISTS (
      -- A display range may leave an inserted subtree for an older inserted sibling or
      -- the ordinary successor of its anchor. It never returns from an ordinary branch.
      WITH RECURSIVE head(id, parent_slot_id, inserted, depth) AS (
        SELECT id, parent_slot_id, inserted, depth FROM slots WHERE id = NEW.first_slot_id
        UNION ALL SELECT s.id, s.parent_slot_id, s.inserted, s.depth FROM slots s JOIN head h ON s.id = h.parent_slot_id
          WHERE h.inserted = 1
      ), tail(id, parent_slot_id, inserted, depth) AS (
        SELECT id, parent_slot_id, inserted, depth FROM slots WHERE id = NEW.last_slot_id
        UNION ALL SELECT s.id, s.parent_slot_id, s.inserted, s.depth FROM slots s JOIN tail t ON s.id = t.parent_slot_id
          WHERE t.depth > (SELECT min(depth) FROM head)
      ) SELECT 1 FROM head h JOIN tail t ON h.parent_slot_id IS t.parent_slot_id OR h.id = t.id
        WHERE NEW.slot_count >= 2 AND (
          (h.id = NEW.first_slot_id AND h.id = t.id
            AND NEW.slot_count > (SELECT depth FROM slots WHERE id = NEW.last_slot_id) - h.depth + 1
            AND EXISTS (SELECT 1 FROM tail a JOIN slots x ON x.parent_slot_id = a.id
              WHERE x.inserted = 1 AND a.depth >= h.depth AND a.id <> NEW.last_slot_id))
          OR (h.inserted = 1 AND h.id <> t.id AND (t.inserted = 0 OR h.id > t.id)))
    ) BEGIN SELECT RAISE(ABORT, 'summary endpoints must form its declared primary-parent chain'); END`,
  `CREATE INDEX state_events_participants ON state_events(json_extract(value_json, '$.entity'), chat_id)
      WHERE key IN ('participant.join', 'card.swap') AND superseded_by_changeset IS NULL`,
  // The workshops beside a story (spec/WORKSHOP.md §4): each names it in its own chat-wide event.
  `CREATE INDEX state_events_workshop_attached ON state_events(json_extract(value_json, '$.chat'), chat_id)
      WHERE key = 'workshop.attached'`,
  `CREATE INDEX drafts_speaker_entity_id ON drafts(speaker_entity_id) WHERE speaker_entity_id IS NOT NULL`,
  `CREATE TRIGGER drafts_speaker_entity_id_owner BEFORE INSERT ON drafts
      WHEN NEW.speaker_entity_id IS NOT NULL
        AND (NEW.target_kind IS NOT 'composer'
          OR (SELECT owner_user_id FROM entities WHERE id = NEW.speaker_entity_id) IS NOT NEW.user_id)
      BEGIN SELECT RAISE(ABORT, 'a composer chooses among the cards of its owner'); END`,
  `CREATE TRIGGER drafts_speaker_entity_id_owner_update BEFORE UPDATE OF speaker_entity_id ON drafts
      WHEN NEW.speaker_entity_id IS NOT NULL
        AND (NEW.target_kind IS NOT 'composer'
          OR (SELECT owner_user_id FROM entities WHERE id = NEW.speaker_entity_id) IS NOT NEW.user_id)
      BEGIN SELECT RAISE(ABORT, 'a composer chooses among the cards of its owner'); END`,
  `CREATE INDEX drafts_reply_from_entity_id ON drafts(reply_from_entity_id) WHERE reply_from_entity_id IS NOT NULL`,
  `CREATE TRIGGER drafts_reply_from_entity_id_owner BEFORE INSERT ON drafts
      WHEN NEW.reply_from_entity_id IS NOT NULL
        AND (NEW.target_kind IS NOT 'composer'
          OR (SELECT owner_user_id FROM entities WHERE id = NEW.reply_from_entity_id) IS NOT NEW.user_id)
      BEGIN SELECT RAISE(ABORT, 'a composer chooses among the cards of its owner'); END`,
  `CREATE TRIGGER drafts_reply_from_entity_id_owner_update BEFORE UPDATE OF reply_from_entity_id ON drafts
      WHEN NEW.reply_from_entity_id IS NOT NULL
        AND (NEW.target_kind IS NOT 'composer'
          OR (SELECT owner_user_id FROM entities WHERE id = NEW.reply_from_entity_id) IS NOT NEW.user_id)
      BEGIN SELECT RAISE(ABORT, 'a composer chooses among the cards of its owner'); END`,
  `CREATE TRIGGER versions_model_content_frozen BEFORE UPDATE OF content ON version_texts
    WHEN NEW.content IS NOT OLD.content AND EXISTS (
      SELECT 1 FROM versions v WHERE v.seq = OLD.version_seq AND v.writer = 'model' AND v.status <> 'generating'
        AND NOT (v.purged_at IS NOT NULL AND NEW.content = '' AND EXISTS (
          SELECT 1 FROM slots s JOIN chats c ON c.id = s.chat_id
            JOIN bin_items b ON b.user_id = c.owner_user_id AND b.chat_id = c.id
          WHERE s.id = v.slot_id AND (
            (b.id = v.bin_item_id AND b.kind = 'version')
            OR (b.id = s.bin_item_id AND b.kind IN ('message', 'branch', 'threads'))))))
    BEGIN SELECT RAISE(ABORT, 'model-written versions are immutable once generated; create a new version'); END`,
  `CREATE TRIGGER card_names_insert AFTER INSERT ON entity_refs
      WHEN (SELECT kind FROM entities WHERE id = NEW.entity_id) = 'card'
        AND (NEW.label IS NOT coalesce((SELECT json_extract(doc_json, '$.name') FROM entity_revisions WHERE id = NEW.head_revision_id), '')
          OR NEW.subtitle IS NOT coalesce((SELECT json_extract(doc_json, '$.character_version') FROM entity_revisions WHERE id = NEW.head_revision_id), ''))
      BEGIN UPDATE entity_refs SET
        label = coalesce((SELECT json_extract(doc_json, '$.name') FROM entity_revisions WHERE id = NEW.head_revision_id), ''),
        subtitle = coalesce((SELECT json_extract(doc_json, '$.character_version') FROM entity_revisions WHERE id = NEW.head_revision_id), '')
        WHERE id = NEW.id; END`,
  `CREATE TRIGGER card_names_update AFTER UPDATE OF head_revision_id, label, subtitle ON entity_refs
      WHEN (SELECT kind FROM entities WHERE id = NEW.entity_id) = 'card'
        AND (NEW.label IS NOT coalesce((SELECT json_extract(doc_json, '$.name') FROM entity_revisions WHERE id = NEW.head_revision_id), '')
          OR NEW.subtitle IS NOT coalesce((SELECT json_extract(doc_json, '$.character_version') FROM entity_revisions WHERE id = NEW.head_revision_id), ''))
      BEGIN UPDATE entity_refs SET
        label = coalesce((SELECT json_extract(doc_json, '$.name') FROM entity_revisions WHERE id = NEW.head_revision_id), ''),
        subtitle = coalesce((SELECT json_extract(doc_json, '$.character_version') FROM entity_revisions WHERE id = NEW.head_revision_id), '')
        WHERE id = NEW.id; END`,
  `CREATE TABLE chat_pins (user_id TEXT NOT NULL REFERENCES users(id), chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, PRIMARY KEY(user_id, chat_id)) STRICT`,
  `CREATE INDEX chats_owner_live ON chats(owner_user_id, id) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX slots_chain ON slots(chain_id, depth)`,
  // Overridden shell paths use the same metadata as a shared tree, by chain range.
  // Keep the separate unique chain/depth constraint intact.
  `CREATE INDEX slots_shell_chain ON slots(chain_id, depth, id, chat_id, parent_slot_id, created_at, deleted_at, purged_at, selected_version_id)`,
  `CREATE INDEX slots_chain_cover ON slots(chain_id, depth, id, parent_slot_id)`,
  `CREATE INDEX versions_lcm_inputs ON versions(id, slot_id, status, content_length, deleted_at, purged_at)`,
  `CREATE INDEX state_events_chain ON state_events(chat_id, slot_chain_id, slot_depth)`,
  `CREATE TRIGGER slots_chain_assigned AFTER INSERT ON slots BEGIN
    UPDATE slots SET chain_id = coalesce(
      (SELECT p.chain_id FROM slots p WHERE p.id = NEW.parent_slot_id AND p.chat_id = NEW.chat_id
        AND NOT EXISTS (SELECT 1 FROM slots c WHERE c.chain_id = p.chain_id AND c.depth = NEW.depth AND c.id <> NEW.id)),
      NEW.id)
    WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER slots_chain_fixed BEFORE UPDATE OF chain_id ON slots
    WHEN OLD.chain_id IS NOT NULL AND NEW.chain_id IS NOT OLD.chain_id
    BEGIN SELECT RAISE(ABORT, 'a slot keeps the chain it was inserted in'); END`,
  `CREATE TRIGGER state_events_chain_unplaced BEFORE INSERT ON state_events
    WHEN NEW.slot_id IS NULL AND (NEW.slot_chain_id IS NOT NULL OR NEW.slot_depth IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'a chat-wide state event has no chain'); END`,
  `CREATE TRIGGER state_events_chain_assigned AFTER INSERT ON state_events WHEN NEW.slot_id IS NOT NULL BEGIN
    UPDATE state_events SET slot_chain_id = (SELECT chain_id FROM slots WHERE id = NEW.slot_id),
      slot_depth = (SELECT depth FROM slots WHERE id = NEW.slot_id)
    WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER state_events_chain_fixed BEFORE UPDATE OF slot_chain_id, slot_depth ON state_events
    WHEN (OLD.slot_chain_id IS NOT NULL OR OLD.slot_depth IS NOT NULL)
      AND (NEW.slot_chain_id IS NOT OLD.slot_chain_id OR NEW.slot_depth IS NOT OLD.slot_depth)
    BEGIN SELECT RAISE(ABORT, 'a state event keeps the chain and depth of its slot'); END`,
  `CREATE TABLE forks (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- The fork it was made from; null for a chat's first. Its place in the fork tree is in fork_labels.
    parent_fork_id TEXT REFERENCES forks(id) DEFERRABLE INITIALLY DEFERRED,
    split_chat INTEGER NOT NULL DEFAULT 0 CHECK (split_chat IN (0, 1)),
    -- The picture of the chat split off at this fork (split_chat = 1); the original chat's is chats.cover_media_id.
    cover_media_id TEXT REFERENCES media_assets(id),
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
  `CREATE INDEX chats_current_fork ON chats(current_fork_id) WHERE current_fork_id IS NOT NULL`,
  `CREATE INDEX slots_fork ON slots(fork_id) WHERE fork_id IS NOT NULL`,
  `CREATE INDEX rollouts_fork ON rollouts(fork_id) WHERE fork_id IS NOT NULL`,
  `CREATE INDEX queued_messages_fork ON queued_messages(fork_id) WHERE fork_id IS NOT NULL`,
  `CREATE TRIGGER chats_first_fork AFTER INSERT ON chats BEGIN
    INSERT INTO forks (id, chat_id, tip_slot_id, created_at)
      VALUES (NEW.id, NEW.id, NEW.active_leaf_slot_id, NEW.created_at);
    UPDATE chats SET current_fork_id = NEW.id WHERE id = NEW.id;
  END`,
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
  `CREATE TRIGGER forks_chat_fixed BEFORE UPDATE OF chat_id ON forks
    WHEN NEW.chat_id IS NOT OLD.chat_id
    BEGIN SELECT RAISE(ABORT, 'forks rows never move to another chat'); END`,
  `CREATE TRIGGER forks_same_chat BEFORE INSERT ON forks
    WHEN (NEW.parent_fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.parent_fork_id) IS NOT NEW.chat_id)
      OR (NEW.base_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.base_slot_id) IS NOT NEW.chat_id)
      OR (NEW.tip_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.tip_slot_id) IS NOT NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a fork''s parent, base and tip are in its chat'); END`,
  `CREATE TRIGGER forks_same_chat_update BEFORE UPDATE OF parent_fork_id, base_slot_id, tip_slot_id ON forks
    WHEN (NEW.parent_fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.parent_fork_id) IS NOT NEW.chat_id)
      OR (NEW.base_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.base_slot_id) IS NOT NEW.chat_id)
      OR (NEW.tip_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.tip_slot_id) IS NOT NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a fork''s parent, base and tip are in its chat'); END`,
  `CREATE TRIGGER forks_origin_fixed BEFORE UPDATE OF parent_fork_id, base_slot_id, branched_at ON forks
    WHEN NEW.parent_fork_id IS NOT OLD.parent_fork_id OR NEW.base_slot_id IS NOT OLD.base_slot_id
      OR NEW.branched_at IS NOT OLD.branched_at
    BEGIN SELECT RAISE(ABORT, 'a fork keeps the parent, base and moment it was made at'); END`,
  `CREATE TRIGGER chats_current_fork_own BEFORE UPDATE OF current_fork_id ON chats
    WHEN NEW.current_fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.current_fork_id) IS NOT NEW.id
    BEGIN SELECT RAISE(ABORT, 'a chat''s current fork is one of its forks'); END`,
  `CREATE TRIGGER slots_fork_same_chat BEFORE INSERT ON slots
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a slot''s fork is in its chat'); END`,
  `CREATE TRIGGER slots_fork_same_chat_update BEFORE UPDATE OF fork_id ON slots
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a slot''s fork is in its chat'); END`,
  `CREATE TRIGGER rollouts_fork_same_chat BEFORE INSERT ON rollouts
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a rollout''s fork is in its chat'); END`,
  `CREATE TRIGGER rollouts_fork_same_chat_update BEFORE UPDATE OF fork_id ON rollouts
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a rollout''s fork is in its chat'); END`,
  `CREATE TRIGGER queued_messages_fork_same_chat BEFORE INSERT ON queued_messages
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a queued message''s fork is in its chat'); END`,
  `CREATE TRIGGER queued_messages_fork_same_chat_update BEFORE UPDATE OF fork_id ON queued_messages
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a queued message''s fork is in its chat'); END`,
  `CREATE TABLE fork_overrides (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    fork_id TEXT NOT NULL REFERENCES forks(id) ON DELETE CASCADE,
    -- The chat's state_seq when written; a row updated in place takes the newer one.
    seq INTEGER NOT NULL CHECK (seq > 0),
    kind TEXT NOT NULL,
    -- image_exclude: the message's own version and an image of it, "<version id>:<media id>".
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
    origin TEXT NOT NULL DEFAULT 'user'
  ) STRICT`,
  `CREATE INDEX fork_overrides_chat ON fork_overrides(chat_id, kind)`,
  `CREATE INDEX fork_overrides_point ON fork_overrides(fork_id, kind, target_id, seq)`,
  `CREATE INDEX fork_overrides_window ON fork_overrides(fork_id, slot_depth, seq)`,
  `CREATE INDEX fork_overrides_target ON fork_overrides(target_id, kind, value_id)`,
  `CREATE INDEX fork_overrides_bin_item ON fork_overrides(bin_item_id) WHERE bin_item_id IS NOT NULL`,
  `CREATE INDEX fork_overrides_changeset ON fork_overrides(changeset_id) WHERE changeset_id IS NOT NULL`,
  `CREATE TRIGGER fork_overrides_same_chat BEFORE INSERT ON fork_overrides
    WHEN (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
      OR (NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'an override is in its fork''s chat'); END`,
  `CREATE TRIGGER fork_overrides_select_own_version BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'select'
    AND (NEW.slot_id IS NOT NEW.target_id OR NEW.slot_depth IS NOT (SELECT depth FROM slots WHERE id = NEW.target_id)
      OR (SELECT slot_id FROM versions WHERE id = NEW.value_id) IS NOT NEW.target_id)
    BEGIN SELECT RAISE(ABORT, 'a selection names a version of its slot'); END`,
  `CREATE TRIGGER fork_overrides_select_update_own_version BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind = 'select' AND (SELECT slot_id FROM versions WHERE id = NEW.value_id) IS NOT NEW.target_id
    BEGIN SELECT RAISE(ABORT, 'a selection names a version of its slot'); END`,
  `CREATE TRIGGER fork_overrides_identity_fixed BEFORE UPDATE OF id, chat_id, fork_id, kind, target_id, slot_id, slot_depth
    ON fork_overrides BEGIN SELECT RAISE(ABORT, 'an override keeps its fork, kind and target'); END`,
  `CREATE TRIGGER fork_overrides_seq_forward BEFORE UPDATE OF seq ON fork_overrides WHEN NEW.seq < OLD.seq
    BEGIN SELECT RAISE(ABORT, 'an override''s seq only moves forward'); END`,
  `CREATE TRIGGER slots_selection_frozen BEFORE UPDATE OF selected_version_id ON slots
    WHEN NEW.selected_version_id IS NOT OLD.selected_version_id
    BEGIN SELECT RAISE(ABORT, 'a slot keeps the selection it was inserted with; a fork selects with an override'); END`,
  `CREATE TRIGGER history_reduced_version AFTER UPDATE OF deleted_at ON versions
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NOT ${namesFork("NEW.bin_item_id")}
    BEGIN
      INSERT INTO history_changes(slot_id, fork_id, chat_id, depth, revision)
        SELECT id, '', chat_id, depth, 1 FROM slots WHERE id = NEW.slot_id AND (selected_version_id = NEW.id
          OR EXISTS (SELECT 1 FROM fork_overrides o WHERE o.target_id = NEW.slot_id AND o.kind = 'select'
            AND o.value_id = NEW.id))
      ON CONFLICT(slot_id, fork_id, seq) DO UPDATE SET revision = revision + 1;
    END`,
  `CREATE INDEX versions_fork ON versions(fork_id) WHERE fork_id IS NOT NULL`,
  `CREATE TRIGGER versions_fork_copy BEFORE INSERT ON versions WHEN NEW.fork_id IS NOT NULL
    AND ((SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT (SELECT chat_id FROM slots WHERE id = NEW.slot_id)
      OR NOT EXISTS (SELECT 1 FROM versions o WHERE o.id = NEW.source_version_id AND o.slot_id = NEW.slot_id
        AND o.fork_id IS NULL))
    BEGIN SELECT RAISE(ABORT, 'a fork''s own version is in its chat and stands in for one of its message''s own'); END`,
  `CREATE TRIGGER versions_fork_fixed BEFORE UPDATE OF fork_id ON versions WHEN NEW.fork_id IS NOT OLD.fork_id
    BEGIN SELECT RAISE(ABORT, 'a version keeps its fork'); END`,
  `CREATE TRIGGER versions_flags_frozen BEFORE UPDATE OF starred, hidden ON versions
    WHEN NEW.starred IS NOT OLD.starred OR NEW.hidden IS NOT OLD.hidden
    BEGIN SELECT RAISE(ABORT, 'a version keeps the flags it was inserted with; a fork sets them with an override'); END`,
  `CREATE TRIGGER fork_overrides_replace_own BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'replace'
    AND (NOT EXISTS (SELECT 1 FROM versions o JOIN slots s ON s.id = o.slot_id WHERE o.id = NEW.target_id
        AND o.fork_id IS NULL AND s.id = NEW.slot_id AND s.depth = NEW.slot_depth)
      OR (NEW.value_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM versions c WHERE c.id = NEW.value_id
        AND c.source_version_id = NEW.target_id AND c.fork_id IS NOT NULL)))
    BEGIN SELECT RAISE(ABORT, 'a replacement stands a copy in for one of its message''s own versions'); END`,
  `CREATE TRIGGER fork_overrides_replace_update_own BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind = 'replace' AND NEW.value_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM versions c
      WHERE c.id = NEW.value_id AND c.source_version_id = NEW.target_id AND c.fork_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'a replacement stands a copy in for one of its message''s own versions'); END`,
  `CREATE TRIGGER fork_overrides_flag_own BEFORE INSERT ON fork_overrides WHEN NEW.kind IN ('star', 'picker_hide')
    AND (NEW.flag IS NULL OR NEW.value_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM versions o JOIN slots s
      ON s.id = o.slot_id WHERE o.id = NEW.target_id AND o.fork_id IS NULL AND s.id = NEW.slot_id
        AND s.depth = NEW.slot_depth))
    BEGIN SELECT RAISE(ABORT, 'a flag is set on one of its message''s own versions'); END`,
  `CREATE TRIGGER fork_overrides_flag_set BEFORE UPDATE OF flag ON fork_overrides
    WHEN NEW.kind IN ('star', 'picker_hide') AND NEW.flag IS NULL
    BEGIN SELECT RAISE(ABORT, 'a flag is set on one of its message''s own versions'); END`,
  `CREATE TRIGGER fork_overrides_select_message_own BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'select'
    AND (SELECT fork_id FROM versions WHERE id = NEW.value_id) IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a selection names one of its message''s own versions'); END`,
  `CREATE TRIGGER fork_overrides_select_update_message_own BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind = 'select' AND (SELECT fork_id FROM versions WHERE id = NEW.value_id) IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a selection names one of its message''s own versions'); END`,
  `CREATE INDEX entities_forked_from ON entities(forked_from_entity_id) WHERE forked_from_entity_id IS NOT NULL`,
  `CREATE INDEX entities_forked_from_revision ON entities(forked_from_revision_id) WHERE forked_from_revision_id IS NOT NULL`,
  `CREATE INDEX entities_forked_in_chat ON entities(forked_in_chat_id) WHERE forked_in_chat_id IS NOT NULL`,
  `CREATE TRIGGER entities_fork_parent BEFORE INSERT ON entities WHEN NEW.forked_from_entity_id = NEW.id
  OR (NEW.forked_from_entity_id IS NOT NULL AND (
    (SELECT owner_user_id FROM entities WHERE id = NEW.forked_from_entity_id) IS NOT NEW.owner_user_id
    OR (SELECT kind FROM entities WHERE id = NEW.forked_from_entity_id) IS NOT NEW.kind))
  OR (NEW.forked_from_revision_id IS NOT NULL
    AND (SELECT entity_id FROM entity_revisions WHERE id = NEW.forked_from_revision_id) IS NOT NEW.forked_from_entity_id)
  OR (NEW.forked_in_chat_id IS NOT NULL
    AND (SELECT owner_user_id FROM chats WHERE id = NEW.forked_in_chat_id) IS NOT NEW.owner_user_id) BEGIN SELECT RAISE(ABORT, 'a fork''s parent is another entity of its owner and kind, its revision the parent''s, its chat its owner''s'); END`,
  `CREATE TRIGGER entities_fork_parent_update
    BEFORE UPDATE OF forked_from_entity_id, forked_from_revision_id, forked_in_chat_id, kind ON entities
    WHEN NEW.forked_from_entity_id = NEW.id
  OR (NEW.forked_from_entity_id IS NOT NULL AND (
    (SELECT owner_user_id FROM entities WHERE id = NEW.forked_from_entity_id) IS NOT NEW.owner_user_id
    OR (SELECT kind FROM entities WHERE id = NEW.forked_from_entity_id) IS NOT NEW.kind))
  OR (NEW.forked_from_revision_id IS NOT NULL
    AND (SELECT entity_id FROM entity_revisions WHERE id = NEW.forked_from_revision_id) IS NOT NEW.forked_from_entity_id)
  OR (NEW.forked_in_chat_id IS NOT NULL
    AND (SELECT owner_user_id FROM chats WHERE id = NEW.forked_in_chat_id) IS NOT NEW.owner_user_id) BEGIN SELECT RAISE(ABORT, 'a fork''s parent is another entity of its owner and kind, its revision the parent''s, its chat its owner''s'); END`,
  `CREATE TRIGGER slots_deletion_per_fork BEFORE UPDATE OF deleted_at ON slots
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NOT ${namesFork("NEW.bin_item_id")}
    BEGIN ${raise("a slot is deleted in a fork with an override, or marked under the bin item of a deletion in a fork")}; END`,
  `CREATE TRIGGER versions_deletion_per_fork BEFORE UPDATE OF deleted_at ON versions
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NOT ${namesFork("NEW.bin_item_id")}
    BEGIN ${raise("a version is deleted in a fork with an override, or marked under the bin item of a deletion in a fork")}; END`,
  `CREATE TRIGGER slots_hide_frozen BEFORE UPDATE OF context_excluded, hidden_by_user ON slots
    WHEN NEW.context_excluded IS NOT OLD.context_excluded OR NEW.hidden_by_user IS NOT OLD.hidden_by_user
    BEGIN ${raise("a slot keeps the visibility it was inserted with; a fork hides with an override")}; END`,

  `CREATE TRIGGER fork_overrides_slot_kinds BEFORE INSERT ON fork_overrides WHEN NEW.kind IN ('delete_slot', 'hide')
    AND (NEW.flag IS NULL OR NEW.slot_id IS NOT NEW.target_id
      OR NEW.slot_depth IS NOT (SELECT depth FROM slots WHERE id = NEW.target_id))
    BEGIN ${raise("a deletion or hide has a flag and names its slot")}; END`,
  `CREATE TRIGGER fork_overrides_hide_range BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'hide_range'
    AND (NEW.flag IS NOT 0 OR NEW.slot_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM lcm_enable_runs r WHERE r.id = NEW.target_id AND r.chat_id = NEW.chat_id))
    BEGIN ${raise("a visibility range names its chat's enable run and shows it")}; END`,
  `CREATE TRIGGER slots_inserted_frozen BEFORE UPDATE OF inserted ON slots WHEN NEW.inserted IS NOT OLD.inserted
    BEGIN ${raise("a slot stays inserted or not as it was inserted")}; END`,
  `CREATE TRIGGER fork_overrides_insert BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'insert'
    AND (NEW.flag IS NULL OR NEW.value_id IS NOT NULL OR NEW.bin_item_id IS NOT NULL OR NEW.changeset_id IS NOT NULL
      OR NEW.slot_depth IS NOT (SELECT depth FROM slots WHERE id = NEW.slot_id)
      OR NOT EXISTS (SELECT 1 FROM slots x WHERE x.id = NEW.target_id AND x.chat_id = NEW.chat_id AND x.inserted = 1
        AND x.parent_slot_id IS NEW.slot_id))
    BEGIN ${raise("an insertion places an inserted slot of its chat below its parent")}; END`,
  `CREATE TRIGGER fork_overrides_insert_update BEFORE UPDATE OF flag, value_id, bin_item_id, changeset_id ON fork_overrides
    WHEN NEW.kind = 'insert' AND (NEW.flag IS NULL OR NEW.value_id IS NOT NULL OR NEW.bin_item_id IS NOT NULL
      OR NEW.changeset_id IS NOT NULL)
    BEGIN ${raise("an insertion places an inserted slot of its chat below its parent")}; END`,
  // A move (owner, 2026-11-16: moving a message up or down changes the story order, in that
  // branch only): slot_id is the moved slot itself (target_id) at its depth; value_id is the
  // slot it now follows on the branch's display path (null: above the first message), or itself
  // to leave it out of the branch (a fork made above where its parent moved it down:
  // forkOrder.ts); flag 1 shows it there, 0 at its own place; no bin item or changeset.
  `CREATE TRIGGER fork_overrides_move BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'move'
    AND (NEW.flag IS NULL OR NEW.bin_item_id IS NOT NULL OR NEW.changeset_id IS NOT NULL
      OR NEW.slot_id IS NOT NEW.target_id
      OR NEW.slot_depth IS NOT (SELECT depth FROM slots WHERE id = NEW.target_id)
      OR NOT EXISTS (SELECT 1 FROM slots x WHERE x.id = NEW.target_id AND x.chat_id = NEW.chat_id)
      OR (NEW.value_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM slots a WHERE a.id = NEW.value_id
        AND a.chat_id = NEW.chat_id))
      OR (NEW.flag = 0 AND NEW.value_id IS NOT NULL))
    BEGIN ${raise("a move shows a slot of its chat after one of its slots, at its own place, or leaves it out")}; END`,
  `CREATE TRIGGER fork_overrides_move_update BEFORE UPDATE OF flag, value_id, bin_item_id, changeset_id ON fork_overrides
    WHEN NEW.kind = 'move' AND (NEW.flag IS NULL OR NEW.bin_item_id IS NOT NULL OR NEW.changeset_id IS NOT NULL
      OR (NEW.flag = 0 AND NEW.value_id IS NOT NULL)
      OR (NEW.value_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM slots a WHERE a.id = NEW.value_id
        AND a.chat_id = NEW.chat_id)))
    BEGIN ${raise("a move shows a slot of its chat after one of its slots, at its own place, or leaves it out")}; END`,
  `CREATE TRIGGER fork_overrides_delete_version_own BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'delete_version'
    AND (NEW.flag IS NULL OR NOT EXISTS (SELECT 1 FROM versions o JOIN slots s ON s.id = o.slot_id
      WHERE o.id = NEW.target_id AND o.fork_id IS NULL AND s.id = NEW.slot_id AND s.depth = NEW.slot_depth))
    BEGIN ${raise("a deleted swipe is one of its message's own versions")}; END`,
  `CREATE INDEX state_events_fork ON state_events(fork_id, fork_seq) WHERE fork_id IS NOT NULL`,
  `CREATE TRIGGER state_events_fork_same_chat BEFORE INSERT ON state_events
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id = NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a state event belongs to a fork of its chat'); END`,
  `CREATE TRIGGER fork_overrides_event_own BEFORE INSERT ON fork_overrides WHEN NEW.kind = 'suppress_event'
    AND (NEW.flag IS NULL OR NOT EXISTS (SELECT 1 FROM state_events e
      WHERE e.id = NEW.target_id AND e.chat_id = NEW.chat_id AND e.slot_id IS NEW.slot_id))
    BEGIN SELECT RAISE(ABORT, 'a suppression names an event in its chat'); END`,
  `CREATE TRIGGER summaries_selection_frozen BEFORE UPDATE OF selected_revision_id ON summaries
    WHEN NEW.selected_revision_id IS NOT OLD.selected_revision_id
    BEGIN SELECT RAISE(ABORT, 'summary selections belong to a fork'); END`,
  `CREATE TRIGGER summarization_jobs_fork_same_chat BEFORE INSERT ON summarization_jobs
    WHEN NEW.fork_id IS NOT NULL AND (SELECT chat_id FROM forks WHERE id=NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'summary jobs belong to a fork of their chat'); END`,
  `CREATE TRIGGER summarization_jobs_fork_fixed BEFORE UPDATE OF fork_id ON summarization_jobs
    WHEN NEW.fork_id IS NOT OLD.fork_id BEGIN SELECT RAISE(ABORT, 'summary jobs keep their fork'); END`,
  `CREATE UNIQUE INDEX summarization_jobs_legacy_segment ON summarization_jobs(chat_id,first_slot_id,last_slot_id,level)
    WHERE fork_id IS NULL AND status IN ('pending','processing')`,
  `CREATE TRIGGER fork_overrides_summary_target BEFORE INSERT ON fork_overrides
    WHEN NEW.kind IN ('summary_revision','summary_choice','summary_superseded') AND NOT EXISTS (
      SELECT 1 FROM summaries s WHERE s.id=NEW.target_id AND s.chat_id=NEW.chat_id AND s.first_slot_id=NEW.slot_id)
    BEGIN SELECT RAISE(ABORT, 'a summary override names a summary in its chat'); END`,
  `CREATE TRIGGER fork_overrides_summary_revision BEFORE INSERT ON fork_overrides
    WHEN NEW.kind='summary_revision' AND NOT EXISTS (
      SELECT 1 FROM summary_revisions r WHERE r.id=NEW.value_id AND r.summary_id=NEW.target_id)
    BEGIN SELECT RAISE(ABORT, 'a summary selection names its own revision'); END`,
  `CREATE TRIGGER fork_overrides_summary_revision_update BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind='summary_revision' AND NOT EXISTS (
      SELECT 1 FROM summary_revisions r WHERE r.id=NEW.value_id AND r.summary_id=NEW.target_id)
    BEGIN SELECT RAISE(ABORT, 'a summary selection names its own revision'); END`,
  `CREATE TRIGGER fork_overrides_summary_choice BEFORE INSERT ON fork_overrides
    WHEN NEW.kind IN ('summary_choice','summary_superseded') AND NOT EXISTS (
      SELECT 1 FROM summaries s WHERE s.id=NEW.value_id AND s.chat_id=NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a summary choice stays in its chat'); END`,
  `CREATE TRIGGER fork_overrides_summary_choice_update BEFORE UPDATE OF value_id ON fork_overrides
    WHEN NEW.kind IN ('summary_choice','summary_superseded') AND NOT EXISTS (
      SELECT 1 FROM summaries s WHERE s.id=NEW.value_id AND s.chat_id=NEW.chat_id)
    BEGIN SELECT RAISE(ABORT, 'a summary choice stays in its chat'); END`,
  `CREATE TRIGGER fork_overrides_summary_rerun BEFORE INSERT ON fork_overrides
    WHEN NEW.kind='summary_rerun' AND (NEW.flag IS NULL OR (NEW.flag=1 AND NOT EXISTS (
      SELECT 1 FROM summary_reruns r WHERE r.id=NEW.value_id AND r.chat_id=NEW.chat_id
        AND coalesce(r.summary_id,r.job_id)=NEW.target_id)))
    BEGIN SELECT RAISE(ABORT, 'a summary request names its own target'); END`,
  `CREATE TRIGGER fork_overrides_summary_rerun_update BEFORE UPDATE OF value_id,flag ON fork_overrides
    WHEN NEW.kind='summary_rerun' AND (NEW.flag IS NULL OR (NEW.flag=1 AND NOT EXISTS (
      SELECT 1 FROM summary_reruns r WHERE r.id=NEW.value_id AND r.chat_id=NEW.chat_id
        AND coalesce(r.summary_id,r.job_id)=NEW.target_id)))
    BEGIN SELECT RAISE(ABORT, 'a summary request names its own target'); END`,
  `CREATE TRIGGER lcm_reply_maintenance_fork BEFORE INSERT ON lcm_reply_maintenance
    WHEN (SELECT chat_id FROM forks WHERE id=NEW.fork_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'maintenance belongs to a fork of its chat'); END`,
  // A merge of another chat into this one (spec/CHAT-MERGE.md §2): its join message (slot_id),
  // and its second parent, recorded softly: the source columns name another fork or chat and
  // have no foreign key, so deleting the source never blocks or changes the destination.
  `CREATE TABLE chat_merges (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
    fork_id TEXT,
    source_chat_id TEXT,
    source_fork_id TEXT,
    source_tip_slot_id TEXT,
    base_slot_id TEXT,
    start_slot_id TEXT,
    title TEXT NOT NULL,
    framing TEXT,
    cast_json TEXT NOT NULL CHECK (json_valid(cast_json) AND json_type(cast_json) = 'array'),
    counts_json TEXT NOT NULL CHECK (json_valid(counts_json) AND json_type(counts_json) = 'object'),
    created_at INTEGER NOT NULL,
    -- How the characters read the joined line (spec/THREADS.md §7.3): 'together' (one transcript
    -- for everyone) or 'separate'; a registered storage kind, frozen with the row.
    timelines TEXT NOT NULL DEFAULT 'together',
    -- Soft: the thread split whose thread this joins, when the source is one (§4.1).
    split_id TEXT,
    -- The slot immediately before a separate join's destination stretch; NULL: path start.
    -- Resolve the live display interval after it through J, including later insertions.
    stretch_before_slot_id TEXT
  ) STRICT`,
  `CREATE INDEX chat_merges_chat ON chat_merges(chat_id)`,
  `CREATE INDEX chat_merges_source_fork ON chat_merges(chat_id, source_fork_id)`,
  `CREATE TRIGGER chat_merges_same_chat BEFORE INSERT ON chat_merges
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'a merge''s join message is in its chat'); END`,
  `CREATE TRIGGER chat_merges_frozen BEFORE UPDATE ON chat_merges
    BEGIN SELECT RAISE(ABORT, 'a merge never changes'); END`,
  `CREATE TABLE chat_merge_messages (
    merge_id TEXT NOT NULL REFERENCES chat_merges(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'summary')),
    source_slot_id TEXT,
    speaker_entity_id TEXT,
    speaker_name TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('user', 'assistant')),
    content TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    included TEXT NOT NULL CHECK (included IN ('verbatim', 'summarized', 'left_out')),
    -- The cards that knew this source message in the source (its version's knowers,
    -- spec/CHARACTER-CONTEXT.md §9.1); NULL for summaries and messages with no cast recorded.
    knowers_json TEXT CHECK (knowers_json IS NULL OR (json_valid(knowers_json) AND json_type(knowers_json) = 'array')),
    -- Soft: the version copied, beside source_slot_id (spec/THREADS.md §4.1).
    source_version_id TEXT,
    -- The copied version's image media ids; NULL when it had none.
    media_json TEXT CHECK (media_json IS NULL OR (json_valid(media_json) AND json_type(media_json) = 'array')),
    -- Where it was in the source, as zero-based display positions: a message's own, a summary's
    -- first and last (the agent's read tools name a joined row by it, spec/THREADS.md §11).
    source_from INTEGER,
    source_to INTEGER,
    PRIMARY KEY (merge_id, ordinal)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TRIGGER chat_merge_messages_frozen BEFORE UPDATE ON chat_merge_messages
    BEGIN SELECT RAISE(ABORT, 'a merged message never changes'); END`,
  // Search and replace across the library (db/libraryReplace.ts): one changeset group per
  // replace, and here each entry it changed, the revision before and the one it wrote, so the
  // whole replace is undone at once where nothing changed the entry since.
  `CREATE TABLE library_edit_items (
    id INTEGER PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES changeset_groups(id) ON DELETE CASCADE,
    ref_id TEXT NOT NULL REFERENCES entity_refs(id) ON DELETE CASCADE,
    before_revision_id TEXT NOT NULL REFERENCES entity_revisions(id) ON DELETE CASCADE,
    after_revision_id TEXT NOT NULL REFERENCES entity_revisions(id) ON DELETE CASCADE,
    matches INTEGER NOT NULL CHECK (matches > 0),
    undone_by_revision_id TEXT REFERENCES entity_revisions(id) ON DELETE SET NULL,
    UNIQUE (group_id, ref_id),
    CHECK (before_revision_id <> after_revision_id)
  ) STRICT`,
  `CREATE INDEX library_edit_items_group ON library_edit_items(group_id)`,
  `CREATE INDEX library_edit_items_ref ON library_edit_items(ref_id)`,
  `CREATE INDEX library_edit_items_before ON library_edit_items(before_revision_id)`,
  `CREATE INDEX library_edit_items_after ON library_edit_items(after_revision_id)`,
  `CREATE INDEX library_edit_items_undone ON library_edit_items(undone_by_revision_id) WHERE undone_by_revision_id IS NOT NULL`,
  `CREATE TRIGGER library_edit_items_valid BEFORE INSERT ON library_edit_items WHEN NOT EXISTS (
    SELECT 1 FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      JOIN changeset_groups g ON g.id = NEW.group_id
      JOIN entity_revisions b ON b.id = NEW.before_revision_id AND b.entity_id = e.id
      JOIN entity_revisions a ON a.id = NEW.after_revision_id AND a.entity_id = e.id
    WHERE r.id = NEW.ref_id AND g.owner_user_id = e.owner_user_id)
    BEGIN ${raise("library edit revisions and group must belong to the entry's owner")}; END`,
  `CREATE TRIGGER library_edit_items_frozen BEFORE UPDATE OF id, group_id, ref_id, before_revision_id, after_revision_id, matches ON library_edit_items
    BEGIN ${raise("a library edit's membership never changes")}; END`,
  ...["INSERT", "UPDATE OF undone_by_revision_id"].map(
    (event, i) =>
      `CREATE TRIGGER library_edit_items_undo_${i} BEFORE ${event} ON library_edit_items
      WHEN NEW.undone_by_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM entity_refs r JOIN entity_revisions v ON v.entity_id = r.entity_id
        WHERE r.id = NEW.ref_id AND v.id = NEW.undone_by_revision_id)
      BEGIN ${raise("a library edit's undo revision must belong to its entry")}; END`
  ),
  `CREATE TRIGGER library_edit_groups_owner_fixed BEFORE UPDATE OF owner_user_id ON changeset_groups
    WHEN NEW.owner_user_id IS NOT OLD.owner_user_id AND EXISTS (SELECT 1 FROM library_edit_items WHERE group_id = OLD.id)
    BEGIN ${raise("a library edit's owner never changes")}; END`,
  ...forkLabelSchema,
  ...threadSchema,
  ...shellSummaries,
  ...lcmStamp,
  ...mcpSchema
]
