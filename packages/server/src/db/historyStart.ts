import type { SqlClient } from "effect/sql"

export const previousHistoryStart = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  leaf: string | null
) => sql<{
  slot_id: string | null
  depth: number
}>`
  SELECT r.history_start_slot_id AS slot_id, r.history_start_depth AS depth
  FROM rollouts r INDEXED BY rollouts_history
  WHERE r.chat_id = ${chatId} AND r.history_depth IS NOT NULL
    AND r.history_depth <= (SELECT depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId})
    AND EXISTS (SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL)
    AND EXISTS (
      WITH RECURSIVE path(id, depth) AS (
        SELECT id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId}
        UNION ALL
        SELECT s.parent_slot_id, p.depth - 1 FROM path p JOIN slots s ON s.id = p.id
        WHERE p.depth > min(r.history_depth, r.history_start_depth)
      )
      SELECT 1 FROM path WHERE id = r.slot_id
        AND (r.history_start_slot_id IS NULL OR EXISTS (SELECT 1 FROM path WHERE id = r.history_start_slot_id))
    )
  ORDER BY r.history_depth DESC, r.id DESC LIMIT 1`
