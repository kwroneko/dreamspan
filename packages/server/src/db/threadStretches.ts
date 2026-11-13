// A separate join applies only on the fork that shows it, through its causal read position.
// Use display positions so inserted joins and messages have the same boundary as replies.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { pathPieces, positionOf, type SlotPlace } from "./displayPath.ts"
import { type ForkRef, slotDeletedIn, viewAt } from "./forkState.ts"

interface StretchRange {
  readonly chain: string
  readonly lo: number
  readonly hi: number
}

export const threadStretches = (sql: SqlClient.SqlClient, fork: ForkRef, leaf?: string | null) =>
  Effect.gen(function* () {
    const [owner] = yield* sql<{
      id: string
      chat_id: string
      tip_slot_id: string | null
    }>`SELECT id, chat_id, tip_slot_id FROM forks WHERE id = ${fork}`
    if (!owner) return [] as Array<StretchRange>
    const joins = yield* sql<{ id: string; chain_id: string; depth: number; start_slot_id: string | null }>`
      SELECT j.id, j.chain_id, j.depth, m.start_slot_id FROM chat_merges m JOIN slots j ON j.id = m.slot_id
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
    const starts = joins.flatMap((j) => (j.start_slot_id ? [j.start_slot_id] : []))
    const rows = starts.length
      ? yield* sql<{ id: string; chain_id: string; depth: number }>`
      SELECT s.id, s.chain_id, s.depth FROM json_each(${JSON.stringify(starts)}) r CROSS JOIN slots s ON s.id = r.value`
      : []
    const positions = new Map(rows.map((r) => [r.id, positionOf(pieces, place(r))]))
    const ranges: Array<StretchRange> = []
    for (const join of joins) {
      const to = positionOf(pieces, place(join))
      if (to === null || to > end) continue
      const from = join.start_slot_id === null ? to : (positions.get(join.start_slot_id) ?? to)
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
