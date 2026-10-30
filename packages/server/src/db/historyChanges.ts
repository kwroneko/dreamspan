import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { nextSeq, shownIn } from "./forkState.ts"
import { type PathPiece, windowPieces } from "./displayPath.ts"

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
 * `historyRevision` in a fork with insertions (spec/MESSAGE-INSERT.md §3.2): the reductions at
 * positions before `before` on its display path, `pieces` (`displayThrough` the leaf). A
 * position is never below its slot's depth, so the depth index still bounds the changes read;
 * each is then placed among the pieces, which are the path's branch points and insertions.
 */
export const displayHistoryRevision = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  pieces: ReadonlyArray<PathPiece>,
  before: number,
  fork: string
) => sql<{ revision: number }>`
  WITH changes AS MATERIALIZED (
    SELECT slot_id, revision FROM history_changes INDEXED BY history_changes_depth
    WHERE chat_id = ${chatId} AND depth < ${before}
      AND (fork_id = '' OR EXISTS (SELECT 1 FROM forks f CROSS JOIN json_each(f.lineage_json) l
        WHERE f.id = ${fork} AND l.value ->> 0 = history_changes.fork_id
          AND history_changes.seq <= coalesce(l.value ->> 1, 9223372036854775807)))
      AND EXISTS (SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL)
  ), w(chain_id, lo, hi) AS (
    SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(${windowPieces(pieces, 0, before - 1)})
  )
  SELECT coalesce(sum(c.revision), 0) AS revision FROM changes c JOIN slots s ON s.id = c.slot_id
  WHERE EXISTS (SELECT 1 FROM w WHERE w.chain_id = s.chain_id AND s.depth BETWEEN w.lo AND w.hi)`

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
      ON CONFLICT(slot_id, fork_id, seq) DO UPDATE SET revision = revision + 1`
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
