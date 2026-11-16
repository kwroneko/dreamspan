// The display path (spec/MESSAGE-INSERT.md §2.3): what a fork shows, in order. It's the
// structural path, root to tip by parent links and read by chain segment (pathSegments.ts),
// with the fork's placed insertions spliced in. An inserted slot is a child of its anchor, the
// message it was inserted below, and an `insert` override places it in a fork; forks made
// from that fork later inherit the row through the lineage. Readers and the writer share it.
//
// The gap of a slot P is the inserted slots anchored at P, newest first by id (UUIDv7, so
// creation order), each followed by its own gap; then comes P's structural successor. The gap
// of null (above the first message) comes before the root. So "insert below P" always puts
// the new message directly below P, whatever was inserted there before.
//
// Moves (owner, 2026-11-16: moving a message up or down changes the story order later replies
// see, in that branch only) come last. A `move` override shows slot M directly after the slot
// it names (`value_id`, its anchor; null: above the first message), wherever that slot is
// shown, instead of at M's own place. Several moved after one anchor go newest first by seq
// (the chat's state seq, which only grows), each followed by the slots moved after it, so
// "show M after A" always puts M directly after A. A move whose slot or anchor the fork
// doesn't show (or a cycle of them) leaves the slot at its own place. A moved slot is a
// `moved` piece; what was inserted below it stays where it was.
import type { SqlClient } from "effect/sql"
import { Effect } from "effect"
import { pathSegments } from "./pathSegments.ts"
import { lineageCte } from "./forkLabels.ts"
import { withFork } from "./forkState.ts"

/** Depths `lo` to `hi` of a chain, at positions `start` onwards. */
interface RunPiece {
  readonly kind: "run"
  readonly chainId: string
  readonly lo: number
  readonly hi: number
  readonly start: number
  /** The slot at `hi`, when a move cut the run short of where it ended (else the run's own end). */
  readonly endId?: string
}

/** An inserted slot the fork places, at position `start`. */
interface InsertedPiece {
  readonly kind: "inserted"
  readonly slotId: string
  readonly chainId: string
  readonly depth: number
  readonly start: number
}

/** A slot the fork shows out of its own place (a `move`), at position `start`. */
interface MovedPiece {
  readonly kind: "moved"
  readonly slotId: string
  readonly chainId: string
  readonly depth: number
  readonly start: number
  /** Whether the slot was itself inserted (`slots.inserted`). */
  readonly inserted: boolean
}

/** A piece of a display path: a structural run, one inserted slot, or one moved slot. */
export type PathPiece = RunPiece | InsertedPiece | MovedPiece

/** A moved slot a fork shows after its anchor (`flag = 1`, effective there). */
export interface Moved {
  readonly id: string
  readonly chainId: string
  readonly depth: number
  readonly parentId: string | null
  readonly inserted: boolean
  readonly anchorId: string | null
  readonly anchorChainId: string | null
  readonly anchorDepth: number | null
  readonly seq: number
}

/** What a fork changes about its display path: its placed insertions and its moves. */
export interface Arrangement {
  readonly placed: ReadonlyArray<Placed>
  readonly moves: ReadonlyArray<Moved>
}

/** Where a slot is in the graph, which is what the pieces locate it by. */
export interface SlotPlace {
  readonly id: string
  readonly chainId: string
  readonly depth: number
}

/** An inserted slot placed in a fork (`flag = 1`, effective there), with its anchor's place. */
export interface Placed {
  readonly id: string
  readonly chainId: string
  readonly depth: number
  readonly anchorId: string | null
  readonly anchorChainId: string | null
  readonly anchorDepth: number | null
}

/** How many positions a piece takes. */
const pieceLength = (piece: PathPiece) => (piece.kind === "run" ? piece.hi - piece.lo + 1 : 1)

/** How many positions the pieces hold. */
export const displayLength = (pieces: ReadonlyArray<PathPiece>) => {
  const last = pieces.at(-1)
  return last === undefined ? 0 : last.start + pieceLength(last)
}

/**
 * The inserted slots fork `forkId` places: its effective `insert` rows with flag 1, the
 * nearest lineage entry with a row for the slot, newest there. The lineage is walked by
 * parent (`lineageCte`) with one range scan of `fork_overrides_point` on `(fork_id, kind)` per
 * entry, so it costs the fork's depth and insertions, not the chat's length.
 */
