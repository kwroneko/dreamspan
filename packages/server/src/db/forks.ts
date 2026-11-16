// Forks (spec/FORK-INDEPENDENCE-DELTA.md §2.1; schema/forks.ts): what readers and the writer
// share. A slot is on a fork's path iff a chain segment of its tip holds it (pathSegments.ts),
// so the checks here cost the path's branch points, not its length. What a fork shows is its
// display path (displayPath.ts), which adds the inserted slots it places (`onForkPath`).
import type { SqlClient } from "effect/sql"
import { Effect } from "effect"
import { effectiveOverrideSql, shownIn, shownInSql, slotDeletedIn, versionDeletedIn, withFork } from "./forkState.ts"
import { onDisplayPath, pathPieces, slotPlace, rearranges } from "./displayPath.ts"
import { pathSegments } from "./pathSegments.ts"
import type { ForkRow } from "./rows.ts"

/** How recently a fork was current: made by forking, or chatted in (UX-REWORK §3). */
export const forkRecency = (f: string) => `max(${f}.created_at, coalesce(${f}.last_chatted_at, 0))`

/** A fork's columns for `toFork`: the row, its tip's text as it shows it and whether it's current. */
export const forkColumns = (f: string) => `${f}.*,
  (SELECT substr(v.content, 1, 160) FROM slots t JOIN version_records v ON v.id = ${shownInSql(`${f}.id`, "t")}
    WHERE t.id = ${f}.tip_slot_id) AS tip_excerpt,
  (SELECT c.current_fork_id = ${f}.id FROM chats c WHERE c.id = ${f}.chat_id) AS current`

/**
 * The last message fork `forkId` shows (spec/MESSAGE-INSERT.md §2.3, the display end): its tip,
 * or an inserted slot after it when everything structural after its anchor is gone from the
 * fork's view, skipping inserted ones deleted there. Costs nothing more than the lookup of the
 * fork's insertions when it places none.
 */
export const lastShown = (
  sql: SqlClient.SqlClient,
  chatId: string,
  fork: { readonly id: string; readonly tip_slot_id: string | null }
) =>
  Effect.gen(function* () {
    if (!(yield* rearranges(sql, chatId, fork.id))) return fork.tip_slot_id
    const pieces = yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id)
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i]!
      // A run a move cut short ends before the moved slot.
      if (piece.kind === "run") return piece.endId ?? fork.tip_slot_id
      const [row] = yield* sql<{ deleted: number }>`
        SELECT ${slotDeletedIn(sql, fork.id, "s")} AS deleted FROM slots s WHERE s.id = ${piece.slotId}`
      if (row?.deleted === 0) return piece.slotId
    }
    return fork.tip_slot_id
  })

/** A fork row read with `forkColumns`, its tip text taken from the last message it shows (`lastShown`). */
export const withDisplayEnd = <
  A extends {
    readonly id: string
    readonly chat_id: string
    readonly tip_slot_id: string | null
    readonly tip_excerpt: string | null
  }
>(
  sql: SqlClient.SqlClient,
  row: A
) =>
  Effect.gen(function* () {
    const end = yield* lastShown(sql, row.chat_id, row)
    if (end === row.tip_slot_id || end === null) return row
    const [text] = yield* sql<{ excerpt: string | null }>`
      SELECT substr(v.content, 1, 160) AS excerpt FROM slots t JOIN version_records v ON v.id = ${shownIn(sql, row.id, "t")}
      WHERE t.id = ${end}`
    return { ...row, tip_excerpt: text?.excerpt ?? row.tip_excerpt }
  })

/** Latest selected message with usable text, in display order. */
export const lastText = Effect.fn("lastText")(function* (
  sql: SqlClient.SqlClient,
  chatId: string,
  forkId: string,
  tip: string | null
) {
  const pieces = yield* pathPieces(sql, chatId, forkId, tip)
  const ranges = pieces.map((p) => [p.chainId, p.kind !== "run" ? p.depth : p.lo, p.kind !== "run" ? p.depth : p.hi])
  // Each chain range supplies its newest visible nonblank version with an index
  // walk. Sorting every message body before LIMIT 1 defeats the payload split.
  const [row] = yield* sql<{ speaker: string | null; writer: string; text: string }>`
    WITH candidates AS MATERIALIZED (
      SELECT cast(p.key AS INTEGER) AS position, (
        SELECT v.seq FROM slots s INDEXED BY slots_chain
        JOIN versions v ON v.id = ${shownIn(sql, forkId, "s")}
        JOIN version_texts t ON t.version_seq = v.seq
        WHERE s.chat_id = ${chatId} AND s.chain_id = p.value ->> 0
          AND s.depth BETWEEN p.value ->> 1 AND p.value ->> 2
          AND NOT ${slotDeletedIn(sql, forkId, "s")} AND v.status <> 'failed' AND v.content_length > 0
          AND length(trim(t.content, char(9) || char(10) || char(13) || ' ')) > 0
        ORDER BY s.depth DESC LIMIT 1
      ) AS version_seq FROM json_each(${JSON.stringify(ranges)}) p
    ), chosen AS MATERIALIZED (
      SELECT version_seq FROM candidates WHERE version_seq IS NOT NULL ORDER BY position DESC LIMIT 1
    )
    SELECT v.speaker_entity_id AS speaker, v.writer, substr(t.content, 1, 240) AS text
    FROM chosen c CROSS JOIN versions v ON v.seq = c.version_seq
    CROSS JOIN version_texts t ON t.version_seq = v.seq`
  return row ?? null
})

