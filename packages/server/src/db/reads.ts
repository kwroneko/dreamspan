import { operationInfo } from "./operationPolicies.ts"
import { archiveCandidates } from "./cardArchive.ts"
import { LibraryRef } from "@rp/shared/library.ts"
import { makeForkMergeQueries } from "./forkMerge.ts"
import { previousRevisionSql, revisionNumber, revisionOnLine, revisionUse } from "./revisionNumbers.ts"
import { previewForkNotes } from "./forkNotes.ts"
import { BinLimitDefaults, readBinLimits } from "./binLimits.ts"
import { composerImages } from "./composerImages.ts"
import { stateEventsThrough } from "./stateRead.ts"
export { stateEventsOnPath } from "./stateRead.ts"
import { chatCast } from "./cards.ts"
import { contextExcluded } from "./lcmVisibility.ts"
// Read operation handlers. They run inside the reader workers on read-only connections.
import {
  type ChatId,
  type EntityId,
  Fork,
  type ForkId,
  type MessageImages,
  type SlotId,
  type VersionId
} from "@rp/shared/chat.ts"
import { chatForkSummaries } from "./forkSummaries.ts"
import { shownSplits } from "./threads.ts"
import { makeThreadReadHandlers } from "./threadReads.ts"
import { Branch, type PathRange, PathWindow } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { MergePreview, type RefId, Revision, type RevisionId } from "@rp/shared/library.ts"
import { FoldableEvent } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { toBinItem, toRecoveredText } from "./bin.ts"
import { binItemBranches, binItemForks } from "./binForks.ts"
import { reachableSlot } from "./graphReachability.ts"
import { branchStart, forkColumns, forkRecency, forkThrough } from "./forks.ts"
import {
  displayEndOf,
  displayLength,
  type PathPiece,
  pathPieces,
  placedInsertions,
  positionOf,
  slotAtPosition,
  slotPlace,
  windowPieces
} from "./displayPath.ts"
import {
  effectiveOverride,
  forkAt,
  shownIn,
  shownJoin,
  shownVersionColumns,
  slotDeletedIn,
  versionDeletedIn,
  versionDeletedInSql,
  imageExcludedSql,
  withFork
} from "./forkState.ts"
import { pathSegments } from "./pathSegments.ts"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef } from "./library.ts"
import { noteChangedAt, noteHere } from "./noteAt.ts"
import { NotFound, ReadOps, RefOperationRefused, StorageError } from "./ops.ts"
import {
  versionExtras,
  type ChatRow,
  type ForkRow,
  type PathRow,
  toChat,
  toFork,
  toPathEntry,
  toUser,
  toVersion,
  type UserRow,
  type VersionRow
} from "./rows.ts"
import { withoutPurged } from "./stateRefs.ts"
import { query } from "./tx.ts"

const decodeStateEvent = Schema.decodeUnknownEffect(FoldableEvent)

/**
 * The alternate branches at slot `s` (DESIGN §3.2), with `also` on top: its siblings in
 * its lane that a path can reach, which is what `latestDescendant` follows. Roots are
 * found by chat and depth, the rest by parent, so the cost is the number of siblings. The
 * indexes are named: left to itself, SQLite took the lane's, which scans the whole lane for
 * every entry (5 s for a 60-slot window of the 100,000-message perf fixture).
 */
const siblingCount = (also = "") => {
  const reachable = `x.chat_id = s.chat_id ${also} AND ${reachableSlot("x")}`
  // An inserted message is the only one at its place (spec/MESSAGE-INSERT.md §2.4).
  return `CASE WHEN s.inserted = 1 THEN ${also === "" ? 1 : 0}
    WHEN s.parent_slot_id IS NULL
    THEN (SELECT count(*) FROM slots x INDEXED BY slots_chat_depth WHERE x.chat_id = s.chat_id AND x.depth = 0 AND ${reachable})
    ELSE (SELECT count(*) FROM slots x INDEXED BY slots_parent WHERE x.parent_slot_id = s.parent_slot_id AND ${reachable}) END`
}

/** The fork whose first message slot `s` is: it was appended there by a fork made at its parent. */
const startsFork = (s: string) =>
  `(SELECT f.id FROM forks f WHERE f.id = ${s}.fork_id AND f.base_slot_id IS ${s}.parent_slot_id)`

/** The name of the fork this slot starts, empty when the fork has no name. */
const branchLabel = (s: string) => `nullif((SELECT f.name FROM forks f
  WHERE f.id = ${s}.fork_id AND f.base_slot_id IS ${s}.parent_slot_id), '')`

/**
 * A path entry's columns: the slot's, and its shown version's under their own names. The
 * version is `v`, the one the fork shows (`viewJoin`), its selection `o`, and the fork's
 * selection and replacement overrides `so` and `ro`: the entry's row version is the slot's
 * plus the newer of their seqs, so it moves when the fork's choice does and never when
 * another fork's does. The count of versions is the message's own: a fork's copies stand in
 * for them.
 */
const pathColumns = (fork: string) => `${shownVersionColumns}, s.parent_slot_id, s.depth, s.inserted,
  s.row_version + max(coalesce(so.seq, 0), coalesce(ro.seq, 0), coalesce(dso.seq, 0), coalesce(hso.seq, 0))
    AS row_version,
  coalesce(hso.flag, ${contextExcluded()}) AS context_excluded, coalesce(hso.flag, s.hidden_by_user) AS hidden_by_user,
  (SELECT json_group_array(a.media_id) FROM version_attachments a
    WHERE a.version_id = v.id AND ${imageExcludedSql(fork, "o.id", "a.media_id")}) AS excluded_images,
  ${branchLabel("s")} AS branch_name, s.fork_id AS slot_fork_id, ${startsFork("s")} AS starts_fork_id,
  (s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL OR coalesce(dso.flag, 0) = 1) AS slot_deleted,
  (SELECT count(*) FROM versions c WHERE c.slot_id = s.id AND c.fork_id IS NULL AND NOT ${versionDeletedInSql(fork, "c")})
    AS version_count,
  ${siblingCount()} AS branch_count, ${siblingCount("AND x.id < s.id")} AS branch_index,
  (SELECT f.writer = 'human' AND f.origin <> 'greeting' FROM versions f WHERE f.slot_id = s.id AND f.fork_id IS NULL
    ORDER BY f.ordinal LIMIT 1) AS user_side,
  (SELECT f.speaker_entity_id FROM versions f WHERE f.slot_id = s.id AND f.fork_id IS NULL ORDER BY f.ordinal LIMIT 1)
    AS first_speaker`