export const placedInsertions = (sql: SqlClient.SqlClient, chatId: string, forkId: string) =>
  Effect.map(placedInsertionsSql(sql, chatId, forkId), (rows) =>
    rows.map((row): Placed => ({
      id: row.id,
      chainId: row.chain_id,
      depth: row.depth,
      anchorId: row.anchor_id,
      anchorChainId: row.anchor_chain_id,
      anchorDepth: row.anchor_depth
    }))
  )

/** `placedInsertions`' statement, which the scale test measures. */
export const placedInsertionsSql = (sql: SqlClient.SqlClient, chatId: string, forkId: string) =>
  sql<{
    id: string
    chain_id: string
    depth: number
    anchor_id: string | null
    anchor_chain_id: string | null
    anchor_depth: number | null
  }>`
    WITH RECURSIVE ${withFork(sql, forkId, (f) => lineageCte("lineage", f))}
    SELECT x.id, x.chain_id, x.depth, x.parent_slot_id AS anchor_id, a.chain_id AS anchor_chain_id,
      a.depth AS anchor_depth
    FROM (
      SELECT o.target_id, o.flag, row_number() OVER (PARTITION BY o.target_id ORDER BY l.n, o.seq DESC) AS n
      FROM lineage l CROSS JOIN fork_overrides o
      WHERE o.fork_id = l.fork_id AND o.kind = 'insert' AND o.seq <= l.bound
    ) e CROSS JOIN slots x ON x.id = e.target_id LEFT JOIN slots a ON a.id = x.parent_slot_id
    WHERE e.n = 1 AND e.flag = 1 AND x.chat_id = ${chatId}`

/**
 * The slots fork `forkId` shows out of their own place: its effective `move` rows with flag 1,
 * found as `placedInsertions` finds insertions (one range scan per lineage entry).
 */
export const placedMoves = (sql: SqlClient.SqlClient, chatId: string, forkId: string) =>
  Effect.map(
    sql<{
      id: string
      chain_id: string
      depth: number
      parent_id: string | null
      inserted: number
      anchor_id: string | null
      anchor_chain_id: string | null
      anchor_depth: number | null
      seq: number
    }>`
    WITH RECURSIVE ${withFork(sql, forkId, (f) => lineageCte("lineage", f))}
    SELECT x.id, x.chain_id, x.depth, x.parent_slot_id AS parent_id, x.inserted, e.value_id AS anchor_id,
      a.chain_id AS anchor_chain_id, a.depth AS anchor_depth, e.seq
    FROM (
      SELECT o.target_id, o.flag, o.value_id, o.seq,
        row_number() OVER (PARTITION BY o.target_id ORDER BY l.n, o.seq DESC) AS n
      FROM lineage l CROSS JOIN fork_overrides o
      WHERE o.fork_id = l.fork_id AND o.kind = 'move' AND o.seq <= l.bound
    ) e CROSS JOIN slots x ON x.id = e.target_id LEFT JOIN slots a ON a.id = e.value_id
    WHERE e.n = 1 AND e.flag = 1 AND x.chat_id = ${chatId}`,
    (rows) =>
      rows.map((row): Moved => ({
        id: row.id,
        chainId: row.chain_id,
        depth: row.depth,
        parentId: row.parent_id,
        inserted: row.inserted === 1,
        anchorId: row.anchor_id,
        anchorChainId: row.anchor_chain_id,
        anchorDepth: row.anchor_depth,
        seq: row.seq
      }))
  )

/** Fork `forkId`'s placed insertions and moves (none for a null fork). */
export const arrangementOf = (sql: SqlClient.SqlClient, chatId: string, forkId: string | null) =>
  Effect.gen(function* () {
    if (forkId === null) return { placed: [], moves: [] } satisfies Arrangement
    const placed = yield* placedInsertions(sql, chatId, forkId)
    const moves = yield* placedMoves(sql, chatId, forkId)
    return { placed, moves } satisfies Arrangement
  })

/**
 * Whether fork `forkId`'s display path can differ from its structural path: it places an
 * insertion or moves a message. When it doesn't, callers keep the structural code.
 */
export const rearranges = (sql: SqlClient.SqlClient, chatId: string, forkId: string | null) =>
  Effect.map(arrangementOf(sql, chatId, forkId), (a) => a.placed.length > 0 || a.moves.length > 0)

/** Whether `piece` holds one slot (inserted or moved), not a run. */
const isSingle = (piece: PathPiece): piece is InsertedPiece | MovedPiece => piece.kind !== "run"