/** Imported forks may have no recorded base: locate their last shared message. */
export const branchStart = Effect.fn("branchStart")(function* (sql: SqlClient.SqlClient, fork: ForkRow) {
  if (fork.base_slot_id !== null) return fork.base_slot_id
  if (fork.parent_fork_id === null) return null
  const [parent] = yield* sql<ForkRow>`SELECT * FROM forks WHERE id = ${fork.parent_fork_id}`
  const own = yield* pathPieces(sql, fork.chat_id, fork.id, fork.tip_slot_id)
  const other = parent ? yield* pathPieces(sql, parent.chat_id, parent.id, parent.tip_slot_id) : []
  let shared: { chain: string; depth: number } | undefined
  for (const p of own)
    for (const q of other) {
      const lo = Math.max(p.kind === "run" ? p.lo : p.depth, q.kind === "run" ? q.lo : q.depth)
      const hi = Math.min(p.kind === "run" ? p.hi : p.depth, q.kind === "run" ? q.hi : q.depth)
      if (p.chainId === q.chainId && lo <= hi) shared = { chain: p.chainId, depth: hi }
    }
  const first = own[0]
  const target =
    shared ?? (first ? { chain: first.chainId, depth: first.kind === "run" ? first.lo : first.depth } : null)
  if (!target) return null
  const [slot] = yield* sql<{ id: string }>`SELECT id FROM slots WHERE chat_id = ${fork.chat_id}
    AND chain_id = ${target.chain} AND depth = ${target.depth}`
  return slot?.id ?? null
})

/** Whether `slotId` is on the path from the root to `tipSlotId`. */
export const onPath = (sql: SqlClient.SqlClient, chatId: string, tipSlotId: string | null, slotId: string) =>
  tipSlotId === null
    ? Effect.succeed(false)
    : sql<{ n: number }>`
        ${pathSegments(sql, chatId, tipSlotId, null)}
        SELECT count(*) AS n FROM segments g JOIN slots x ON x.id = ${slotId}
        WHERE g.chain_id = x.chain_id AND x.depth BETWEEN g.lo AND g.hi`.pipe(Effect.map(([row]) => row!.n > 0))

/**
 * Whether fork `fork` shows `slotId`: it's on its display path (displayPath.ts). Only an
 * inserted slot can be shown off the structural path, and a structural one is shown iff it's
 * on it, so for any other slot this is `onPath`, at its cost.
 */
export const onForkPath = (
  sql: SqlClient.SqlClient,
  chatId: string,
  fork: { readonly id: string; readonly tip_slot_id: string | null },
  slotId: string
) =>
  Effect.gen(function* () {
    const place = yield* slotPlace(sql, chatId, slotId)
    if (place === null) return false
    if (!place.inserted) return yield* onPath(sql, chatId, fork.tip_slot_id, slotId)
    return onDisplayPath(yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id), place)
  })

/** SQL: whether fork tip `t` (left-joined) can reach slot `x` on a display path: an inserted slot can sit below the tip. */
const reaches = (t: string, x: string) => `(${x}.inserted = 1 OR ${t}.depth >= ${x}.depth)`

/**
 * The live fork whose path holds `slotId` that was current most recently, preferring
 * `prefer` when its path holds it too; null when no live fork's does. `prefer` is checked
 * alone first, so the usual case reads one fork, not the chat's; then most recent first.
 */
