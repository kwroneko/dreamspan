// Migration 0010: closes gaps in the graph's integrity triggers, indexes the foreign keys
// that appends and purges check, and keeps every full-text index in step with deletes.
import { raise } from "./integrity.ts"

/** The chat a row of `table` with id `id` belongs to. */
const chatOf = (table: "slots" | "rollouts" | "summaries" | "changesets" | "versions", id: string) =>
  table === "versions"
    ? `(SELECT s.chat_id FROM versions v JOIN slots s ON s.id = v.slot_id WHERE v.id = ${id})`
    : `(SELECT chat_id FROM ${table} WHERE id = ${id})`

/**
 * `table.column` names a row of `target` in the same chat as the row itself (`ownChat`,
 * NEW.chat_id by default), on insert and on any update that could change either side.
 * A reference into another chat, possibly another user's, would also block that chat's
 * deletion with a foreign-key error.
 */
const sameChat = (
  table: string,
  column: string,
  target: Parameters<typeof chatOf>[0],
  ownChat = "NEW.chat_id",
  ownColumns = ["chat_id"]
) => {
  const when = `WHEN NEW.${column} IS NOT NULL AND ${chatOf(target, `NEW.${column}`)} IS NOT ${ownChat}`
  const message = raise(`${table}.${column} must be in the same chat`)
  return [
    `CREATE TRIGGER ${table}_${column}_same_chat BEFORE INSERT ON ${table} ${when} BEGIN ${message}; END`,
    `CREATE TRIGGER ${table}_${column}_same_chat_update BEFORE UPDATE OF ${[column, ...ownColumns].join(", ")}
      ON ${table} ${when} BEGIN ${message}; END`
  ]
}