/**
 * The pieces with the moves applied (the header): each move whose slot and anchor are shown
 * (an anchor that's moved itself must be applied too) takes its slot out of its own place and
 * shows it directly after its anchor, newest first among those after one anchor, each followed
 * by the slots moved after it.
 */
const applyMoves = (pieces: ReadonlyArray<PathPiece>, moves: ReadonlyArray<Moved>): ReadonlyArray<PathPiece> => {
  if (moves.length === 0) return pieces
  const shown = new Map<string, Moved>()
  for (const m of moves) if (onDisplayPath(pieces, m)) shown.set(m.id, m)
  // Which apply: the anchor is null or shown, and a moved anchor applies itself; a cycle doesn't.
  const applies = new Map<string, boolean>()
  const resolve = (m: Moved, seen: Set<string>): boolean => {
    const known = applies.get(m.id)
    if (known !== undefined) return known
    if (seen.has(m.id)) return false
    seen.add(m.id)
    let ok: boolean
    if (m.anchorId === null) ok = true
    else {
      const anchor = shown.get(m.anchorId)
      ok =
        anchor !== undefined
          ? resolve(anchor, seen)
          : m.anchorChainId !== null &&
            m.anchorDepth !== null &&
            onDisplayPath(pieces, { id: m.anchorId, chainId: m.anchorChainId, depth: m.anchorDepth })
    }
    applies.set(m.id, ok)
    return ok
  }
  const applied = [...shown.values()].filter((m) => resolve(m, new Set()))
  if (applied.length === 0) return pieces
  const movedIds = new Set(applied.map((m) => m.id))
  const children = new Map<string | null, Array<Moved>>()
  for (const m of applied) {
    const list = children.get(m.anchorId)
    if (list === undefined) children.set(m.anchorId, [m])
    else list.push(m)
  }
  for (const list of children.values()) list.sort((a, b) => b.seq - a.seq || (a.id < b.id ? 1 : -1))
  // Structural anchors in runs, by chain and depth: where a run is split to emit a gap.
  const runAnchors = new Map<string, string>()
  for (const m of applied)
    if (m.anchorId !== null && !movedIds.has(m.anchorId) && m.anchorChainId !== null && m.anchorDepth !== null)
      runAnchors.set(`${m.anchorChainId}:${m.anchorDepth}`, m.anchorId)
  // Moved slots taken out of runs, by chain and depth, with the slot before them there.
  const removed = new Map<string, Moved>()
  for (const m of applied) removed.set(`${m.chainId}:${m.depth}`, m)
  // The depths where runs of each chain split, in order: the cost is the moves, not the path.
  const special = new Map<string, Array<number>>()
  const mark = (chainId: string, depth: number) => {
    const list = special.get(chainId)
    if (list === undefined) special.set(chainId, [depth])
    else if (!list.includes(depth)) list.push(depth)
  }
  for (const m of applied) {
    mark(m.chainId, m.depth)
    if (m.anchorId !== null && !movedIds.has(m.anchorId) && m.anchorChainId !== null && m.anchorDepth !== null)
      mark(m.anchorChainId, m.anchorDepth)
  }
  for (const list of special.values()) list.sort((a, b) => a - b)

  const out: Array<PathPiece> = []
  let position = 0
  const seen = new Set<string>()
  const gap = (anchor: string | null) => {
    const stack: Array<Moved> = [...(children.get(anchor) ?? [])].reverse()
    while (stack.length > 0) {
      const m = stack.pop()!
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push({
        kind: "moved",
        slotId: m.id,
        chainId: m.chainId,
        depth: m.depth,
        start: position++,
        inserted: m.inserted
      })
      for (const child of [...(children.get(m.id) ?? [])].reverse()) stack.push(child)
    }
  }
  const run = (chainId: string, lo: number, hi: number, endId: string | undefined) => {
    if (lo > hi) return
    out.push({ kind: "run", chainId, lo, hi, start: position, ...(endId !== undefined ? { endId } : {}) })
    position += hi - lo + 1
  }
  gap(null)
  for (const piece of pieces) {
    if (piece.kind !== "run") {
      if (movedIds.has(piece.slotId)) continue
      out.push({ ...piece, start: position++ })
      gap(piece.slotId)
      continue
    }
    // Split the run at each removed slot and after each anchor in it.
    let lo = piece.lo
    for (const depth of (special.get(piece.chainId) ?? []).filter((d) => d >= piece.lo && d <= piece.hi)) {
      const key = `${piece.chainId}:${depth}`
      const cut = removed.get(key)
      if (cut !== undefined) {
        run(piece.chainId, lo, depth - 1, cut.parentId ?? undefined)
        lo = depth + 1
        continue
      }
      const anchor = runAnchors.get(key)
      if (anchor !== undefined) {
        run(piece.chainId, lo, depth, depth === piece.hi ? piece.endId : anchor)
        lo = depth + 1
        gap(anchor)
      }
    }
    run(piece.chainId, lo, piece.hi, piece.endId)
  }
  return out
}

