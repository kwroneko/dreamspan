// Invariants enforced by the database itself (DATA-MODEL.md §15), so no code path,
// present or future, can break them. Each trigger names the invariant it protects.

const raise = (message: string) => `SELECT RAISE(ABORT, '${message.replaceAll("'", "''")}')`

/** Hard deletes are only for pending chats (garbage collection of lazy chats). */
const chatIsLive = (chatIdExpr: string) =>
  `(SELECT status FROM chats WHERE id = ${chatIdExpr}) IN ('active', 'archived')`

export const integrity = [
  // --- Nothing is ever lost (invariant 1) -----------------------------------------

  `CREATE TRIGGER users_no_delete BEFORE DELETE ON users
    BEGIN ${raise("users are disabled, never deleted")}; END`,

  `CREATE TRIGGER chats_no_delete BEFORE DELETE ON chats WHEN OLD.status <> 'pending'
    BEGIN ${raise("only pending chats can be deleted; archive instead")}; END`,

  `CREATE TRIGGER slots_no_delete BEFORE DELETE ON slots WHEN ${chatIsLive("OLD.chat_id")}
    BEGIN ${raise("slots are never deleted")}; END`,

  `CREATE TRIGGER versions_no_delete BEFORE DELETE ON versions
    WHEN ${chatIsLive("(SELECT chat_id FROM slots WHERE id = OLD.slot_id)")}
    BEGIN ${raise("versions are hidden, never deleted")}; END`,

  `CREATE TRIGGER state_events_no_delete BEFORE DELETE ON state_events WHEN ${chatIsLive("OLD.chat_id")}
    BEGIN ${raise("state events are superseded, never deleted")}; END`,

  `CREATE TRIGGER rollouts_no_delete BEFORE DELETE ON rollouts WHEN ${chatIsLive("OLD.chat_id")}
    BEGIN ${raise("rollouts are discarded, never deleted")}; END`,

  `CREATE TRIGGER summaries_no_delete BEFORE DELETE ON summaries WHEN ${chatIsLive("OLD.chat_id")}
    BEGIN ${raise("summaries are superseded, never deleted")}; END`,

  `CREATE TRIGGER entity_revisions_immutable BEFORE UPDATE ON entity_revisions
    BEGIN ${raise("entity revisions are immutable")}; END`,
  `CREATE TRIGGER entity_revisions_no_delete BEFORE DELETE ON entity_revisions
    BEGIN ${raise("entity revisions are never deleted")}; END`,
  `CREATE TRIGGER entities_no_delete BEFORE DELETE ON entities
    BEGIN ${raise("entities are archived, never deleted")}; END`,

  `CREATE TRIGGER summary_revisions_immutable BEFORE UPDATE ON summary_revisions
    BEGIN ${raise("summary revisions are immutable")}; END`,

  // The frozen context snapshot is what a rollout was generated from (invariant 6).
  `CREATE TRIGGER rollout_snapshot_frozen BEFORE UPDATE OF context_snapshot_json ON rollout_payloads
    WHEN OLD.context_snapshot_json IS NOT NULL AND NEW.context_snapshot_json IS NOT OLD.context_snapshot_json
    BEGIN ${raise("a rollout context snapshot is frozen once written")}; END`,

  // Model output is immutable once generation ends. A user-written version may be
  // amended, and its previous content is kept automatically (DESIGN §3.1).
  `CREATE TRIGGER versions_model_content_frozen BEFORE UPDATE OF content ON versions
    WHEN OLD.writer = 'model' AND OLD.status <> 'generating' AND NEW.content IS NOT OLD.content
    BEGIN ${raise("model-written versions are immutable once generated; create a new version")}; END`,
  `CREATE TRIGGER versions_amend_history AFTER UPDATE OF content ON versions
    WHEN OLD.writer = 'human' AND OLD.status <> 'generating' AND NEW.content IS NOT OLD.content
    BEGIN
      INSERT INTO version_history (version_id, content, replaced_at) VALUES (OLD.id, OLD.content, NEW.updated_at);
    END`,
  `CREATE TRIGGER versions_identity_fixed BEFORE UPDATE OF id, slot_id, ordinal, writer, origin ON versions
    WHEN NEW.id IS NOT OLD.id OR NEW.slot_id IS NOT OLD.slot_id OR NEW.ordinal IS NOT OLD.ordinal
      OR NEW.writer IS NOT OLD.writer OR NEW.origin IS NOT OLD.origin
    BEGIN ${raise("a version's identity, slot, writer and origin never change")}; END`,

  `CREATE TRIGGER state_events_immutable BEFORE UPDATE OF chat_id, slot_id, version_id, seq, key, scope, value_json, origin ON state_events
    BEGIN ${raise("state events are immutable; supersede them with a changeset")}; END`,

  // --- Graph shape ----------------------------------------------------------------

  `CREATE TRIGGER slots_parent_same_chat BEFORE INSERT ON slots
    WHEN NEW.parent_slot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM slots p WHERE p.id = NEW.parent_slot_id AND p.chat_id = NEW.chat_id AND p.depth + 1 = NEW.depth)
    BEGIN ${raise("a slot's parent must be in the same chat, one level up")}; END`,
  `CREATE TRIGGER slots_lane_same_chat BEFORE INSERT ON slots
    WHEN (SELECT chat_id FROM lanes WHERE id = NEW.lane_id) IS NOT NEW.chat_id
    BEGIN ${raise("a slot's lane must be in the same chat")}; END`,
  `CREATE TRIGGER slots_shape_fixed BEFORE UPDATE OF chat_id, lane_id, parent_slot_id, depth ON slots
    WHEN NEW.chat_id IS NOT OLD.chat_id OR NEW.lane_id IS NOT OLD.lane_id
      OR NEW.parent_slot_id IS NOT OLD.parent_slot_id OR NEW.depth IS NOT OLD.depth
    BEGIN ${raise("the graph is append-only: a slot never moves")}; END`,

  // Invariant 3 depends on this: a slot can only select one of its own versions.
  `CREATE TRIGGER slots_selection_own_version BEFORE INSERT ON slots
    WHEN (SELECT slot_id FROM versions WHERE id = NEW.selected_version_id) IS NOT NEW.id
    BEGIN ${raise("a slot can only select one of its own versions")}; END`,
  `CREATE TRIGGER slots_selection_own_version_update BEFORE UPDATE OF selected_version_id ON slots
    WHEN (SELECT slot_id FROM versions WHERE id = NEW.selected_version_id) IS NOT NEW.id
    BEGIN ${raise("a slot can only select one of its own versions")}; END`,

  `CREATE TRIGGER chats_leaf_own_slot BEFORE UPDATE OF active_leaf_slot_id ON chats
    WHEN NEW.active_leaf_slot_id IS NOT NULL
      AND (SELECT chat_id FROM slots WHERE id = NEW.active_leaf_slot_id) IS NOT NEW.id
    BEGIN ${raise("a chat's active leaf must be one of its slots")}; END`,

  `CREATE TRIGGER state_events_position_valid BEFORE INSERT ON state_events
    WHEN (NEW.slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.slot_id) IS NOT NEW.chat_id)
      OR (NEW.version_id IS NOT NULL AND (SELECT slot_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.slot_id)
    BEGIN ${raise("a state event's slot must be in its chat, and its version in that slot")}; END`,

  `CREATE TRIGGER summaries_selection_own_revision BEFORE UPDATE OF selected_revision_id ON summaries
    WHEN (SELECT summary_id FROM summary_revisions WHERE id = NEW.selected_revision_id) IS NOT NEW.id
    BEGIN ${raise("a summary can only select one of its own revisions")}; END`
]
