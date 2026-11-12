// Which thread a fork is in (spec/THREADS.md §4.3): derived from the fork tree's labels, never
// stored per message. For a fork G and a split X (message S, branch F):
// 1. X is visible in G when X's label <= G's point < F's end (the rule fork-scoped rows use,
//    db/forkLabels.ts) and S is on G's display path. So branches made from F before the
//    threads were started never show them, and a branch made from a thread at a message
//    before S isn't in X.
// 2. G is in member k (made by X) when G's point lies in that member fork's range (it is that
//    fork or made from it, at any depth); otherwise in the continuing member (F's thread).
// The shell's fork summaries compute it with each fork's walk (db/forkSummaries.ts), where
// the path is already in hand, and store the pairs; reads derive the rest.
import { uuidv7 } from "@rp/shared/id.ts"
import type { ThreadPlace } from "@rp/shared/threads.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { effectiveOverride, nextSeq, writeOverride } from "./forkState.ts"
import { onForkPath } from "./forks.ts"

/**
 * A split of fork `forkId` at slot `slotId`, writer only, inside the caller's transaction, with
 * its continuing member (ordinal 0, the fork itself). It takes the next state seq and the fork's
 * point now, so the caller makes the new threads' forks after it (`insertFork` from the fork at
 * the slot) and adds them with `insertThreadMember`: they then have `branched_at` >= its seq,
 * which a rebuild of the chat's labels counts the same way (db/forkLabels.ts). Under a paused
 * rebuild the fork may have no label yet; the rebuild that ends the pause sets it.
 */
export const insertSplit = (
  sql: SqlClient.SqlClient,
  split: {
    readonly chatId: string
    readonly slotId: string
    readonly forkId: string
    readonly origin?: "user" | "rollout" | "import"
    readonly originRef?: string | null
    readonly name?: string | null
    readonly at: number
  }
) =>
  Effect.gen(function* () {
    const id = uuidv7()
    const seq = yield* nextSeq(sql, split.chatId)
    yield* sql`INSERT INTO thread_splits (id, chat_id, slot_id, fork_id, fork_label, seq, origin, origin_ref, created_at)
      VALUES (${id}, ${split.chatId}, ${split.slotId}, ${split.forkId},
        coalesce((SELECT point FROM fork_labels WHERE fork_id = ${split.forkId}), X''), ${seq},
        ${split.origin ?? "user"}, ${split.originRef ?? null}, ${split.at})`
    yield* insertThreadMember(sql, {
      splitId: id,
      ordinal: 0,
      forkId: split.forkId,
      starts: false,
      name: split.name ?? null
    })
    return { id, seq }
  })

/** A thread of split `splitId`: its continuing member, or a fork made from the split's at S. */
export const insertThreadMember = (
  sql: SqlClient.SqlClient,
  member: {
    readonly splitId: string
    readonly ordinal: number
    readonly forkId: string
    readonly starts: boolean
    readonly name: string | null
  }
) =>
  sql`INSERT INTO thread_members (split_id, ordinal, fork_id, starts, name, name_user)
    VALUES (${member.splitId}, ${member.ordinal}, ${member.forkId}, ${member.starts ? 1 : 0}, ${member.name},
      ${member.name === null ? 0 : 1})`.pipe(Effect.asVoid)

/** A split visible by labels in a fork, before the path check: its S and its depth there. */
export interface ThreadCandidate {
  readonly forkId: string
  readonly splitId: string
  readonly slotId: string
  readonly depth: number
  readonly ordinal: number
}

/**
 * The splits each of `forkIds` sees by labels (rule 1's first half), with the member it's in
 * (rule 2). One statement: per fork, one comparison per split of its chat and a probe of the
 * new members' labels; a chat has tens of splits at most.
 */
