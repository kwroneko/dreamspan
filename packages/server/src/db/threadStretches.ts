// A separate join applies only on the fork that shows it, through its causal read position.
// Use display positions so inserted joins and messages have the same boundary as replies.
//
// A thread join's stretch (spec/THREADS.md §7.3) applies to every character: the messages from
// the split through the join are read by presence. An ordinary merge kept separate ("separate
// origin", DESIGN "Merging another chat into this one" [D] 2026-11-08: characters from chat A
// keep A's history, those from chat B keep B's) applies its destination part only to the
// characters it brought in: a character that was in this chat's cast at the merge point keeps
// reading this chat as before, and the join itself is read row by row by everyone (merge2).
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { pathPieces, positionOf, type SlotPlace } from "./displayPath.ts"
import { type ForkRef, slotDeletedIn, viewAt } from "./forkState.ts"

interface StretchRange {
  readonly chain: string
  readonly lo: number
  readonly hi: number
}

/**
 * The live separate joins' stretches on `fork`'s display path through `leaf` (absent: the whole
 * fork), as chain intervals. With `viewers` (one character's identities), only the parts that
 * apply to it: an ordinary merge's destination part (everything before its join) leaves out a
 * character that was in this chat's cast at the merge point (`chat_merges.cast_json` entries
 * whose `from` is "destination" or "both"); its join and every thread join apply to all.
 * Without `viewers`, every part (whether any separate join is on the path).
 */
export const threadStretches = (
  sql: SqlClient.SqlClient,
  fork: ForkRef,
  leaf?: string | null,
  viewers?: ReadonlyArray<string> | null
) =>
  Effect.gen(function* () {
    const [owner] = yield* sql<{
      id: string
      chat_id: string
      tip_slot_id: string | null
    }>`SELECT id, chat_id, tip_slot_id FROM forks WHERE id = ${fork}`
    if (!owner) return [] as Array<StretchRange>
    const joins = yield* sql<{
      id: string
      chain_id: string
      depth: number
      stretch_before_slot_id: string | null
      own: string | null
    }>`
      SELECT j.id, j.chain_id, j.depth, m.stretch_before_slot_id,
        CASE WHEN m.split_id IS NULL THEN (SELECT json_group_array(c.value ->> 'entity') FROM json_each(m.cast_json) c
          WHERE c.value ->> 'from' <> 'source') END AS own
      FROM chat_merges m JOIN slots j ON j.id = m.slot_id
      WHERE m.chat_id = ${owner.chat_id} AND m.timelines = 'separate' AND NOT ${slotDeletedIn(sql, owner.id, "j")}`
    if (joins.length === 0) return [] as Array<StretchRange>
    const pieces = yield* pathPieces(sql, owner.chat_id, owner.id, owner.tip_slot_id)
    let end = Infinity
    if (leaf !== undefined) {
      if (leaf === null) return [] as Array<StretchRange>
      const [at] = yield* sql<{
        id: string
        chain_id: string
        depth: number
      }>`SELECT id, chain_id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${owner.chat_id}`
      if (!at) return [] as Array<StretchRange>
      end = positionOf(pieces, place(at)) ?? -1
    }
    const starts = joins.flatMap((j) => (j.stretch_before_slot_id ? [j.stretch_before_slot_id] : []))
    const rows = starts.length
      ? yield* sql<{ id: string; chain_id: string; depth: number }>`
      SELECT s.id, s.chain_id, s.depth FROM json_each(${JSON.stringify(starts)}) r CROSS JOIN slots s ON s.id = r.value`
      : []
    const positions = new Map(rows.map((r) => [r.id, positionOf(pieces, place(r))]))
    const ranges: Array<StretchRange> = []
    for (const join of joins) {
      const to = positionOf(pieces, place(join))
      if (to === null || to > end) continue
      // This chat's own characters skip an ordinary merge's destination part: only its join applies.
      const own = viewers && join.own !== null ? (JSON.parse(join.own) as Array<string>) : []
      const from = own.some((id) => viewers!.includes(id))
        ? to
        : join.stretch_before_slot_id === null
          ? 0
          : (positions.get(join.stretch_before_slot_id) ?? -1) + 1
      for (const piece of pieces) {
        const last = piece.start + (piece.kind === "run" ? piece.hi - piece.lo : 0)
        const lo = Math.max(from, piece.start),
          hi = Math.min(to, last)
        if (lo > hi) continue
        const depth = piece.kind === "run" ? piece.lo : piece.depth
        ranges.push({ chain: piece.chainId, lo: depth + lo - piece.start, hi: depth + hi - piece.start })
      }
    }
    return ranges
  })

const place = (row: { id: string; chain_id: string; depth: number }): SlotPlace => ({
  id: row.id,
  chainId: row.chain_id,
  depth: row.depth
})

export const stretchesAt = (sql: SqlClient.SqlClient, chatId: string, leaf: string | null) =>
  Effect.flatMap(viewAt(sql, chatId, leaf), (fork) => threadStretches(sql, fork, leaf))

export const stretchedSql = (sql: SqlClient.SqlClient, ranges: ReadonlyArray<StretchRange>) =>
  sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(ranges)}) g WHERE g.value ->> 'chain' = s.chain_id
    AND s.depth BETWEEN g.value ->> 'lo' AND g.value ->> 'hi')`