export const forkThrough = (sql: SqlClient.SqlClient, chatId: string, slotId: string, prefer: string | null = null) =>
  Effect.gen(function* () {
    if (prefer !== null) {
      const [own] = yield* sql<ForkRow>`
        SELECT f.* FROM forks f WHERE f.id = ${prefer} AND f.chat_id = ${chatId} AND f.deleted_at IS NULL`
      if (own !== undefined && (yield* onForkPath(sql, chatId, own, slotId))) return own
    }
    const candidates = yield* sql<ForkRow>`
      SELECT f.* FROM forks f LEFT JOIN slots t ON t.id = f.tip_slot_id JOIN slots x ON x.id = ${slotId}
      WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL AND ${sql.literal(reaches("t", "x"))}
      ORDER BY f.id = ${prefer} DESC, ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
    for (const fork of candidates) if (yield* onForkPath(sql, chatId, fork, slotId)) return fork
    return null
  })

/**
 * Whether a fork other than `forkId` shows `versionId` in place of `original`, one of the
 * message's own versions at `slotId` (`versionId` itself, or a fork's copy standing in for
 * it): in its picker, which holds every version of each message on its path. Forks in the bin
 * count, since a restore brings them back; purged ones have no path.
 */
export const shownElsewhere = (
  sql: SqlClient.SqlClient,
  chatId: string,
  forkId: string,
  slotId: string,
  original: string,
  versionId: string
) =>
  Effect.gen(function* () {
    // The fork's replacement of the original, as `replacedInSql` reads it, with the original bound.
    const candidates = yield* sql<ForkRow>`
      SELECT f.* FROM forks f LEFT JOIN slots t ON t.id = f.tip_slot_id JOIN slots x ON x.id = ${slotId}
      WHERE f.chat_id = ${chatId} AND f.purged_at IS NULL AND f.id <> ${forkId} AND ${sql.literal(reaches("t", "x"))}
        AND coalesce((SELECT o.value_id FROM fork_overrides o
          WHERE o.id = ${withFork(sql, original, (target) => effectiveOverrideSql("replace", "f.id", target))}), ${original}) = ${versionId}
      ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
    for (const fork of candidates) if (yield* onForkPath(sql, chatId, fork, slotId)) return true
    return false
  })

/**
 * The forks of the chat, other than `except`, that show `slotId` (and `versionId`, one of its
 * message's own, when given): its path holds the slot and it isn't deleted there, as the
 * fork's own view has it. Forks in the bin count unless `liveOnly`, since a restore brings
 * them back; purged ones have no path. Most recently current first.
 */
export const forksShowing = (
  sql: SqlClient.SqlClient,
  chatId: string,
  slotId: string,
  versionId: string | null,
  except: string | null,
  liveOnly: boolean,
  /** Stop at the first fork found: for a caller that only asks whether any fork shows it. */
  first = false
) =>
  Effect.gen(function* () {
    const candidates = yield* sql<ForkRow>`
      SELECT f.* FROM forks f LEFT JOIN slots t ON t.id = f.tip_slot_id JOIN slots x ON x.id = ${slotId}
      WHERE f.chat_id = ${chatId} AND f.purged_at IS NULL AND f.id IS NOT ${except} AND ${sql.literal(reaches("t", "x"))}
        AND (${liveOnly ? 1 : 0} = 0 OR f.deleted_at IS NULL)
        AND NOT ${slotDeletedIn(sql, sql.literal("f.id"), "x")}
        AND (${versionId} IS NULL OR NOT EXISTS (SELECT 1 FROM versions o WHERE o.id = ${versionId}
          AND ${versionDeletedIn(sql, sql.literal("f.id"), "o")}))
      ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
    const shown: Array<ForkRow> = []
    for (const fork of candidates) {
      if (!(yield* onForkPath(sql, chatId, fork, slotId))) continue
      shown.push(fork)
      if (first) break
    }
    return shown
  })

/** The path to `tip` as chain segments `(chain, lo, hi)`, newest first. */
const segmentsOf = (sql: SqlClient.SqlClient, chatId: string, tip: string) =>
  sql<{ chain_id: string; lo: number; hi: number }>`
    ${pathSegments(sql, chatId, tip, null)} SELECT chain_id, lo, hi FROM segments`

/**
 * The depth of the deepest slot that the paths to `tip` and to each of `others` share (-1 when
 * none), so the slots below it on `tip`'s path are on no other path. Costs the branch points of
 * each path, not its length.
 */
export const sharedDepth = (sql: SqlClient.SqlClient, chatId: string, tip: string, others: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const mine = yield* segmentsOf(sql, chatId, tip)
    let deepest = -1
    for (const other of others) {
      for (const segment of yield* segmentsOf(sql, chatId, other)) {
        for (const own of mine) {
          if (own.chain_id !== segment.chain_id) continue
          const hi = Math.min(own.hi, segment.hi)
          if (hi >= Math.max(own.lo, segment.lo)) deepest = Math.max(deepest, hi)
        }
      }
    }
    return deepest
  })
