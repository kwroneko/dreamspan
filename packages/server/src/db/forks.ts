// Forks (spec/FORK-INDEPENDENCE-DELTA.md §2.1; schema/forks.ts): what readers and the writer
// share. A slot is on a fork's path iff a chain segment of its tip holds it (pathSegments.ts),
// so the checks here cost the path's branch points, not its length.
import type { SqlClient } from "effect/sql"
import { Effect } from "effect"
import { shownInSql, slotDeletedIn, versionDeletedIn } from "./forkState.ts"
import { pathSegments } from "./pathSegments.ts"
import type { ForkRow } from "./rows.ts"

/** How recently a fork was current: made by forking, or chatted in (UX-REWORK §3). */
export const forkRecency = (f: string) => `max(${f}.created_at, coalesce(${f}.last_chatted_at, 0))`

/** A fork's columns for `toFork`: the row, its tip's text as it shows it and whether it's current. */
export const forkColumns = (f: string) => `${f}.*,
  (SELECT substr(v.content, 1, 160) FROM slots t JOIN versions v ON v.id = ${shownInSql(`${f}.id`, "t")}
    WHERE t.id = ${f}.tip_slot_id) AS tip_excerpt,
  (SELECT c.current_fork_id = ${f}.id FROM chats c WHERE c.id = ${f}.chat_id) AS current`

/** Whether `slotId` is on the path from the root to `tipSlotId`. */
export const onPath = (sql: SqlClient.SqlClient, chatId: string, tipSlotId: string | null, slotId: string) =>
  tipSlotId === null
    ? Effect.succeed(false)
    : sql<{ n: number }>`
        ${pathSegments(sql, chatId, tipSlotId, null)}
        SELECT count(*) AS n FROM segments g JOIN slots x ON x.id = ${slotId}
        WHERE g.chain_id = x.chain_id AND x.depth BETWEEN g.lo AND g.hi`.pipe(Effect.map(([row]) => row!.n > 0))

/**
 * The live fork whose path holds `slotId` that was current most recently, preferring
 * `prefer` when its path holds it too; null when no live fork's does. Most recent first, so
 * the usual case checks one or two forks.
 */
export const forkThrough = (sql: SqlClient.SqlClient, chatId: string, slotId: string, prefer: string | null = null) =>
  Effect.gen(function* () {
    const candidates = yield* sql<ForkRow>`
      SELECT f.* FROM forks f JOIN slots t ON t.id = f.tip_slot_id JOIN slots x ON x.id = ${slotId}
      WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL AND t.depth >= x.depth
      ORDER BY f.id = ${prefer} DESC, ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
    for (const fork of candidates) if (yield* onPath(sql, chatId, fork.tip_slot_id, slotId)) return fork
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
    // The fork's replacement of the original, as `replacedInSql` reads it, with it bound.
    const candidates = yield* sql<ForkRow>`
      SELECT f.* FROM forks f JOIN slots t ON t.id = f.tip_slot_id JOIN slots x ON x.id = ${slotId}
      WHERE f.chat_id = ${chatId} AND f.id <> ${forkId} AND t.depth >= x.depth
        AND coalesce((SELECT o.value_id FROM json_each(f.lineage_json) l CROSS JOIN fork_overrides o
          WHERE o.fork_id = l.value ->> 0 AND o.kind = 'replace' AND o.target_id = ${original}
            AND o.seq <= coalesce(l.value ->> 1, 9223372036854775807)
          ORDER BY l.key, o.seq DESC LIMIT 1), ${original}) = ${versionId}
      ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
    for (const fork of candidates) if (yield* onPath(sql, chatId, fork.tip_slot_id, slotId)) return true
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
  liveOnly: boolean
) =>
  Effect.gen(function* () {
    const candidates = yield* sql<ForkRow>`
      SELECT f.* FROM forks f JOIN slots t ON t.id = f.tip_slot_id JOIN slots x ON x.id = ${slotId}
      WHERE f.chat_id = ${chatId} AND f.id IS NOT ${except} AND t.depth >= x.depth
        AND (${liveOnly ? 1 : 0} = 0 OR f.deleted_at IS NULL)
        AND NOT ${slotDeletedIn(sql, sql.literal("f.id"), "x")}
        AND (${versionId} IS NULL OR NOT EXISTS (SELECT 1 FROM versions o WHERE o.id = ${versionId}
          AND ${versionDeletedIn(sql, sql.literal("f.id"), "o")}))
      ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
    const shown: Array<ForkRow> = []
    for (const fork of candidates) if (yield* onPath(sql, chatId, fork.tip_slot_id, slotId)) shown.push(fork)
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
