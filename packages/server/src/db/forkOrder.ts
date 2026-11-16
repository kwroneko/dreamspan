// A new fork shows what its parent showed up to where it was made (spec/MESSAGE-INSERT.md §2.4;
// moves: owner, 2026-11-16). It inherits the parent's insertions and moves, but its structural
// path is only the path to that message, so on its own it could show a slot the parent had moved
// below that message (at its own place), or miss one the parent had moved up from below it. Its
// own rows, written as it's made, make it follow the parent's order there exactly; a later move
// on either fork never changes the other (branches are independent).
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import {
  arrange,
  arrangementOf,
  displayIds,
  hiddenAtFork,
  type PathPiece,
  pathPieces,
  positionOf,
  segmentsTo,
  slotPlace
} from "./displayPath.ts"
import { writeInsert, writeOverride } from "./forkState.ts"

interface ForkAt {
  readonly id: string
  readonly tip_slot_id: string | null
}

const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, i) => id === b[i])

/**
 * Fork `row`, just made from `from` at `baseSlotId` (null: before the first message), shows
 * exactly what `from` shows up to there, then whatever its own line holds below it (a fork whose
 * tip is further down, as SwitchBranch makes). Without moves, an inserted slot it would place
 * that `from` doesn't show by then gets an `insert` row of 0 (`hiddenAtFork`). With moves, the
 * fork writes its own `move` rows: what it would show that `from` didn't by then is left out
 * (an inserted piece unplaced), each slot that can stay at its own place in the order does (a
 * row of 0 when it was moved), and every other one is moved directly after the slot before it.
 * Costs the branch points, insertions and moves of both paths, and with moves the listing of
 * both display paths, which only a chat with moves pays.
 */
export const placeAsShown = (
  sql: SqlClient.SqlClient,
  chatId: string,
  from: ForkAt,
  baseSlotId: string | null,
  row: ForkAt
) =>
  Effect.gen(function* () {
    const ref = { id: row.id, chatId }
    const shown = yield* pathPieces(sql, chatId, from.id, from.tip_slot_id)
    const base = baseSlotId === null ? null : yield* slotPlace(sql, chatId, baseSlotId)
    const arrangement = yield* arrangementOf(sql, chatId, row.id)
    const segments = yield* segmentsTo(sql, chatId, row.tip_slot_id)
    const own = arrange(segments, arrangement)
    const limit = base === null ? -1 : positionOf(shown, base)
    // Without moves, or from a message the parent doesn't show (a restored line's), only insertions.
    if (arrangement.moves.length === 0 || limit === null) {
      for (const slotId of hiddenAtFork(shown, base, own)) yield* writeInsert(sql, ref, slotId, 0)
      return
    }
    const parentIds = yield* displayIds(sql, shown)
    const parentAll = new Set(parentIds)
    const ownIds = yield* displayIds(sql, own)
    // Its own line below the message: what its structural path has past the message, which the
    // parent doesn't show (none when the fork ends there).
    const above =
      row.tip_slot_id === baseSlotId
        ? null
        : new Set(
            yield* displayIds(sql, arrange(yield* segmentsTo(sql, chatId, baseSlotId), { placed: [], moves: [] }))
          )
    const below = above === null ? [] : ownIds.filter((id) => !parentAll.has(id) && !above.has(id))
    const desired = [...parentIds.slice(0, limit + 1), ...below]
    if (same(ownIds, desired)) return
    const want = new Set(desired)

    // What the fork would show that the parent doesn't by then: an inserted piece isn't placed,
    // anything else (a structural or moved slot) is left out.
    const placedHere = new Set(own.flatMap((p: PathPiece) => (p.kind === "inserted" ? [p.slotId] : [])))
    const unplaced = new Set<string>()
    const left: Array<string> = []
    for (const id of ownIds)
      if (!want.has(id)) {
        if (placedHere.has(id)) unplaced.add(id)
        else left.push(id)
      }
    for (const id of unplaced) yield* writeInsert(sql, ref, id, 0)

    // The order the fork has without moves. Each wanted slot that comes later in it than the last
    // one kept stays at its own place; every other wanted slot follows the one before it.
    const plain = yield* displayIds(
      sql,
      arrange(segments, { placed: arrangement.placed.filter((x) => !unplaced.has(x.id)), moves: [] })
    )
    const index = new Map(plain.map((id, i) => [id, i]))
    const effective = new Map(arrangement.moves.map((m) => [m.id, m]))
    const move = (id: string, anchor: string | null, flag: 0 | 1) =>
      writeOverride(sql, ref, { kind: "move", targetId: id, slotId: id, valueId: anchor, flag })
    let last = -1
    for (let i = 0; i < desired.length; i++) {
      const id = desired[i]!
      const at = index.get(id)
      const m = effective.get(id)
      if (at !== undefined && at > last) {
        last = at
        if (m !== undefined) yield* move(id, null, 0)
        continue
      }
      const anchor = i === 0 ? null : desired[i - 1]!
      if (m === undefined || m.out || m.anchorId !== anchor) yield* move(id, anchor, 1)
    }
    for (const id of left) yield* move(id, id, 1)

    // A move whose anchor the fork shows now may apply where it didn't: its slot is left out too.
    for (let round = 0; ; round++) {
      const now = yield* displayIds(sql, arrange(segments, yield* arrangementOf(sql, chatId, row.id)))
      const extra = now.filter((id) => !want.has(id))
      if (extra.length === 0) {
        if (!same(now, desired))
          return yield* Effect.die(new Error(`fork ${row.id} doesn't follow its parent's order at ${baseSlotId}`))
        return
      }
      if (round > desired.length) return yield* Effect.die(new Error(`fork ${row.id}: moves don't settle`))
      for (const id of extra) yield* move(id, id, 1)
    }
  })