/**
 * Joins slot `s` to the version fork `fork` selects (`o`) and the override that chose it
 * (`so`), and to what it shows for it (`shownJoin`).
 */
const viewJoin = (sql: SqlClient.SqlClient, fork: string | null) => sql`
  LEFT JOIN fork_overrides so ON so.id = ${effectiveOverride(sql, "select", fork, "s.id")}
  LEFT JOIN fork_overrides dso ON dso.id = ${effectiveOverride(sql, "delete_slot", fork, "s.id")}
  LEFT JOIN fork_overrides hso ON hso.id = ${effectiveOverride(sql, "hide", fork, "s.id")}
  JOIN versions o ON o.id = coalesce(so.value_id, s.selected_version_id)
  ${shownJoin(sql, fork)}`

/**
 * The window of at most `limit` slots ending at `leaf`, root first, deleted ones included,
 * as fork `fork` shows them (null: as inserted): a range of depths from each chain segment
 * it overlaps, the segments driving the join. Each slot's selection costs one index probe,
 * whatever the chat's length, the fork's depth or the number of forks.
 */
export const pathWindow = (
  sql: SqlClient.SqlClient,
  chatId: ChatId,
  leaf: SlotId,
  limit: number,
  fork: string | null = null
) =>
  sql<PathRow>`
    ${pathSegments(sql, chatId, leaf, limit)}
    SELECT ${withFork(sql, fork, pathColumns)}, ${fork} AS shown_fork_id
    FROM segments g CROSS JOIN slots s ON s.chain_id = g.chain_id AND s.depth BETWEEN max(g.lo, g.floor) AND g.hi
    ${viewJoin(sql, fork)}
    ORDER BY s.depth`

/**
 * Positions `first` to `last` of a display path (spec/MESSAGE-INSERT.md §2.3), as fork `fork`
 * shows them, deleted ones included, in order, each with its `position`: one range of
 * `slots_chain` per structural stretch and one lookup per inserted slot, from the pieces
 * overlapping the window (`windowPieces`), which drive the join.
 */
export const displayWindow = (
  sql: SqlClient.SqlClient,
  pieces: ReadonlyArray<PathPiece>,
  first: number,
  last: number,
  fork: string
) => {
  const parts = windowPieces(pieces, first, last)
  return sql<PathRow>`
    WITH w(chain_id, lo, hi, slot_id, start) AS (
      SELECT value ->> 0, value ->> 1, value ->> 2, value ->> 3, value ->> 4 FROM json_each(${parts})
    )
    SELECT ${withFork(sql, fork, pathColumns)}, ${fork} AS shown_fork_id, w.start + s.depth - w.lo AS position
    FROM w CROSS JOIN slots s ON s.chain_id = w.chain_id AND s.depth BETWEEN w.lo AND w.hi
    ${viewJoin(sql, fork)}
    WHERE w.slot_id IS NULL
    UNION ALL
    SELECT ${withFork(sql, fork, pathColumns)}, ${fork} AS shown_fork_id, w.start AS position
    FROM w CROSS JOIN slots s ON s.id = w.slot_id
    ${viewJoin(sql, fork)}
    WHERE w.slot_id IS NOT NULL
    ORDER BY position`
}

/** Rows of a structural window, numbered by depth: without insertions, a path's positions are its depths. */
const byDepth = (rows: ReadonlyArray<PathRow>) => rows.map((row) => ({ ...row, position: row.depth }))

interface SlotPosition {
  readonly id: SlotId
  readonly depth: number
}

/**
 * Walks up a path (`ancestorsAt`), counted in this worker. A walk from the leaf costs its
 * distance from it, so a page of `Newer` takes at most one, however many branches it
 * crosses: the tests check the count.
 */
export const pathWalks = { up: 0 }

/**
 * The ancestors of `from` at these depths (none above `from.depth`), by depth: one walk
 * up to the smallest, so it costs the depth difference.
 */
const ancestorsAt = (sql: SqlClient.SqlClient, from: SlotPosition, depths: ReadonlyArray<number>) =>
  sql<SlotPosition>`
    WITH RECURSIVE up(id, parent, depth) AS (
      SELECT id, parent_slot_id, depth FROM slots WHERE id = ${from.id}
      UNION ALL
      SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN up ON s.id = up.parent
      WHERE up.depth > ${Math.min(...depths)}
    )
    SELECT id, depth FROM up WHERE ${sql.in("depth", depths)}`.pipe(
    Effect.map((rows) => {
      pathWalks.up++
      return new Map(rows.map((row) => [row.depth, row.id]))
    })
  )

/**
 * Walks down from `after` towards `leaf`, at most `limit` slots, and returns the last
 * slot reached (null for none). `after` comes from a window the client read, so it's on
 * the path: a run of only children needs no check. At the first branch, the rest of
 * the window is the leaf's ancestors, found in one walk up from it. The cost is the
 * window's length, plus the distance from the leaf once if the window has a branch
 * (each branch walking up on its own cost seven seconds for 60 of them 99,000 messages
 * from the leaf). Checking `after` itself would cost its distance from the leaf on
 * every page, so it isn't: a slot of this chat that isn't on the path walks down its
 * own branch instead, which shows the caller only its own chat.
 */
export const walkTowards = (sql: SqlClient.SqlClient, leaf: SlotPosition, after: SlotPosition, limit: number) =>
  Effect.gen(function* () {
    let current = after
    let remaining = limit
    while (remaining > 0 && current.depth < leaf.depth) {
      const run = yield* sql<SlotPosition>`
        WITH RECURSIVE down(id, depth, n) AS (
          SELECT ${current.id}, ${current.depth}, 0
          UNION ALL
          SELECT c.id, c.depth, d.n + 1 FROM down d JOIN slots c ON c.parent_slot_id = d.id AND c.inserted = 0
          WHERE d.n < ${remaining} AND d.id <> ${leaf.id}
            AND (SELECT count(*) FROM slots x WHERE x.parent_slot_id = d.id AND x.inserted = 0) = 1
        )
        SELECT id, depth FROM down WHERE n > 0 ORDER BY n`
      if (run.length > 0) {
        current = run.at(-1)!
        remaining -= run.length
        continue
      }
      const last = Math.min(leaf.depth, current.depth + remaining)
      const found = yield* ancestorsAt(sql, leaf, [current.depth + 1, last])
      const [step] = yield* sql<{
        parent_slot_id: string | null
      }>`SELECT parent_slot_id FROM slots WHERE id = ${found.get(current.depth + 1)!}`
      if (step?.parent_slot_id !== current.id) break
      current = { id: found.get(last)!, depth: last }
      break
    }
    return current.id === after.id ? null : current
  })

