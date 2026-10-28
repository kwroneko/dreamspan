import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { nextSeq, shownIn } from "./forkState.ts"

/** Sparse durable reductions; ordinary appends never enter this index. */
export const historyRevision = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  leaf: string | null,
  before: number,
  fork: string | null = null
) => sql<{ revision: number }>`
  WITH RECURSIVE changes AS MATERIALIZED (
    SELECT slot_id, depth, revision FROM history_changes INDEXED BY history_changes_depth
    WHERE chat_id = ${chatId} AND depth < ${before}
      AND (fork_id = '' OR EXISTS (SELECT 1 FROM forks f CROSS JOIN json_each(f.lineage_json) l
        WHERE f.id = ${fork} AND l.value ->> 0 = history_changes.fork_id
          AND history_changes.seq <= coalesce(l.value ->> 1, 9223372036854775807)))
      AND EXISTS (SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL)
  ), path(id, depth) AS MATERIALIZED (
    SELECT id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND EXISTS (SELECT 1 FROM changes)
    UNION ALL
    SELECT s.parent_slot_id, p.depth - 1 FROM path p JOIN slots s ON s.id = p.id
    WHERE p.depth > (SELECT min(depth) FROM changes)
  )
  SELECT coalesce(sum(revision), 0) AS revision FROM changes WHERE slot_id IN (SELECT id FROM path)`

/**
 * Records a reduction of the history at a slot (a hide, a deletion, a shorter text) made in
 * `forkId`, which counts in that fork and the forks made from it afterwards; null: in every
 * fork (a mark on the slot).
 */
export const recordReduction = (sql: SqlClient.SqlClient, slotId: string, forkId: string | null) =>
  Effect.gen(function* () {
    const [slot] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM slots WHERE id = ${slotId}`
    const seq = forkId === null ? 0 : yield* nextSeq(sql, slot!.chat_id)
    yield* sql`INSERT INTO history_changes(slot_id, fork_id, chat_id, depth, revision, seq)
      SELECT id, ${forkId ?? ""}, chat_id, depth, 1, ${seq} FROM slots WHERE id = ${slotId}
      ON CONFLICT(slot_id, fork_id) DO UPDATE SET revision = revision + 1, seq = excluded.seq`
  })

/**
 * A shorter text where a fork shows the slot: the version `forkId` (null: the chat's
 * current fork) shows there (its selection, or the copy standing in for it); with
 * `versionId`, that version, if `forkId` shows it, or with no fork named, if any fork does. Uses the assembler's UTF-16 length, including astral
 * characters and embedded NULs.
 */
export const recordHistoryReduction = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  slotId: string,
  content: string,
  versionId: string | null = null,
  forkId: string | null = null
) {
  const fork = forkId ?? sql.literal("(SELECT current_fork_id FROM chats WHERE id = s.chat_id)")
  const [previous] =
    versionId !== null && forkId === null
      ? yield* sql<{ content: Uint8Array }>`
          SELECT CAST(v.content AS BLOB) AS content FROM slots s JOIN versions v ON v.id = ${versionId}
          WHERE s.id = ${slotId} AND (s.selected_version_id = v.id OR EXISTS (SELECT 1 FROM fork_overrides o
            WHERE o.target_id = s.id AND o.kind = 'select' AND o.value_id = v.id) OR EXISTS (SELECT 1
            FROM fork_overrides o WHERE o.target_id = v.source_version_id AND o.kind = 'replace' AND o.value_id = v.id))`
      : yield* sql<{ content: Uint8Array }>`
          SELECT CAST(v.content AS BLOB) AS content FROM slots s JOIN versions v ON v.id = ${shownIn(sql, fork, "s")}
          WHERE s.id = ${slotId} AND (${versionId} IS NULL OR v.id = ${versionId})`
  if (previous && content.length < Buffer.from(previous.content).toString("utf8").length)
    yield* recordReduction(sql, slotId, forkId)
})
