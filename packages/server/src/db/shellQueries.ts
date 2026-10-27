// Shared with the query-plan regressions; executed only in reader workers.
export const shellSlotsQuery = `SELECT s.id, s.depth, s.chat_id, s.parent_slot_id, s.created_at, s.branch_name, s.selected_version_id, s.deleted_at, s.branch_deleted,
        v.speaker_entity_id AS speaker, v.writer, CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END AS at FROM chats c CROSS JOIN slots s ON s.chat_id = c.id JOIN versions v ON v.id = s.selected_version_id
        WHERE c.owner_user_id = ? AND c.deleted_at IS NULL ORDER BY s.depth, s.id`

export const shellEventsQuery = `SELECT e.chat_id, e.slot_id, e.version_id, e.scope, e.key, e.value_json FROM chats c CROSS JOIN state_events e ON e.chat_id = c.id WHERE c.owner_user_id = ? AND c.deleted_at IS NULL AND e.superseded_by_changeset IS NULL ORDER BY e.seq`