export const makeReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const binLimits = yield* BinLimitDefaults
  const lib = makeLibraryQueries(sql)
  const forkMerge = makeForkMergeQueries(sql)
  const drafts = makeDraftStore(sql)

  const ownedChat = (userId: UserId, chatId: ChatId) =>
    sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))))
    )

  const windowEndingAt = (chatId: ChatId, leaf: SlotId, limit: number, fork: string | null) =>
    Effect.map(pathWindow(sql, chatId, leaf, limit, fork), byDepth)

  /**
   * The display path read in fork `fork` up to `leaf` (spec/MESSAGE-INSERT.md §2.3): the fork's
   * own to its display end when `leaf` is null, else to `leaf` where the fork shows it (its tip
   * included: a window named by it ends there, so paging back from an inserted display end
   * moves on), else the path to `leaf` with the fork's insertions on it. `end` is the last position
   * (-1: empty). NotFound for a leaf not of the chat.
   */
  const displayTo = (chatId: ChatId, fork: { id: string; tip_slot_id: string | null }, leaf: string | null) =>
    Effect.gen(function* () {
      const pieces = yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id)
      if (leaf === null) return { pieces, end: displayLength(pieces) - 1 }
      const place = yield* slotPlace(sql, chatId, leaf)
      if (place === null) return yield* new NotFound({ entity: "slot", id: leaf })
      const shown = positionOf(pieces, place)
      if (shown !== null) return { pieces, end: shown }
      const own = yield* pathPieces(sql, chatId, fork.id, leaf)
      return { pieces: own, end: positionOf(own, place) ?? -1 }
    })

  /** A slot of this chat, deleted or not: paths walk through deleted messages. */
  const slotIn = (chatId: ChatId, slotId: SlotId) =>
    sql<SlotPosition>`SELECT id, depth FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "slot", id: slotId }))))
    )

  /**
   * The tip below a slot, following its newest reply at every step: a live one, or a
   * deleted one with a live reply (a message deleted on its own, in the bin or purged,
   * whose replies stay in place). A deleted branch is never followed.
   */
  const latestDescendant = (slotId: SlotId) =>
    sql<{ id: SlotId }>`
      WITH RECURSIVE down(id, n) AS (
        SELECT ${slotId}, 0
        UNION ALL
        SELECT (SELECT c.id FROM slots c WHERE c.parent_slot_id = d.id
            AND ${sql.literal(reachableSlot("c"))}
            ORDER BY c.id DESC LIMIT 1),
          d.n + 1
        FROM down d WHERE d.id IS NOT NULL
      )
      SELECT id FROM down WHERE id IS NOT NULL ORDER BY n DESC LIMIT 1`.pipe(Effect.map(([row]) => row!.id))

  const liveSlot = (chatId: ChatId, slotId: SlotId) =>
    // A deleted insertion anchor remains a valid state boundary: its gap still has
    // messages whose swipes and speaker choices read the state after that anchor.
    sql<{ id: string }>`SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}
      AND (deleted_at IS NULL OR EXISTS (SELECT 1 FROM slots x
        WHERE x.parent_slot_id = slots.id AND x.inserted = 1))`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.void : Effect.fail(new NotFound({ entity: "slot", id: slotId }))))
    )

  /** A live fork of the chat: `forkId`, or its current one when null. */
  const liveFork = (chat: ChatRow, forkId: ForkId | null) =>
    sql<ForkRow>`SELECT * FROM forks WHERE id = ${forkId ?? chat.current_fork_id} AND chat_id = ${chat.id}
      AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "fork", id: forkId ?? chat.id }))
      )
    )

  /**
   * ReadPath by position on a fork's display path (spec/MESSAGE-INSERT.md §2.3), for a fork
   * that places insertions: the same ranges as by depth, with the cursors (`older`, `newer`)
   * the slots at the positions next to the window, which may be inserted ones.
   */
  const readDisplay = (chatId: ChatId, fork: ForkRow, leafSlotId: SlotId | null, range: PathRange, limit: number) =>
    Effect.gen(function* () {
      const leaf = (leafSlotId ?? fork.tip_slot_id) as SlotId | null
      let shownFork = (leafSlotId === null ? fork.id : null) as ForkId | null
      const shown = yield* displayTo(chatId, fork, leafSlotId)
      const read = (pieces: ReadonlyArray<PathPiece>, first: number, last: number, view: string) =>
        last < first ? Effect.succeed([] as ReadonlyArray<PathRow>) : displayWindow(sql, pieces, first, last, view)
      const at = (pieces: ReadonlyArray<PathPiece>, position: number) =>
        Effect.map(slotAtPosition(sql, pieces, position), (id) => id as SlotId | null)
      const positionIn = (pieces: ReadonlyArray<PathPiece>, slotId: SlotId) =>
        Effect.map(slotPlace(sql, chatId, slotId), (place) => (place === null ? null : positionOf(pieces, place)))
      // Deleted messages are walked through but not shown; their replies stay in place.
      const window = (
        leafId: SlotId | null,
        rows: ReadonlyArray<PathRow>,
        older: SlotId | null,
        newer: SlotId | null
      ) =>
        new PathWindow({
          leafSlotId: leafId,
          forkId: shownFork,
          entries: rows.filter((row) => row.slot_deleted === 0).map(toPathEntry),
          older,
          newer
        })
      switch (range._tag) {
        case "Bottom": {
          const first = Math.max(0, shown.end - limit + 1)
          return window(
            leaf,
            yield* read(shown.pieces, first, shown.end, fork.id),
            yield* at(shown.pieces, first - 1),
            null
          )
        }
        case "Older": {
          yield* slotIn(chatId, range.from)
          let pieces = shown.pieces
          let end = yield* positionIn(pieces, range.from)
          if (end === null) {
            // Not on this path: the path to it, as the fork shows it.
            pieces = yield* pathPieces(sql, chatId, fork.id, range.from)
            end = (yield* positionIn(pieces, range.from)) ?? -1
          }
          const first = Math.max(0, end - limit + 1)
          return window(leaf, yield* read(pieces, first, end, fork.id), yield* at(pieces, first - 1), null)
        }
        case "Newer": {
          yield* slotIn(chatId, range.after)
          const after = yield* positionIn(shown.pieces, range.after)
          if (after === null || after >= shown.end) return window(leaf, [], null, null)
          const last = Math.min(shown.end, after + limit)
          const rows = yield* read(shown.pieces, after + 1, last, fork.id)
          return window(leaf, rows, null, last === shown.end ? null : yield* at(shown.pieces, last))
        }
        case "Around": {
          yield* slotIn(chatId, range.slot)
          let { pieces, end } = shown
          let pathLeaf = leaf
          let view = fork.id
          let anchor = yield* positionIn(pieces, range.slot)
          if (anchor === null || anchor > end) {
            // A slot on another path opens the fork through it that was current most
            // recently, or with none, the path through it on its latest replies.
            const through = yield* forkThrough(sql, chatId, range.slot)
            shownFork = (through?.id ?? null) as ForkId | null
            if (through !== null) {
              view = through.id
              pathLeaf = through.tip_slot_id as SlotId | null
              ;({ pieces, end } = yield* displayTo(chatId, through, null))
            } else {
              pathLeaf = yield* latestDescendant(range.slot)
              pieces = yield* pathPieces(sql, chatId, view, pathLeaf)
              end = (yield* positionIn(pieces, pathLeaf)) ?? -1
            }
            anchor = (yield* positionIn(pieces, range.slot)) ?? 0
          }
          // The anchor and about half the window above it, the rest below, filled up from the
          // other side near the root or the end.
          const top = Math.max(0, anchor - Math.ceil(limit / 2) + 1)
          const last = Math.min(end, top + limit - 1)
          const first = Math.max(0, last - limit + 1)
          return window(
            pathLeaf,
            yield* read(pieces, first, last, view),
            yield* at(pieces, first - 1),
            last === end ? null : yield* at(pieces, last)
          )
        }
      }
    })

  const handlers = {
    WorkshopOperationInfo: (input) => operationInfo(sql, input).pipe(query("WorkshopOperationInfo")),
    // --- Parallel threads (spec/THREADS.md §4.3)
    ...(yield* makeThreadReadHandlers),
    GetBinLimits: ({ userId }) => readBinLimits(sql, userId, binLimits).pipe(query("GetBinLimits")),
    FindUserByHandle: ({ handle }) =>
      sql<UserRow>`SELECT * FROM users WHERE handle = ${handle}`.pipe(
        Effect.map(([row]) => (row ? toUser(row) : null)),
        query("FindUserByHandle")
      ),

    GetChat: ({ userId, chatId }) => ownedChat(userId, chatId).pipe(Effect.map(toChat), query("GetChat")),

    GetPath: ({ userId, chatId, forkId, leafSlotId, limit }) =>
      Effect.gen(function* () {
        const chat = yield* ownedChat(userId, chatId)
        const fork = yield* liveFork(chat, forkId ?? null)
        const leaf = (leafSlotId ?? fork.tip_slot_id) as SlotId | null
        if ((yield* placedInsertions(sql, chatId, fork.id)).length === 0) {
          // No insertions: the display path is the structural one, read as before.
          if (leaf === null) return { entries: [], olderLeafSlotId: null, tipSlotId: fork.tip_slot_id as SlotId | null }
          const rows = byDepth(yield* pathWindow(sql, chatId, leaf, limit, fork.id))
          if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: leaf })
          // Deleted messages are walked through but not shown; their replies stay in place.
          return {
            entries: rows.filter((row) => row.slot_deleted === 0).map(toPathEntry),
            olderLeafSlotId: rows[0]!.parent_slot_id as SlotId | null,
            tipSlotId: fork.tip_slot_id as SlotId | null
          }
        }
        // The last `limit` positions up to the leaf, or up to the display end.
        const shown = yield* displayTo(chatId, fork, leafSlotId)
        if (shown.end < 0) return { entries: [], olderLeafSlotId: null, tipSlotId: fork.tip_slot_id as SlotId | null }
        const first = Math.max(0, shown.end - limit + 1)
        const rows = yield* displayWindow(sql, shown.pieces, first, shown.end, fork.id)
        return {
          entries: rows.filter((row) => row.slot_deleted === 0).map(toPathEntry),
          olderLeafSlotId: (yield* slotAtPosition(sql, shown.pieces, first - 1)) as SlotId | null,
          tipSlotId: fork.tip_slot_id as SlotId | null
        }
      }).pipe(query("GetPath")),

    // The message's own versions, each as the fork shows it: a copy it amended in its
    // original's place, with the fork's flags.
    ListVersions: ({ userId, slotId, forkId }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ chat_id: ChatId }>`
          SELECT s.chat_id FROM slots s JOIN chats c ON c.id = s.chat_id
          WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "slot", id: slotId })
        const fork = forkId
          ? (yield* liveFork(yield* ownedChat(userId, owned.chat_id), forkId)).id
          : yield* forkAt(sql, owned.chat_id, slotId)
        const rows = yield* sql<VersionRow>`
          SELECT ${sql.literal(shownVersionColumns)} FROM versions o ${shownJoin(sql, fork)}
          JOIN slots s ON s.id = o.slot_id
          WHERE o.slot_id = ${slotId} AND o.fork_id IS NULL AND NOT ${versionDeletedIn(sql, fork, "o")}
            AND NOT ${slotDeletedIn(sql, fork, "s")}
          ORDER BY o.ordinal`
        if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: slotId })
        return rows.map(toVersion)
      }).pipe(query("ListVersions")),

    StateEventsAt: ({ userId, chatId, slotId, forkId, leafSlotId, displayEnd }) =>
      Effect.gen(function* () {
        const chat = yield* ownedChat(userId, chatId)
        if (slotId !== null) yield* liveSlot(chatId, slotId)
        if (leafSlotId != null) yield* liveSlot(chatId, leafSlotId)
        const fork = forkId ? (yield* liveFork(chat, forkId)).id : yield* forkAt(sql, chatId, leafSlotId ?? slotId)
        let at = slotId
        if (displayEnd && fork !== null) {
          const viewed = yield* liveFork(chat, fork as ForkId)
          if (viewed.tip_slot_id === slotId) at = (yield* displayEndOf(sql, chatId, viewed)) as SlotId | null
        }
        const rows = yield* stateEventsThrough(sql, chatId, at, fork)
        const events = yield* Effect.forEach(rows, (row) =>
          decodeStateEvent({ scope: row.scope, data: { key: row.key, value: JSON.parse(row.value_json) } }).pipe(
            Effect.mapError(
              (error) => new StorageError({ reason: "corrupt", operation: "StateEventsAt", message: error.message })
            )
          )
        )
        return yield* withoutPurged(sql, events)
      }).pipe(query("StateEventsAt")),

    ListBin: ({ userId, limit, before }) =>
      sql<Parameters<typeof toBinItem>[0]>`
        SELECT b.*, (SELECT v.doc_json FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          JOIN entity_revisions v ON v.id = r.head_revision_id
          WHERE b.kind = 'entity' AND e.kind = 'card' AND e.id = b.target_id
          LIMIT 1) AS card_doc_json
        FROM bin_items b WHERE user_id = ${userId}
          AND (${before?.id ?? null} IS NULL OR (deleted_at, id) < (${before?.deletedAt ?? null}, ${before?.id ?? null}))
        ORDER BY deleted_at DESC, id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) => rows.map(toBinItem)),
        query("ListBin")
      ),

    BinItemForks: ({ userId, itemIds }) => binItemForks(sql, userId, itemIds).pipe(query("BinItemForks")),
    BinItemBranches: ({ userId, itemIds }) => binItemBranches(sql, userId, itemIds).pipe(query("BinItemBranches")),

    ListRecoveredTexts: ({ userId, source, limit, before }) =>
      sql<Parameters<typeof toRecoveredText>[0]>`
        SELECT * FROM recovered_texts WHERE user_id = ${userId}
          AND (${source?.targetKind ?? null} IS NULL OR (source_kind = ${source?.targetKind ?? null}
            AND source_id = ${source?.targetId ?? null} AND source_field = ${source?.field ?? null}))
          AND (${before?.id ?? null} IS NULL OR (created_at, id) < (${before?.createdAt ?? null}, ${before?.id ?? null}))
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) => rows.map((row) => toRecoveredText(row, false))),
        query("ListRecoveredTexts")
      ),

    GetRecoveredText: ({ userId, id }) =>
      sql<
        Parameters<typeof toRecoveredText>[0]
      >`SELECT * FROM recovered_texts WHERE id = ${id} AND user_id = ${userId}`.pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(toRecoveredText(row, true)) : Effect.fail(new NotFound({ entity: "recovered text", id }))
        ),
        query("GetRecoveredText")
      ),

    GetDraft: ({ userId, key }) =>
      drafts.find(userId, key).pipe(
        Effect.map((row) => (row ? drafts.toDraft(row) : null)),
        query("GetDraft")
      ),

    ListActiveDrafts: ({ userId }) => drafts.listActive(userId).pipe(query("ListActiveDrafts")),

    ListMessageDrafts: ({ userId, chatId }) =>
      drafts.listMessageDrafts(userId, chatId).pipe(query("ListMessageDrafts")),

    GetComposerImages: ({ userId, chatId, draftId, ids }) =>
      composerImages(sql).read(userId, chatId, draftId, ids).pipe(query("GetComposerImages")),
    GetComposerChoice: ({ userId, chatId, draftId }) =>
      drafts.composerChoice(userId, chatId, draftId).pipe(query("GetComposerChoice")),

    ComposerHistory: ({ userId, chatId, draftId, limit }) =>
      Effect.gen(function* () {
        const draft = yield* drafts.findComposer(userId, chatId, draftId)
        if (draft === null) return yield* new NotFound({ entity: "draft", id: draftId })
        return yield* drafts.history(draft, limit)
      }).pipe(query("ComposerHistory")),

    DraftHistory: ({ userId, key, limit, before }) =>
      Effect.flatMap(drafts.get(userId, key), (draft) => drafts.history(draft, limit, before)).pipe(
        query("DraftHistory")
      ),

    GetDraftState: ({ userId, key, seq }) =>
      Effect.flatMap(drafts.get(userId, key), (draft) => drafts.stateAt(draft, seq)).pipe(
        Effect.map((content) => ({ seq, content })),
        query("GetDraftState")
      ),

    ListArchiveCandidates: ({ userId, criteria }) =>
      archiveCandidates(sql, userId, criteria).pipe(query("ListArchiveCandidates")),
    ListLibrary: ({ userId, kind, tag, archived, withFilterData }) =>
      lib
        .refsWhere(
          // A note an agent reply wrote (its first revision the reply's, as `agentWrittenNotes`
          // reads it) belongs to that reply, shown only where it is: never in the library's list.
          `e.owner_user_id = ? AND e.kind = ? AND e.deleted_at IS NULL
           AND (e.archived_at IS NOT NULL) = ?
           AND (? IS NULL OR EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = ?))
           AND (e.kind <> 'note' OR (SELECT f.origin FROM entity_revisions f WHERE f.entity_id = e.id
             ORDER BY f.seq LIMIT 1) IS NOT 'generation')`,
          [userId, kind, archived ? 1 : 0, tag, tag]
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.gen(function* () {
              if (!withFilterData || kind !== "card" || !rows.length) return rows.map(toLibraryRef)
              const data = yield* sql<{ id: string; source_path: string | null; tags: string | null }>`
              SELECT r.id, r.source_path, json_extract(h.doc_json, '$.tags') AS tags
              FROM entity_refs r JOIN entities e ON e.id = r.entity_id
              JOIN entity_revisions h ON h.id = r.head_revision_id
              WHERE e.owner_user_id = ${userId} AND r.id IN ${sql.in(rows.map((r) => r.id))}`
              const byId = new Map(data.map((row) => [row.id, row]))
              return rows.map((row) => {
                const extra = byId.get(row.id)
                const filename = extra?.source_path
                  ?.replaceAll("\\", "/")
                  .split("/")
                  .at(-1)
                  ?.replace(/\.[^.]*$/, "")
                return new LibraryRef({
                  ...toLibraryRef(row),
                  filterData: {
                    name: filename || row.label,
                    tags: extra?.tags ? (JSON.parse(extra.tags) as Array<string>) : []
                  }
                })
              })
            })
          ),
          query("ListLibrary")
        ),

    GetRef: ({ userId, refId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        return { ref: toLibraryRef(ref), doc: yield* lib.loadDoc(ref.head_revision_id) }
      }).pipe(query("GetRef")),

    RefHistory: ({ userId, refId, limit, before, chatNote }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        // A chat's own note: its line as the branch at that position has it.
        const head = yield* lib.loadDoc(ref.head_revision_id)
        const resolved =
          chatNote && (head.owner as { chat?: string } | undefined)?.chat === chatNote.chatId
            ? yield* noteHere(sql, lib, userId, ref, chatNote)
            : null
        let start: string | null = resolved?.ref.head_revision_id ?? ref.head_revision_id
        // A fork's line runs on through what it was forked from (owner, 2026-11-06: a fork's
        // History is a git branch's log), so the cursor can be an entry's it was forked from.
        if (before !== undefined) {
          if (!(yield* revisionOnLine(sql, start, before)))
            return yield* new NotFound({ entity: "revision", id: before })
          const [cursor] = yield* sql<{ previous: string | null }>`
            SELECT ${sql.literal(previousRevisionSql("r"))} AS previous FROM entity_revisions r
            WHERE r.id = ${before}`
          if (!cursor) return yield* new NotFound({ entity: "revision", id: before })
          start = cursor.previous
        }
        const rows = yield* sql<{
          id: string
          entity_id: string
          parents: string
          origin: Revision["origin"]
          origin_ref: string | null
          message: string | null
          doc_hash: string
          created_at: number
          n: number
          previous: string | null
          forked_from_entity_id: string | null
        }>`
          WITH RECURSIVE history(id, n) AS (
            SELECT ${start}, 1
            UNION ALL
            SELECT ${sql.literal(previousRevisionSql("r"))}, h.n + 1 FROM entity_revisions r JOIN history h ON r.id = h.id
            WHERE ${sql.literal(previousRevisionSql("r"))} IS NOT NULL AND h.n < ${limit}
          )
          SELECT r.id, r.entity_id, r.parents, r.origin, r.origin_ref, r.message, r.doc_hash, r.created_at, h.n,
            ${sql.literal(previousRevisionSql("r"))} AS previous, e.forked_from_entity_id
          FROM history h JOIN entity_revisions r ON r.id = h.id JOIN entities e ON e.id = r.entity_id ORDER BY h.n`
        const first = start === null ? 0 : yield* revisionNumber(sql, start)
        const changedAt = resolved
          ? yield* noteChangedAt(
              sql,
              chatNote!.chatId,
              resolved.fork,
              rows.map((row) => row.id)
            )
          : null
        // A fork's first revision continues down the line at the revision it was forked from.
        const forkPoint = (row: (typeof rows)[number]) =>
          row.previous !== null && JSON.parse(row.parents).length === 0 && row.forked_from_entity_id !== null
        const own = ref.entity_id
        const entryIds = [
          ...new Set(
            rows.flatMap((row) => [
              ...(row.entity_id !== own ? [row.entity_id] : []),
              ...(forkPoint(row) ? [row.forked_from_entity_id!] : [])
            ])
          )
        ]
        const entries = new Map(
          entryIds.length === 0
            ? []
            : (yield* sql<{ id: string; ref_id: string | null; label: string | null; subtitle: string | null }>`
                SELECT e.id, CASE WHEN e.deleted_at IS NULL THEN rf.id END AS ref_id, rf.label, rf.subtitle FROM entities e
                LEFT JOIN entity_refs rf ON rf.entity_id = e.id WHERE e.id IN ${sql.in(entryIds)}`).map((e) => [
                e.id,
                {
                  entityId: e.id as EntityId,
                  refId: e.ref_id as RefId | null,
                  label: e.label ?? "",
                  subtitle: e.subtitle ?? ""
                }
              ])
        )
        const out = []
        for (const row of rows) {
          const at = changedAt?.get(row.id)
          const usedBy = row.origin === "generation" ? yield* revisionUse(sql, userId, row.origin_ref) : null
          const entry = row.entity_id !== own ? entries.get(row.entity_id) : undefined
          const from = forkPoint(row) ? entries.get(row.forked_from_entity_id!) : undefined
          out.push(
            new Revision({
              id: row.id as RevisionId,
              parents: JSON.parse(row.parents) as Array<RevisionId>,
              origin: row.origin,
              message: row.message,
              docHash: row.doc_hash,
              createdAt: row.created_at,
              number: first - row.n + 1,
              ...(usedBy ? { usedBy } : {}),
              ...(at ? { changedAt: at } : {}),
              ...(entry ? { entry } : {}),
              ...(from ? { forkedFrom: { revisionId: row.previous as RevisionId, ...from } } : {})
            })
          )
        }
        return out
      }).pipe(query("RefHistory")),

    ForkMergeStatus: ({ userId, refId }) => forkMerge.status(userId, refId).pipe(query("ForkMergeStatus")),
    PreviewForkMerge: ({ userId, refId, theirsRevisionId }) =>
      forkMerge.preview(userId, refId, theirsRevisionId).pipe(
        Effect.map((p) => p.value),
        query("PreviewForkMerge")
      ),
    LibraryGenealogy: ({ userId, refId }) => forkMerge.genealogy(userId, refId).pipe(query("LibraryGenealogy")),

    PreviewMerge: ({ userId, refId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.followed_head === null) {
          return yield* new RefOperationRefused({
            refId,
            reason: "This ref follows nothing, so there's nothing to merge."
          })
        }
        const plan = yield* lib.planMerge(ref)
        return new MergePreview({
          outcome: plan.outcome,
          merged: plan.merged,
          conflicts: plan.conflicts,
          theirsRevisionId: plan.theirsHead as RevisionId
        })
      }).pipe(query("PreviewMerge")),

    // --- Chats

    // Most recent first, by last message, else creation (DESIGN §2.1). A card's list puts
    // its chats with a message before those without, so its first is the chat Continue
    // opens (CardUsage). `search` finds a chat by its title or by a card in it.
    ListChats: ({ userId, limit, before, entityId, search }) =>
      Effect.gen(function* () {
        if (entityId !== undefined) {
          const [card] = yield* sql<{ n: number }>`
            SELECT count(*) AS n FROM entities
            WHERE id = ${entityId} AND owner_user_id = ${userId} AND kind = 'card' AND purged_at IS NULL`
          if (card?.n !== 1) return yield* new NotFound({ entity: "card", id: entityId })
        }
        const ranked = entityId === undefined ? 0 : 1
        // SQLite LIKE's case folding is ASCII-only. Treat wildcard characters literally.
        const fold = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase())
        const needle = search ? fold(search) : null
        const pattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null
        // A superset of the matches, so `chatCast` resolves only plausible chats: the title, any
        // ref's head of a card in the chat (the derived label and subtitle caches, and the
        // nickname), or any revision a binding in the chat pins.
        const rows = yield* sql<ChatRow>`
          SELECT * FROM chats WHERE owner_user_id = ${userId} AND deleted_at IS NULL
            AND (${before?.id ?? null} IS NULL
              OR (${ranked} * (last_message_at IS NOT NULL), coalesce(last_message_at, created_at), id)
                < (${ranked * (before?.empty === true ? 0 : 1)}, ${before?.at ?? null}, ${before?.id ?? null}))
            AND (${entityId ?? null} IS NULL OR id IN (
              SELECT s.chat_id FROM card_chat_membership s WHERE s.entity_id = ${entityId ?? null}))
            AND (${pattern} IS NULL OR title LIKE ${pattern} ESCAPE '\\' OR id IN (
              SELECT s.chat_id FROM card_chat_membership s
              WHERE s.entity_id IN (
                  SELECT r.entity_id FROM entity_refs r
                  JOIN entities e ON e.id = r.entity_id
                  LEFT JOIN card_summaries cs ON cs.revision_id = r.head_revision_id
                  WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL
                    AND (r.label LIKE ${pattern} ESCAPE '\\'
                      OR r.subtitle LIKE ${pattern} ESCAPE '\\'
                      OR json_extract(cs.fields, '$[1]') LIKE ${pattern} ESCAPE '\\'))
            ) OR id IN (
              SELECT s.chat_id FROM state_events s
              JOIN card_summaries cs ON cs.revision_id = json_extract(s.value_json, '$.revision')
              WHERE s.key = 'card.binding'
                AND EXISTS (SELECT 1 FROM card_chat_membership m WHERE m.chat_id = s.chat_id
                  AND m.entity_id = json_extract(s.value_json, '$.entity'))
                AND (json_extract(cs.fields, '$[0]') LIKE ${pattern} ESCAPE '\\'
                  OR json_extract(cs.fields, '$[2]') LIKE ${pattern} ESCAPE '\\'
                  OR json_extract(cs.fields, '$[1]') LIKE ${pattern} ESCAPE '\\')))
          ORDER BY ${ranked} * (last_message_at IS NOT NULL) DESC, coalesce(last_message_at, created_at) DESC, id DESC
          LIMIT ${needle === null ? limit : -1}`
        if (needle === null) return rows.map(toChat)
        const found: Array<ChatRow> = []
        for (const row of rows) {
          const cast = fold(row.title).includes(needle)
            ? []
            : yield* chatCast(sql, userId, row.id as ChatId, row.active_leaf_slot_id)
          if (
            fold(row.title).includes(needle) ||
            cast.some((card) =>
              [card.name, card.subtitle, card.modelName].some((text) => fold(text ?? "").includes(needle))
            )
          )
            found.push(row)
          if (found.length === limit) break
        }
        return found.map(toChat)
      }).pipe(query("ListChats")),

    ReadPath: ({ userId, chatId, forkId, leafSlotId, range, limit }) =>
      Effect.gen(function* () {
        const chat = yield* ownedChat(userId, chatId)
        // By fork, unless a leaf is named: the path to it, which no fork need end at, as the
        // fork named (or the current one) shows it.
        const fork = yield* liveFork(chat, forkId ?? null)
        const leaf = (leafSlotId ?? fork.tip_slot_id) as SlotId | null
        let shownFork = (leafSlotId === null ? fork.id : null) as ForkId | null
        let view: string = fork.id
        // A fork with insertions is read by position on its display path.
        if ((yield* placedInsertions(sql, chatId, fork.id)).length > 0)
          return yield* readDisplay(chatId, fork, leafSlotId, range, limit)
        if (leaf === null)
          return new PathWindow({ leafSlotId: null, forkId: shownFork, entries: [], older: null, newer: null })
        // Deleted messages are walked through but not shown; their replies stay in place.
        const window = (leafSlotId: SlotId, rows: ReadonlyArray<PathRow>, newer: SlotId | null, withOlder = true) =>
          new PathWindow({
            leafSlotId,
            forkId: shownFork,
            entries: rows.filter((row) => row.slot_deleted === 0).map(toPathEntry),
            older: withOlder ? ((rows[0]?.parent_slot_id ?? null) as SlotId | null) : null,
            newer
          })
        const leafSlot = yield* slotIn(chatId, leaf)
        switch (range._tag) {
          case "Bottom":
            return window(leaf, yield* windowEndingAt(chatId, leaf, limit, view), null)
          case "Older": {
            yield* slotIn(chatId, range.from)
            return window(leaf, yield* windowEndingAt(chatId, range.from, limit, view), null)
          }
          case "Newer": {
            const after = yield* slotIn(chatId, range.after)
            const last = yield* walkTowards(sql, leafSlot, after, limit)
            if (last === null) return window(leaf, [], null, false)
            const rows = yield* windowEndingAt(chatId, last.id, last.depth - after.depth, view)
            return window(leaf, rows, last.id === leaf ? null : last.id, false)
          }
          case "Around": {
            const anchor = yield* slotIn(chatId, range.slot)
            // The anchor and about half the window above it, the rest below, filled up
            // from the other side near the root or the leaf.
            const top = Math.max(0, anchor.depth - Math.ceil(limit / 2) + 1)
            const lastDepthOn = (leafDepth: number) => Math.min(leafDepth, top + limit - 1)
            let pathLeaf = leafSlot
            let lastDepth = lastDepthOn(pathLeaf.depth)
            let found =
              anchor.depth <= pathLeaf.depth ? yield* ancestorsAt(sql, pathLeaf, [anchor.depth, lastDepth]) : null
            if (found?.get(anchor.depth) !== anchor.id) {
              // A slot on another path opens the fork through it that was current most
              // recently, or with none, the path through it on its latest replies.
              const through = yield* forkThrough(sql, chatId, anchor.id)
              if (through !== null && (yield* placedInsertions(sql, chatId, through.id)).length > 0)
                return yield* readDisplay(chatId, fork, leafSlotId, range, limit)
              shownFork = (through?.id ?? null) as ForkId | null
              view = through?.id ?? view
              pathLeaf = yield* slotIn(chatId, (through?.tip_slot_id ?? (yield* latestDescendant(anchor.id))) as SlotId)
              lastDepth = lastDepthOn(pathLeaf.depth)
              found = yield* ancestorsAt(sql, pathLeaf, [lastDepth])
            }
            const end = found.get(lastDepth)!
            const first = Math.max(0, lastDepth - limit + 1)
            const rows = yield* windowEndingAt(chatId, end, lastDepth - first + 1, view)
            return window(pathLeaf.id, rows, end === pathLeaf.id ? null : end)
          }
        }
      }).pipe(query("ReadPath")),

    // --- Branches (DESIGN §3.2) and forks
    PreviewForkNotes: (payload) => previewForkNotes(sql, payload).pipe(query("PreviewForkNotes")),

    ListForks: ({ userId, chatId }) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        const rows = yield* sql<Parameters<typeof toFork>[0]>`
          SELECT ${sql.literal(forkColumns("f"))} FROM forks f WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
          ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
        // Where each parts from its parent and its last message's time, as the shell lists them.
        const summaries = yield* chatForkSummaries(sql, userId, chatId, rows)
        // The thread sets each is in, of those still shown (two threads with a live fork).
        const shown = shownSplits(rows.map((row) => summaries.get(row.id)?.threads ?? []))
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const s = summaries.get(row.id)
            const threads = (s?.threads ?? []).filter((place) => shown.has(place.splitId))
            return new Fork({
              ...toFork(row),
              startSlotId: (yield* branchStart(sql, row)) as SlotId | null,
              tipExcerpt: s?.preview ?? "",
              split: s?.split ?? null,
              endAt: s?.endAt ?? null,
              ...(threads.length > 0 ? { threads } : {})
            })
          })
        )
      }).pipe(query("ListForks")),

    // The siblings SwitchBranch counts, in its order, with each one's name and first words.
    ListBranches: ({ userId, slotId, forkId }) =>
      Effect.gen(function* () {
        const [slot] = yield* sql<{
          chat_id: string
          parent_slot_id: string | null
          inserted: number
        }>`
          SELECT s.chat_id, s.parent_slot_id, s.inserted FROM slots s JOIN chats c ON c.id = s.chat_id
          WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!slot) return yield* new NotFound({ entity: "slot", id: slotId })
        // Each alternate's first words as the fork named shows them, else the fork through it.
        const shown = forkId
          ? (yield* liveFork(yield* ownedChat(userId, slot.chat_id as ChatId), forkId)).id
          : yield* forkAt(sql, slot.chat_id, slotId)
        const columns = sql`x.id, ${sql.literal(branchLabel("x"))} AS branch_name, CASE WHEN NOT ${slotDeletedIn(sql, shown, "x")}
          THEN substr((SELECT v.content FROM version_records v WHERE v.id = ${shownIn(sql, shown, "x")}), 1, 160)
          ELSE '' END AS preview`
        // An inserted message has no alternates: it's the only one at its place.
        const rows =
          slot.inserted === 1
            ? yield* sql<{ id: SlotId; branch_name: string | null; preview: string }>`
                SELECT ${columns} FROM slots x WHERE x.id = ${slotId}`
            : slot.parent_slot_id === null
              ? yield* sql<{ id: SlotId; branch_name: string | null; preview: string }>`
                SELECT ${columns} FROM slots x INDEXED BY slots_chat_depth WHERE x.chat_id = ${slot.chat_id}
                  AND x.depth = 0 AND ${sql.literal(reachableSlot("x"))}
                ORDER BY x.id`
              : yield* sql<{ id: SlotId; branch_name: string | null; preview: string }>`
                SELECT ${columns} FROM slots x INDEXED BY slots_parent WHERE x.parent_slot_id = ${slot.parent_slot_id}
                  AND x.chat_id = ${slot.chat_id} AND ${sql.literal(reachableSlot("x"))}
                ORDER BY x.id`
        return rows.map(
          (row, index) => new Branch({ slotId: row.id, index, name: row.branch_name, preview: row.preview })
        )
      }).pipe(query("ListBranches")),

    GetSlot: ({ userId, slotId, forkId, onForkOnly }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ chat_id: ChatId }>`
          SELECT s.chat_id FROM slots s JOIN chats c ON c.id = s.chat_id
          WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "slot", id: slotId })
        const fork = forkId
          ? (yield* liveFork(yield* ownedChat(userId, owned.chat_id), forkId)).id
          : yield* forkAt(sql, owned.chat_id, slotId)
        let position: number | null = null
        if (onForkOnly) {
          const shown = yield* liveFork(yield* ownedChat(userId, owned.chat_id), fork as ForkId | null)
          const place = yield* slotPlace(sql, owned.chat_id, slotId)
          const pieces = yield* pathPieces(sql, owned.chat_id, shown.id, shown.tip_slot_id)
          position = place === null ? null : positionOf(pieces, place)
          if (position === null) return yield* new NotFound({ entity: "slot on branch", id: slotId })
        }
        const [row] = yield* sql<PathRow>`
          SELECT ${withFork(sql, fork, pathColumns)}, ${fork} AS shown_fork_id FROM slots s ${viewJoin(sql, fork)}
          WHERE s.id = ${slotId}`
        if (row!.slot_deleted !== 0) return yield* new NotFound({ entity: "slot", id: slotId })
        return { chatId: owned.chat_id, entry: toPathEntry({ ...row!, ...(position === null ? {} : { position }) }) }
      }).pipe(query("GetSlot")),

    VersionAmendments: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql`SELECT v.id FROM versions v JOIN slots s ON s.id=v.slot_id
          JOIN chats c ON c.id=s.chat_id WHERE v.id=${versionId} AND c.owner_user_id=${userId}
          AND c.deleted_at IS NULL AND s.deleted_at IS NULL AND v.deleted_at IS NULL AND v.purged_at IS NULL
          AND v.writer='human'`
        if (!owned) return yield* new NotFound({ entity: "human version", id: versionId })
        const rows = yield* sql<{ id: number; content: string; at: number; images_json: string | null }>`
          SELECT id, content, replaced_at AS at, images_json
          FROM version_history WHERE version_id=${versionId} ORDER BY id DESC`
        return rows.map(({ images_json, ...row }) =>
          images_json === null ? row : { ...row, images: JSON.parse(images_json) as MessageImages }
        )
      }).pipe(query("VersionAmendments")),

    GetVersion: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<VersionRow>`
          SELECT v.*, ${sql.literal(versionExtras("v"))} FROM version_records v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "version", id: versionId })
        return toVersion(row)
      }).pipe(query("GetVersion")),

    LiveVersions: ({ userId, versionIds }) =>
      (versionIds.length === 0
        ? Effect.succeed([])
        : sql<{ id: VersionId }>`
            SELECT v.id FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
            WHERE ${sql.in("v.id", versionIds)} AND c.owner_user_id = ${userId}
              AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
            Effect.map((rows) => rows.map((row) => row.id))
          )
      ).pipe(query("LiveVersions"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