export const threadCandidates = (sql: SqlClient.SqlClient, forkIds: ReadonlyArray<string>) =>
  forkIds.length === 0
    ? Effect.succeed([] as ReadonlyArray<ThreadCandidate>)
    : sql<ThreadCandidate>`
        SELECT g.fork_id AS "forkId", x.id AS "splitId", x.slot_id AS "slotId", s.depth,
          coalesce((SELECT m.ordinal FROM thread_members m JOIN fork_labels ml ON ml.fork_id = m.fork_id
              WHERE m.split_id = x.id AND m.starts = 1 AND g.point > ml.base AND g.point < ml.label_end),
            (SELECT m.ordinal FROM thread_members m WHERE m.split_id = x.id AND m.starts = 0)) AS ordinal
        FROM json_each(${JSON.stringify(forkIds)}) j
          CROSS JOIN fork_labels g ON g.fork_id = j.value
          CROSS JOIN thread_splits x ON x.chat_id = g.chat_id
          CROSS JOIN fork_labels f ON f.fork_id = x.fork_id
          CROSS JOIN slots s ON s.id = x.slot_id
        WHERE x.fork_label <= g.point AND g.point < f.label_end`

/**
 * The threads fork `forkId` is in, innermost first (the last S in display order first, then
 * the newest split), from its candidates and whether its display path holds each S.
 */
export const placesOf = (
  candidates: ReadonlyArray<ThreadCandidate>,
  forkId: string,
  onPath: (slotId: string) => boolean,
  positions?: ReadonlyMap<string, number>
): ReadonlyArray<ThreadPlace> =>
  candidates
    .filter((c) => c.forkId === forkId && c.ordinal !== null && onPath(c.slotId))
    .sort(
      (a, b) =>
        (positions?.get(b.slotId) ?? b.depth) - (positions?.get(a.slotId) ?? a.depth) ||
        (a.splitId < b.splitId ? 1 : a.splitId > b.splitId ? -1 : 0)
    )
    .map((c) => ({ splitId: c.splitId, ordinal: c.ordinal }))

/**
 * Whether forks are threads of one another (spec/THREADS.md §6.1): each pair shares a split, by
 * labels and with its S on both display paths, where they're in different threads. A send to
 * several threads goes only to such forks, one copy per thread.
 */
export const separateThreads = (
  sql: SqlClient.SqlClient,
  chatId: string,
  forks: ReadonlyArray<{ readonly id: string; readonly tip_slot_id: string | null }>
) =>
  Effect.gen(function* () {
    const candidates = yield* threadCandidates(
      sql,
      forks.map((fork) => fork.id)
    )
    const places: Array<ReadonlyArray<ThreadPlace>> = []
    for (const fork of forks) {
      const kept: Array<ThreadPlace> = []
      for (const c of candidates)
        if (c.forkId === fork.id && c.ordinal !== null && (yield* onForkPath(sql, chatId, fork, c.slotId)))
          kept.push({ splitId: c.splitId, ordinal: c.ordinal })
      places.push(kept)
    }
    return places.every((mine, i) =>
      places.every(
        (theirs, j) =>
          i === j || mine.some((p) => theirs.some((q) => q.splitId === p.splitId && q.ordinal !== p.ordinal))
      )
    )
  })

/**
 * The splits shown at all: those with at least two threads that still have a live fork
 * (`live`: each live fork's places). A split whose other threads are all deleted (its Undo,
 * or each deleted by hand) shows nowhere, and its places are left out (§5.2).
 */
export const shownSplits = (live: ReadonlyArray<ReadonlyArray<ThreadPlace>>) => {
  const threads = new Map<string, Set<number>>()
  for (const places of live)
    for (const place of places) {
      const set = threads.get(place.splitId) ?? new Set<number>()
      set.add(place.ordinal)
      threads.set(place.splitId, set)
    }
  return new Set([...threads].flatMap(([splitId, set]) => (set.size >= 2 ? [splitId] : [])))
}

/** A split as its writes name it: its id, chat and branch F. */
interface SplitRef {
  readonly id: string
  readonly chatId: string
  readonly forkId: string
}

/**
 * The played stretch's correction (spec/THREADS.md §5.2 step 5, [D] 2026-11-12): in split
 * `split`'s branch F, each of `cards` counts not present for each of `slotIds` (messages F
 * shows after S), as `presence_away` overrides of F with flag 1. `value_id` holds the JSON
 * object of split ids and whether each applies, so overlapping splits can be undone independently, all at one
 * seq. Written after the threads' forks, so they don't inherit it; forks made from F later do.
 */