/**
 * The display path from structural segments, oldest first, and the placed insertions: the
 * runs split after each slot that anchors insertions, with its gap there. Insertions whose
 * anchor isn't shown aren't reached; one that is itself on the structural path (a fork made
 * at or below it) is where the path already has it.
 */
const splice = (
  segments: ReadonlyArray<{ readonly chain_id: string; readonly lo: number; readonly hi: number }>,
  placed: ReadonlyArray<Placed>
): ReadonlyArray<PathPiece> => {
  const structural = (chainId: string | null, depth: number | null) =>
    chainId !== null &&
    depth !== null &&
    segments.some((segment) => segment.chain_id === chainId && depth >= segment.lo && depth <= segment.hi)
  const children = new Map<string | null, Array<Placed>>()
  // The structural slots that anchor a gap, by depth (one slot per depth on a path).
  const anchors = new Map<number, string>()
  for (const x of placed) {
    if (structural(x.chainId, x.depth)) continue
    const list = children.get(x.anchorId)
    if (list === undefined) children.set(x.anchorId, [x])
    else list.push(x)
    if (x.anchorId !== null && structural(x.anchorChainId, x.anchorDepth)) anchors.set(x.anchorDepth!, x.anchorId)
  }
  for (const list of children.values()) list.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

  const pieces: Array<PathPiece> = []
  let position = 0
  const seen = new Set<string>()
  const gap = (anchor: string | null) => {
    // Iterative, newest first, each followed by its own gap. `seen` guards a corrupted graph.
    const stack: Array<Placed> = [...(children.get(anchor) ?? [])].reverse()
    while (stack.length > 0) {
      const x = stack.pop()!
      if (seen.has(x.id)) continue
      seen.add(x.id)
      pieces.push({ kind: "inserted", slotId: x.id, chainId: x.chainId, depth: x.depth, start: position++ })
      for (const child of [...(children.get(x.id) ?? [])].reverse()) stack.push(child)
    }
  }
  const run = (chainId: string, lo: number, hi: number) => {
    pieces.push({ kind: "run", chainId, lo, hi, start: position })
    position += hi - lo + 1
  }

  gap(null)
  const depths = [...anchors.keys()].sort((a, b) => a - b)
  let next = 0
  for (const segment of segments) {
    let lo = segment.lo
    while (next < depths.length && depths[next]! < lo) next++
    while (next < depths.length && depths[next]! <= segment.hi) {
      const depth = depths[next++]!
      run(segment.chain_id, lo, depth)
      gap(anchors.get(depth)!)
      lo = depth + 1
    }
    if (lo <= segment.hi) run(segment.chain_id, lo, segment.hi)
  }
  return pieces
}

/**
 * The display path of fork `forkId` ending at `tipSlotId` (its structural tip), as pieces in
 * order, each with its start position. Costs the path's branch points and the fork's
 * insertions. A null fork places nothing; a null tip has only the gap above the first message.
 */
export const pathPieces = (sql: SqlClient.SqlClient, chatId: string, forkId: string | null, tipSlotId: string | null) =>
  Effect.gen(function* () {
    const arrangement = yield* arrangementOf(sql, chatId, forkId)
    return arrange(yield* segmentsTo(sql, chatId, tipSlotId), arrangement)
  })

/** The display path from structural segments, oldest first: insertions spliced in, then the moves applied. */
export const arrange = (
  segments: ReadonlyArray<{ readonly chain_id: string; readonly lo: number; readonly hi: number }>,
  arrangement: Arrangement
) => applyMoves(splice(segments, arrangement.placed), arrangement.moves)

