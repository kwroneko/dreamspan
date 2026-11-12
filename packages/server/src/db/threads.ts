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
import { nextSeq } from "./forkState.ts"

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
 * The threads fork `forkId` is in, innermost first (the deepest S first, then the newest
 * split), from its candidates and whether its display path holds each S.
 */
export const placesOf = (
  candidates: ReadonlyArray<ThreadCandidate>,
  forkId: string,
  onPath: (slotId: string) => boolean
): ReadonlyArray<ThreadPlace> =>
  candidates
    .filter((c) => c.forkId === forkId && c.ordinal !== null && onPath(c.slotId))
    .sort((a, b) => b.depth - a.depth || (a.splitId < b.splitId ? 1 : a.splitId > b.splitId ? -1 : 0))
    .map((c) => ({ splitId: c.splitId, ordinal: c.ordinal }))

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