export const insertCorrections = (
  sql: SqlClient.SqlClient,
  split: SplitRef,
  slotIds: ReadonlyArray<string>,
  cards: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    if (slotIds.length === 0 || cards.length === 0) return 0
    const seq = yield* nextSeq(sql, split.chatId)
    const rows = slotIds.flatMap((slot) => cards.map((card) => [uuidv7(), slot, card]))
    for (let at = 0; at < rows.length; at += 2000)
      yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
        SELECT r.value ->> 0, ${split.chatId}, ${split.forkId}, ${seq}, 'presence_away',
          (r.value ->> 1) || ':' || (r.value ->> 2), s.id, s.depth,
          json_patch(coalesce(o.value_id, '{}'), ${JSON.stringify({ [split.id]: true })}), 1
        FROM json_each(${JSON.stringify(rows.slice(at, at + 2000))}) r CROSS JOIN slots s ON s.id = r.value ->> 1
        LEFT JOIN fork_overrides o ON o.id = ${effectiveOverride(sql, "presence_away", split.forkId, "(r.value ->> 1) || ':' || (r.value ->> 2)")}`
    return rows.length
  })

/**
 * Whether split `split`'s threads apply in its branch F (false while its Undo, bin item
 * `itemId`, is in the bin): its away events there are suppressed or not, and its corrections
 * of the played stretch count or not. Both are F's own rows as `writeOverride` keeps them: one
 * updated in place unless a fork was made from F since, else a new row, so a fork made from F
 * keeps what it saw. Only this split's contribution changes; other splits' absences stay.
 */
export const setSplitApplied = (sql: SqlClient.SqlClient, split: SplitRef, applied: boolean, itemId: string | null) =>
  Effect.gen(function* () {
    const fork = { id: split.forkId, chatId: split.chatId }
    const events = yield* sql<{ id: string; slot_id: string | null }>`SELECT id, slot_id FROM state_events
      WHERE chat_id = ${split.chatId} AND fork_id = ${split.forkId} AND origin = 'user' AND origin_ref = ${split.id}`
    for (const event of events)
      yield* writeOverride(sql, fork, {
        kind: "suppress_event",
        targetId: event.id,
        slotId: event.slot_id,
        valueId: null,
        flag: applied ? 0 : 1,
        binItemId: applied ? null : itemId
      })
    const found = yield* sql<{ id: string; target_id: string; slot_id: string; value_id: string; forked: number }>`
      SELECT o.id, o.target_id, o.slot_id, o.value_id,
        EXISTS (SELECT 1 FROM forks c WHERE c.parent_fork_id = o.fork_id AND c.branched_at >= o.seq) AS forked
      FROM (SELECT DISTINCT p.target_id FROM fork_overrides p, json_each(p.value_id) x
        WHERE p.fork_id = ${split.forkId} AND p.kind = 'presence_away' AND x.key = ${split.id}) targets
      CROSS JOIN fork_overrides o ON o.id = ${effectiveOverride(sql, "presence_away", split.forkId, "targets.target_id")}`
    const rows = found.flatMap((row) => {
      const ids = JSON.parse(row.value_id) as Record<string, boolean>
      if (ids[split.id] === applied) return []
      const next = { ...ids, [split.id]: applied }
      return [{ ...row, value: JSON.stringify(next), flag: Object.values(next).some(Boolean) ? 1 : 0 }]
    })
    if (rows.length > 0) {
      const seq = yield* nextSeq(sql, split.chatId)
      const inPlace = rows.filter((row) => row.forked === 0).map((row) => [row.id, row.value, row.flag])
      for (let at = 0; at < inPlace.length; at += 2000)
        yield* sql`UPDATE fork_overrides AS o SET value_id = r.value ->> 1, flag = r.value ->> 2, seq = ${seq}
          FROM json_each(${JSON.stringify(inPlace.slice(at, at + 2000))}) r WHERE o.id = r.value ->> 0`
      const added = rows
        .filter((row) => row.forked === 1)
        .map((row) => [uuidv7(), row.target_id, row.slot_id, row.value, row.flag])
      for (let at = 0; at < added.length; at += 2000)
        yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag)
          SELECT r.value ->> 0, ${split.chatId}, ${split.forkId}, ${seq}, 'presence_away', r.value ->> 1, s.id, s.depth,
            r.value ->> 3, r.value ->> 4
          FROM json_each(${JSON.stringify(added.slice(at, at + 2000))}) r CROSS JOIN slots s ON s.id = r.value ->> 2`
    }
    yield* sql`UPDATE thread_splits SET bin_item_id = ${itemId} WHERE id = ${split.id}`
  })