/** The structural segments of the path to `slotId`, oldest first. */
export const segmentsTo = (sql: SqlClient.SqlClient, chatId: string, slotId: string | null) =>
  slotId === null
    ? Effect.succeed([])
    : Effect.map(
        sql<{ chain_id: string; lo: number; hi: number }>`
          ${pathSegments(sql, chatId, slotId, null)} SELECT chain_id, lo, hi FROM segments`,
        (rows) => rows.toReversed()
      )

/**
 * Fork `forkId`'s placed insertions and its display path to its tip, or null when it places
 * none (or there's no such fork): the display path is then the structural one, and callers keep
 * the structural code that predates insertions. One probe of `fork_overrides_point` per lineage
 * entry (`placedInsertions`) when it's null.
 */
const forkDisplay = (sql: SqlClient.SqlClient, chatId: string, forkId: string | null) =>
  Effect.gen(function* () {
    if (forkId === null) return null
    const arrangement = yield* arrangementOf(sql, chatId, forkId)
    if (arrangement.placed.length === 0 && arrangement.moves.length === 0) return null
    const [fork] = yield* sql<{ tip_slot_id: string | null }>`
      SELECT tip_slot_id FROM forks WHERE id = ${forkId} AND chat_id = ${chatId}`
    if (fork === undefined) return null
    return { arrangement, pieces: arrange(yield* segmentsTo(sql, chatId, fork.tip_slot_id), arrangement) }
  })

/** The pieces of positions 0 to `end`. */
const piecesThrough = (pieces: ReadonlyArray<PathPiece>, end: number): ReadonlyArray<PathPiece> =>
  pieces.flatMap((piece) =>
    piece.start > end
      ? []
      : piece.kind === "run" && piece.start + piece.hi - piece.lo > end
        ? [{ ...piece, hi: piece.lo + end - piece.start }]
        : [piece]
  )

/**
 * Fork `forkId`'s display path through `slotId` (spec/MESSAGE-INSERT.md §3.1): the pieces of
 * positions 0 to the slot's, and that position. A slot the fork doesn't show is read on its
 * own structural path with the fork's insertions spliced in, as GetPath reads one. Null when
 * the fork places no insertion, or for a null fork or slot: the display path is then the
 * structural one, a position is a depth, and callers read it by the structural code, as before
 * insertions. The cost is the path's branch points and the fork's insertions.
 */
export const displayThrough = (
  sql: SqlClient.SqlClient,
  chatId: string,
  forkId: string | null,
  slotId: string | null
) =>
  Effect.gen(function* () {
    if (slotId === null) return null
    const fork = yield* forkDisplay(sql, chatId, forkId)
    if (fork === null) return null
    const place = yield* slotPlace(sql, chatId, slotId)
    if (place === null) return null
    let pieces = fork.pieces
    let end = positionOf(pieces, place)
    if (end === null) {
      pieces = arrange(yield* segmentsTo(sql, chatId, slotId), fork.arrangement)
      end = positionOf(pieces, place)
    }
    return end === null ? null : { pieces: piecesThrough(pieces, end), end }
  })

/**
 * The slot fork `fork`'s display path ends with (`displayEnd`): its tip when it places no
 * insertion. Reads of "the fork as it stands" (its state, its cast) read through it.
 */
export const displayEndOf = (
  sql: SqlClient.SqlClient,
  chatId: string,
  fork: { readonly id: string; readonly tip_slot_id: string | null }
) =>
  Effect.gen(function* () {
    const arrangement = yield* arrangementOf(sql, chatId, fork.id)
    if (arrangement.placed.length === 0 && arrangement.moves.length === 0) return fork.tip_slot_id
    return displayEnd(arrange(yield* segmentsTo(sql, chatId, fork.tip_slot_id), arrangement), fork.tip_slot_id)
  })

/**
 * Fork `forkId`'s display path, to its tip, when it shows an inserted slot; else null, and the
 * fork reads as its structural path, by the code that predates insertions. That costs one probe
 * of `fork_overrides_point` per lineage entry. Shared by readers that keep their structural
 * path for forks without insertions (LCM, spec/MESSAGE-INSERT.md §3.4).
 */
export const insertionPieces = (sql: SqlClient.SqlClient, chatId: string, forkId: string | null) =>
  Effect.gen(function* () {
    const fork = yield* forkDisplay(sql, chatId, forkId)
    return fork !== null && fork.pieces.some(isSingle) ? fork.pieces : null
  })

/**
 * The inserted or moved slot at `position` (0 is the first message), or null when a structural
 * run holds it or it's past the end. LCM treats a moved slot as it does an inserted one: shown
 * where no summary's run of inputs has it, so a summary over it is stale there.
 */
