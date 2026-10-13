import type { SqlClient } from "effect/sql"

export const previousHistoryStart = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  leaf: string | null
) => sql<{
  slot_id: string | null
  depth: number
  state_json: string | null
}>`
  WITH RECURSIVE candidates AS MATERIALIZED (
    SELECT r.id, r.slot_id, r.history_start_slot_id, r.history_start_depth, r.history_depth
    FROM rollouts r INDEXED BY rollouts_history
    WHERE r.chat_id = ${chatId} AND r.history_depth IS NOT NULL
      AND r.history_depth <= (SELECT depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId})
      AND EXISTS (SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL)
  ), path(id, depth) AS MATERIALIZED (
    SELECT id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND EXISTS (SELECT 1 FROM candidates)
    UNION ALL
    SELECT s.parent_slot_id, p.depth - 1 FROM path p JOIN slots s ON s.id = p.id
    WHERE p.depth > (SELECT min(min(history_depth, history_start_depth)) FROM candidates)
  )
  SELECT r.history_start_slot_id AS slot_id, r.history_start_depth AS depth,
    (SELECT json_extract(context_snapshot_json, '$.historyStart.state') FROM rollout_payloads WHERE rollout_id = r.id) AS state_json
  FROM candidates r
  WHERE r.slot_id IN (SELECT id FROM path)
    AND (r.history_start_slot_id IS NULL OR r.history_start_slot_id IN (SELECT id FROM path))
  ORDER BY r.history_depth DESC, r.id DESC LIMIT 1`
