// LCM over display paths (spec/MESSAGE-INSERT.md §3.4). In a fork that shows inserted slots, a
// summary's range is a stretch of the fork's display path: its numbers (`from`, `to`, the
// cursor) are positions, and its inputs may skip inserted slots, which makes it stale there, not
// inconsistent. A fork that shows none has no pieces here, and every LCM read in it runs the
// structural code that predates insertions.
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { viewAt } from "./forkState.ts"
import {
  insertedAt,
  insertedThrough,
  insertionPieces,
  onlyInsertedBetween,
  positionOf,
  type PathPiece,
  type SlotPlace
} from "./displayPath.ts"

/** The fork an LCM read is in, and its display path when it shows inserted slots (else null). */
export interface LcmView {
  readonly fork: string | null
  readonly pieces: ReadonlyArray<PathPiece> | null
}

export const lcmView = (sql: SqlClient.SqlClient, chatId: string, fork: string | null) =>
  Effect.map(insertionPieces(sql, chatId, fork), (pieces): LcmView => ({ fork, pieces }))

/** Slots' places by id (only the chat's). */
export const placesOf = (sql: SqlClient.SqlClient, chatId: string, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed(new Map<string, SlotPlace>())
    : Effect.map(
        sql<{ id: string; chain_id: string; depth: number }>`
          SELECT id, chain_id, depth FROM slots WHERE chat_id = ${chatId} AND id IN ${sql.in([...new Set(ids)])}`,
        (rows) => new Map(rows.map((r) => [r.id, { id: r.id, chainId: r.chain_id, depth: r.depth }]))
      )

/**
 * Whether ranges `[first, last]` of positions, in order, follow one another on the display path
 * with nothing between them but inserted slots, from `start` to `end`. Positions of the slots an
 * L1 summarizes are such ranges of one slot each; a condensation's parts are its children's ranges.
 */
export const followsInDisplay = (
  pieces: ReadonlyArray<PathPiece>,
  ranges: ReadonlyArray<readonly [number | null, number | null]>,
  start: number | null,
  end: number | null
) => {
  if (start === null || end === null || ranges.length === 0 || ranges[0]![0] !== start || ranges.at(-1)![1] !== end)
    return false
  let previous: number | null = null
  for (const [first, last] of ranges) {
    if (first === null || last === null || last < first) return false
    if (previous !== null && (first <= previous || !onlyInsertedBetween(pieces, previous, first))) return false
    previous = last
  }
  return true
}

/** The position of a slot on the view's display path, or null. */
export const positionIn = (pieces: ReadonlyArray<PathPiece>, place: SlotPlace | undefined) =>
  place === undefined ? null : positionOf(pieces, place)

/**
 * The summaries of a layer walk, with the seam rule applied (`seamStale`, spec §3.4 "At a seam"):
 * a summary followed on the display path only by inserted slots no summary starts at, up to a
 * summary that starts right after them, covers those slots too, stale, so the walk keeps the
 * later summaries and planning writes it again over its first slot to the end of the gap. The
 * same holds before the first summary when only inserted slots precede it. Positions are
 * one-based, as `from` and `to` are; `leaf` is the last position the walk reaches.
 */
export const seamStale = <S extends Summary>(
  summaries: ReadonlyArray<S>,
  pieces: ReadonlyArray<PathPiece>,
  leaf: number,
  copy: (summary: S, change: Partial<Summary>) => S
): ReadonlyArray<S> => {
  const starts = new Set(summaries.map((s) => s.from))
  const inserted = (position: number) => (position <= leaf ? insertedAt(pieces, position - 1) : null)
  return summaries.map((s) => {
    const change: { -readonly [K in keyof Summary]?: Summary[K] } = {}
    let after = s.to + 1
    while (!starts.has(after) && inserted(after) !== null) after++
    if (after > s.to + 1 && starts.has(after) && after <= leaf) {
      change.to = after - 1
      change.lastSlotId = inserted(after - 1) as Summary["lastSlotId"]
    }
    if (s.from > 1) {
      let before = 1
      while (before < s.from && !starts.has(before) && inserted(before) !== null) before++
      if (before === s.from) {
        change.from = 1
        change.firstSlotId = inserted(1) as Summary["firstSlotId"]
      }
    }
    return change.to === undefined && change.from === undefined ? s : copy(s, { ...change, fresh: false })
  })
}

/**
 * The view of the path to `leaf`, in the fork in view (else the fork through it), with the
 * leaf's position, when that fork shows inserted slots and the leaf is on its display path;
 * else null, and the read keeps its structural code.
 */
export const pathView = (sql: SqlClient.SqlClient, chatId: string, leaf: string | null) =>
  Effect.gen(function* () {
    if (leaf === null) return null
    const view = yield* lcmView(sql, chatId, yield* viewAt(sql, chatId, leaf))
    if (view.pieces === null) return null
    const end = positionIn(view.pieces, (yield* placesOf(sql, chatId, [leaf])).get(leaf))
    return end === null ? null : { ...view, pieces: view.pieces, end }
  })

/** The inserted slots on the display path up to the leaf, as JSON for a path query's extra rows. */
export const insertedOnPath = (view: { readonly pieces: ReadonlyArray<PathPiece>; readonly end: number }) =>
  JSON.stringify(insertedThrough(view.pieces, view.end))