export const graphIntegrity = [
  // --- Foreign-key indexes ---------------------------------------------------------
  // SQLite checks a foreign key from the referencing side: without an index there,
  // inserting or deleting a referenced row scans the whole referencing table.
  `CREATE INDEX slots_selected_version ON slots(selected_version_id)`,
  `CREATE INDEX versions_source ON versions(source_version_id) WHERE source_version_id IS NOT NULL`,
  `CREATE INDEX state_events_slot ON state_events(slot_id) WHERE slot_id IS NOT NULL`,
  `CREATE INDEX state_events_version ON state_events(version_id) WHERE version_id IS NOT NULL`,
  `CREATE INDEX summary_inputs_version ON summary_inputs(version_id)`,
  `CREATE INDEX chats_active_leaf ON chats(active_leaf_slot_id) WHERE active_leaf_slot_id IS NOT NULL`,
  `CREATE INDEX rollouts_leaf_slot ON rollouts(leaf_slot_id) WHERE leaf_slot_id IS NOT NULL`,
  `CREATE INDEX summaries_first_slot ON summaries(first_slot_id)`,
  `CREATE INDEX lanes_forked_from ON lanes(forked_from_slot_id) WHERE forked_from_slot_id IS NOT NULL`,
  `CREATE INDEX slot_parents_parent ON slot_parents(parent_slot_id)`,
  `CREATE INDEX summarization_jobs_first_slot ON summarization_jobs(first_slot_id)`,
  `CREATE INDEX summarization_jobs_last_slot ON summarization_jobs(last_slot_id)`,
  `CREATE INDEX slots_lane ON slots(lane_id)`,
  `CREATE INDEX summaries_selected_revision ON summaries(selected_revision_id)`,
  `CREATE INDEX summaries_rollout ON summaries(rollout_id) WHERE rollout_id IS NOT NULL`,
  `CREATE INDEX summarization_jobs_result ON summarization_jobs(result_summary_id) WHERE result_summary_id IS NOT NULL`,
  `CREATE INDEX summarization_jobs_absorbed ON summarization_jobs(absorbed_parent_id) WHERE absorbed_parent_id IS NOT NULL`,
  `CREATE INDEX rollouts_parent ON rollouts(parent_rollout_id) WHERE parent_rollout_id IS NOT NULL`,
  `CREATE INDEX changesets_rollout ON changesets(rollout_id) WHERE rollout_id IS NOT NULL`,
  `CREATE INDEX versions_changeset ON versions(changeset_id) WHERE changeset_id IS NOT NULL`,
  `CREATE INDEX state_events_superseded ON state_events(superseded_by_changeset) WHERE superseded_by_changeset IS NOT NULL`,
  `CREATE INDEX entity_refs_head ON entity_refs(head_revision_id)`,
  `CREATE INDEX entity_refs_merge_base ON entity_refs(merge_base_revision_id) WHERE merge_base_revision_id IS NOT NULL`,
  `CREATE INDEX connections_preset_override ON connections(preset_override_ref_id) WHERE preset_override_ref_id IS NOT NULL`,
  // Draft targets aren't foreign keys, but the cleanup triggers and the composer move
  // look drafts up by target.
  `CREATE INDEX drafts_target ON drafts(target_kind, target_id, field)`,

  // --- Versions ----------------------------------------------------------------------
  // Generation ends once. Going back to 'generating' would reopen model output to
  // rewriting, and let a user-written version be amended without keeping history.
  `CREATE TRIGGER versions_generation_ends_once BEFORE UPDATE OF status ON versions
    WHEN NEW.status = 'generating' AND OLD.status <> 'generating'
    BEGIN ${raise("a version never goes back to generating")}; END`,

  // Model output may be emptied only when it's deleted for good from the recycle bin: by
  // the chat owner's bin item for this version, its message, or a branch of its chat.
  `DROP TRIGGER versions_model_content_frozen`,
  `CREATE TRIGGER versions_model_content_frozen BEFORE UPDATE OF content ON versions
    WHEN OLD.writer = 'model' AND OLD.status <> 'generating' AND NEW.content IS NOT OLD.content
      AND NOT (NEW.purged_at IS NOT NULL AND NEW.content = '' AND EXISTS (
        SELECT 1 FROM slots s JOIN chats c ON c.id = s.chat_id
          JOIN bin_items b ON b.user_id = c.owner_user_id AND b.chat_id = c.id
        WHERE s.id = OLD.slot_id AND (
          (b.id = OLD.bin_item_id AND b.kind = 'version' AND b.target_id = OLD.id)
          OR (b.id = s.bin_item_id AND (b.kind = 'branch' OR (b.kind = 'message' AND b.target_id = s.id))))))
    BEGIN ${raise("model-written versions are immutable once generated; create a new version")}; END`,
  // Deleted for good stays deleted. (Purging a message sets purged_at again on swipes
  // purged before, so only clearing it is refused.)
  `CREATE TRIGGER versions_purge_final BEFORE UPDATE OF purged_at ON versions
    WHEN OLD.purged_at IS NOT NULL AND NEW.purged_at IS NULL
    BEGIN ${raise("a purged version stays purged")}; END`,
  `CREATE TRIGGER slots_purge_final BEFORE UPDATE OF purged_at ON slots
    WHEN OLD.purged_at IS NOT NULL AND NEW.purged_at IS NULL
    BEGIN ${raise("a purged slot stays purged")}; END`,

  // "Edited from #7" names another version of the same slot. References that don't are
  // dropped first: they were never valid.
  `UPDATE versions SET source_version_id = NULL WHERE source_version_id IS NOT NULL
    AND (SELECT s.slot_id FROM versions s WHERE s.id = versions.source_version_id) IS NOT versions.slot_id`,
  `CREATE TRIGGER versions_source_same_slot BEFORE INSERT ON versions
    WHEN NEW.source_version_id IS NOT NULL
      AND (SELECT slot_id FROM versions WHERE id = NEW.source_version_id) IS NOT NEW.slot_id
    BEGIN ${raise("a version's source must be another version of its slot")}; END`,
  `CREATE TRIGGER versions_source_fixed BEFORE UPDATE OF source_version_id ON versions
    WHEN NEW.source_version_id IS NOT NULL AND NEW.source_version_id IS NOT OLD.source_version_id
    BEGIN ${raise("a version's source never changes")}; END`,
  // Deleting a source clears the reference instead of blocking the delete.
  `CREATE TRIGGER versions_source_cleared AFTER DELETE ON versions
    BEGIN UPDATE versions SET source_version_id = NULL WHERE source_version_id = OLD.id; END`,

  // --- References stay inside their chat ---------------------------------------------
  `CREATE TRIGGER chats_leaf_own_slot_insert BEFORE INSERT ON chats
    WHEN NEW.active_leaf_slot_id IS NOT NULL
      AND (SELECT chat_id FROM slots WHERE id = NEW.active_leaf_slot_id) IS NOT NEW.id
    BEGIN ${raise("a chat's active leaf must be one of its slots")}; END`,

  `CREATE TRIGGER summaries_selection_own_revision_insert BEFORE INSERT ON summaries
    WHEN (SELECT summary_id FROM summary_revisions WHERE id = NEW.selected_revision_id) IS NOT NEW.id
    BEGIN ${raise("a summary can only select one of its own revisions")}; END`,

  `CREATE TRIGGER lanes_fork_same_chat BEFORE INSERT ON lanes
    WHEN NEW.forked_from_slot_id IS NOT NULL
      AND (SELECT chat_id FROM slots WHERE id = NEW.forked_from_slot_id) IS NOT NEW.chat_id
    BEGIN ${raise("a lane forks from a slot of its own chat")}; END`,
  `CREATE TRIGGER lanes_fork_same_chat_update BEFORE UPDATE OF chat_id, forked_from_slot_id ON lanes
    WHEN NEW.chat_id IS NOT OLD.chat_id OR (NEW.forked_from_slot_id IS NOT NULL
      AND (SELECT chat_id FROM slots WHERE id = NEW.forked_from_slot_id) IS NOT NEW.chat_id)
    BEGIN ${raise("a lane stays in its chat and forks from a slot of its own chat")}; END`,

  // A merge's parents are in its chat. The graph stays acyclic because a slot gets its
  // merge parents before anything is appended below it: an edge out of a slot that
  // nothing points to yet can't close a cycle. (Triggers can't run the recursive query
  // a general cycle check needs.)
  `CREATE TRIGGER slot_parents_same_chat BEFORE INSERT ON slot_parents
    WHEN (SELECT chat_id FROM slots WHERE id = NEW.parent_slot_id) IS NOT (SELECT chat_id FROM slots WHERE id = NEW.slot_id)
    BEGIN ${raise("a merge parent must be in the same chat")}; END`,
  `CREATE TRIGGER slot_parents_acyclic BEFORE INSERT ON slot_parents
    WHEN NEW.parent_slot_id = NEW.slot_id
      OR EXISTS (SELECT 1 FROM slots WHERE parent_slot_id = NEW.slot_id)
      OR EXISTS (SELECT 1 FROM slot_parents WHERE parent_slot_id = NEW.slot_id)
    BEGIN ${raise("a slot's merge parents are recorded before anything is appended below it")}; END`,
  `CREATE TRIGGER slot_parents_fixed BEFORE UPDATE ON slot_parents
    BEGIN ${raise("the graph is append-only: merge parents never change")}; END`,

  // Rollouts, summaries, summarization jobs and changesets refer only within their chat.
  ...sameChat("rollouts", "slot_id", "slots"),
  ...sameChat("rollouts", "leaf_slot_id", "slots"),
  ...sameChat("rollouts", "parent_rollout_id", "rollouts"),
  ...sameChat("summaries", "first_slot_id", "slots"),
  ...sameChat("summaries", "last_slot_id", "slots"),
  ...sameChat("summaries", "rollout_id", "rollouts"),
  ...sameChat("summary_inputs", "slot_id", "slots", chatOf("summaries", "NEW.summary_id"), ["summary_id"]),
  `CREATE TRIGGER summary_inputs_version_in_slot BEFORE INSERT ON summary_inputs
    WHEN (SELECT slot_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.slot_id
    BEGIN ${raise("a summary input's version must be in its slot")}; END`,
  `CREATE TRIGGER summary_inputs_version_in_slot_update BEFORE UPDATE OF slot_id, version_id ON summary_inputs
    WHEN (SELECT slot_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.slot_id
    BEGIN ${raise("a summary input's version must be in its slot")}; END`,
  ...sameChat("summary_parents", "parent_id", "summaries", chatOf("summaries", "NEW.summary_id"), ["summary_id"]),
  ...sameChat("summarization_jobs", "first_slot_id", "slots"),
  ...sameChat("summarization_jobs", "last_slot_id", "slots"),
  ...sameChat("summarization_jobs", "absorbed_parent_id", "summaries"),
  ...sameChat("summarization_jobs", "result_summary_id", "summaries"),
  ...sameChat("changesets", "rollout_id", "rollouts"),
  ...sameChat("versions", "rollout_id", "rollouts", chatOf("slots", "NEW.slot_id"), ["slot_id"]),
  ...sameChat("versions", "changeset_id", "changesets", chatOf("slots", "NEW.slot_id"), ["slot_id"]),
  ...sameChat("state_events", "superseded_by_changeset", "changesets"),

  // Rows that others refer to never move to another chat: the references would cross
  // chats, and block the other chat's deletion. (Slots, lanes and state events already
  // can't move.) A chat override may only stop being one (PromoteOverride).
  ...["rollouts", "changesets", "summaries", "summarization_jobs", "bin_items"].map(
    (table) => `CREATE TRIGGER ${table}_chat_fixed BEFORE UPDATE OF chat_id ON ${table}
      WHEN NEW.chat_id IS NOT OLD.chat_id
      BEGIN ${raise(`${table} rows never move to another chat`)}; END`
  ),
  `CREATE TRIGGER entity_refs_chat_fixed BEFORE UPDATE OF chat_id ON entity_refs
    WHEN NEW.chat_id IS NOT NULL AND NEW.chat_id IS NOT OLD.chat_id
    BEGIN ${raise("a chat override never moves to another chat")}; END`,

  // What a user owns stays theirs (DESIGN §11): one statement could otherwise hand a
  // chat, card or connection, with everything referring to it, to someone else.
  ...["chats", "entities", "connections"].map(
    (table) => `CREATE TRIGGER ${table}_owner_fixed BEFORE UPDATE OF owner_user_id ON ${table}
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
      BEGIN ${raise(`${table} never change owner`)}; END`
  ),

  // A chat override belongs to an entity of the chat's owner.
  `CREATE TRIGGER entity_refs_chat_owner BEFORE INSERT ON entity_refs
    WHEN NEW.chat_id IS NOT NULL AND (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
      IS NOT (SELECT owner_user_id FROM entities WHERE id = NEW.entity_id)
    BEGIN ${raise("a chat override must be of the chat owner's entity")}; END`,
  `CREATE TRIGGER entity_refs_chat_owner_update BEFORE UPDATE OF chat_id, entity_id ON entity_refs
    WHEN NEW.chat_id IS NOT NULL AND (SELECT owner_user_id FROM chats WHERE id = NEW.chat_id)
      IS NOT (SELECT owner_user_id FROM entities WHERE id = NEW.entity_id)
    BEGIN ${raise("a chat override must be of the chat owner's entity")}; END`,

  // --- Full-text search ----------------------------------------------------------------
  // Without this, a deleted revision's text stayed in the index, and matched whichever
  // row reused its seq next, possibly another user's.
  `CREATE TRIGGER entity_revisions_fts_delete AFTER DELETE ON entity_revisions
    BEGIN INSERT INTO entity_revisions_fts (entity_revisions_fts, rowid, search_text) VALUES ('delete', OLD.seq, OLD.search_text); END`,
  // Drops entries that earlier deletes left behind.
  `INSERT INTO entity_revisions_fts (entity_revisions_fts) VALUES ('rebuild')`
]