export const insertedAt = (pieces: ReadonlyArray<PathPiece>, position: number) => {
  const piece = pieceAt(pieces, position)
  return piece !== undefined && isSingle(piece) ? piece.slotId : null
}

/** The piece holding `position`, if any. */
const pieceAt = (pieces: ReadonlyArray<PathPiece>, position: number) =>
  pieces.find((p) => position >= p.start && position < p.start + pieceLength(p))

/** Whether every position strictly between `a` and `b` holds an inserted or moved slot (true when there are none). */
export const onlyInsertedBetween = (pieces: ReadonlyArray<PathPiece>, a: number, b: number) =>
  pieces.every((p) => isSingle(p) || Math.max(p.start, a + 1) > Math.min(p.start + pieceLength(p) - 1, b - 1))

/** The inserted and moved slots at positions `0` to `last`, in order. */
export const insertedThrough = (pieces: ReadonlyArray<PathPiece>, last: number) =>
  pieces.flatMap((p) => (isSingle(p) && p.start <= last ? [p.slotId] : []))

/** Whether the pieces show a moved slot. */
export const showsMoves = (pieces: ReadonlyArray<PathPiece>) => pieces.some((p) => p.kind === "moved")

/** The index in `pieces` of the piece holding `slot`, or -1. */
const pieceOf = (pieces: ReadonlyArray<PathPiece>, slot: SlotPlace) =>
  pieces.findIndex((piece) =>
    piece.kind === "run"
      ? piece.chainId === slot.chainId && slot.depth >= piece.lo && slot.depth <= piece.hi
      : piece.slotId === slot.id
  )

/** The position of `slot` on the display path (0 is the first message), or null when it isn't on it. */
export const positionOf = (pieces: ReadonlyArray<PathPiece>, slot: SlotPlace) => {
  const index = pieceOf(pieces, slot)
  if (index < 0) return null
  const piece = pieces[index]!
  return piece.kind === "run" ? piece.start + slot.depth - piece.lo : piece.start
}

/**
 * Whether `slot` is on the display path: a run covers its chain and depth, or an inserted
 * piece is that slot.
 */
export const onDisplayPath = (pieces: ReadonlyArray<PathPiece>, slot: SlotPlace) => pieceOf(pieces, slot) >= 0

/**
 * What a fork made at `at` (null: before the first message) from a fork showing `parent`
 * mustn't place: the inserted slots its own display path `child`, read before it has any rows
 * of its own, would show that the parent doesn't show at or before `at` (spec §2.4). They're
 * the gap after `at` and the older slots of its anchors' gaps when `at` is inserted, and a slot
 * the parent has structurally below `at` while inheriting its `insert` row (the parent was
 * made at or below it). With a flag-0 row for each, the fork shows exactly the parent's
 * display path up to `at`.
 */
export const hiddenAtFork = (
  parent: ReadonlyArray<PathPiece>,
  at: SlotPlace | null,
  child: ReadonlyArray<PathPiece>
): ReadonlyArray<string> => {
  const limit = at === null ? -1 : (positionOf(parent, at) ?? -1)
  const hidden: Array<string> = []
  for (const piece of child) {
    if (piece.kind !== "inserted" && !(piece.kind === "moved" && piece.inserted)) continue
    const position = positionOf(parent, { id: piece.slotId, chainId: piece.chainId, depth: piece.depth })
    if (position === null || position > limit) hidden.push(piece.slotId)
  }
  return hidden
}

/**
 * The slot `tipSlotId`'s display path ends with: the last inserted piece when it's last
 * (everything structural after its anchor is gone from the fork's view), else the tip.
 */
export const displayEnd = (pieces: ReadonlyArray<PathPiece>, tipSlotId: string | null) => {
  const last = pieces.at(-1)
  if (last === undefined) return tipSlotId
  // A run a move cut short ends at the slot before the moved one.
  return last.kind === "run" ? (last.endId ?? tipSlotId) : last.slotId
}

/** A slot's place, read by id, and whether it was inserted; null when it isn't the chat's. */
export const slotPlace = (sql: SqlClient.SqlClient, chatId: string, slotId: string) =>
  Effect.map(
    sql<{ id: string; chain_id: string; depth: number; inserted: number }>`
      SELECT id, chain_id, depth, inserted FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`,
    ([row]): (SlotPlace & { readonly inserted: boolean }) | null =>
      row === undefined ? null : { id: row.id, chainId: row.chain_id, depth: row.depth, inserted: row.inserted === 1 }
  )

