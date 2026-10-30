import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { type PathPiece, positionOf, slotPlace } from "./displayPath.ts"

export const previousHistoryStart = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  leaf: string | null
) => sql<{
  slot_id: string | null
  depth: number
  state_json: string | null
  rollout_slot_id: string
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
  SELECT r.history_start_slot_id AS slot_id, r.history_start_depth AS depth, r.slot_id AS rollout_slot_id,
    (SELECT json_extract(context_snapshot_json, '$.historyStart.state') FROM rollout_payloads WHERE rollout_id = r.id) AS state_json
  FROM candidates r
  WHERE r.slot_id IN (SELECT id FROM path)
    AND (r.history_start_slot_id IS NULL OR r.history_start_slot_id IN (SELECT id FROM path))
  ORDER BY r.history_depth DESC, r.id DESC LIMIT 1`

/**
 * The previous history start on the path to `leaf` (`previousHistoryStart`). In a fork with
 * insertions, `shown` is its display path through the leaf (`displayThrough`), and the depth
 * returned is the start's position there (spec/MESSAGE-INSERT.md §3.2), which the assembler
 * compares with the positions it reads; a start at the target itself (no slot) is its
 * rollout's message. The recorded depths stay structural: the candidate walk needs them.
 * Undefined when there's none, or when the start isn't on the display path.
 */
export const previousStartIn = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  leaf: string | null,
  shown: { readonly pieces: ReadonlyArray<PathPiece> } | null
) =>
  Effect.gen(function* () {
    const [row] = yield* previousHistoryStart(sql, userId, chatId, leaf)
    if (row === undefined || shown === null) return row
    const place = yield* slotPlace(sql, chatId, row.slot_id ?? row.rollout_slot_id)
    const position = place === null ? null : positionOf(shown.pieces, place)
    return position === null ? undefined : { ...row, depth: position }
  })