/** The slot at `position` on the display path (null past either end). */
export const slotAtPosition = (sql: SqlClient.SqlClient, pieces: ReadonlyArray<PathPiece>, position: number) =>
  Effect.gen(function* () {
    const piece = pieceAt(pieces, position)
    if (piece === undefined) return null
    if (isSingle(piece)) return piece.slotId
    const [row] = yield* sql<{ id: string }>`
      SELECT id FROM slots WHERE chain_id = ${piece.chainId} AND depth = ${piece.lo + position - piece.start}`
    return row?.id ?? null
  })

/**
 * The pieces of positions `first` to `last` as JSON for a window read (`displayWindow` in
 * reads.ts): `[chain, lo, hi, null, start]` for a stretch of a run, `[chain, depth, depth,
 * slot, start]` for an inserted slot.
 */
export const windowPieces = (pieces: ReadonlyArray<PathPiece>, first: number, last: number) =>
  JSON.stringify(
    pieces.flatMap((piece) => {
      const from = Math.max(first, piece.start)
      const to = Math.min(last, piece.start + pieceLength(piece) - 1)
      if (from > to) return []
      return isSingle(piece)
        ? [[piece.chainId, piece.depth, piece.depth, piece.slotId, piece.start]]
        : [[piece.chainId, piece.lo + from - piece.start, piece.lo + to - piece.start, null, from]]
    })
  )

/**
 * SQL: CTEs over positions `first` to `last` of a display path, for reads that join what a
 * fork shows: `display_pieces(chain_id, lo, hi, slot_id, start)` (`windowPieces`' rows), and
 * `display_slots(id, position)`, one row per slot there, by one range of `slots_chain` per
 * structural stretch. A slot's position through the pieces alone, without listing the slots,
 * is `displayPositionSql`.
 */
export const displaySlots = (
  sql: SqlClient.SqlClient,
  pieces: ReadonlyArray<PathPiece>,
  first: number,
  last: number
) => sql`
  WITH display_pieces(chain_id, lo, hi, slot_id, start) AS (
    SELECT value ->> 0, value ->> 1, value ->> 2, value ->> 3, value ->> 4 FROM json_each(${windowPieces(pieces, first, last)})
  ), display_slots(id, position) AS (
    SELECT s.id, p.start + s.depth - p.lo FROM display_pieces p CROSS JOIN slots s ON s.chain_id = p.chain_id
      AND s.depth BETWEEN p.lo AND p.hi WHERE p.slot_id IS NULL
    UNION ALL
    SELECT p.slot_id, p.start FROM display_pieces p WHERE p.slot_id IS NOT NULL
  )`

/**
 * SQL, inside `displaySlots`: the position of slot alias `s` on the display path, or null when
 * the pieces don't hold it. A run holds a slot by chain and depth, an inserted piece by id.
 */
export const displayPositionSql = (s: string) =>
  `(SELECT p.start + ${s}.depth - p.lo FROM display_pieces p WHERE p.chain_id = ${s}.chain_id
    AND ${s}.depth BETWEEN p.lo AND p.hi AND (p.slot_id IS NULL OR p.slot_id = ${s}.id))`

/**
 * SQL, `path_events`: `pathEvents` over display pieces (`displayThrough`), each event with the
 * position of its slot (`position`, null for the chat-wide ones), which orders the fold
 * (`eventOrder(e, "e.position")`). An event is found by its slot's chain and depth, as there.
 */
export const displayEvents = (sql: SqlClient.SqlClient, chatId: string, pieces: ReadonlyArray<PathPiece>) => sql`
  WITH w(chain_id, lo, hi, start) AS (
    SELECT value ->> 0, value ->> 1, value ->> 2, value ->> 4
    FROM json_each(${windowPieces(pieces, 0, displayLength(pieces) - 1)})
  ), path_events AS (
    SELECT e.*, NULL AS position FROM state_events e WHERE e.chat_id = ${chatId} AND e.slot_id IS NULL
    UNION ALL
    SELECT e.*, w.start + e.slot_depth - w.lo AS position FROM w CROSS JOIN state_events e
      ON e.chat_id = ${chatId} AND e.slot_chain_id = w.chain_id AND e.slot_depth BETWEEN w.lo AND w.hi
  )`
