import { contextExcluded } from "./lcmVisibility.ts"
// Read operation handlers. They run inside the reader workers on read-only connections.
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import { PathWindow } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { MergePreview, Revision, type RevisionId } from "@rp/shared/library.ts"
import { FoldableEvent } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { toBinItem, toRecoveredText } from "./bin.ts"
import { reachableSlot } from "./graphReachability.ts"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef } from "./library.ts"
import { NotFound, ReadOps, RefOperationRefused, StorageError } from "./ops.ts"
import {
  versionExtras,
  type ChatRow,
  type PathRow,
  toChat,
  toPathEntry,
  toUser,
  toVersion,
  type UserRow,
  type VersionRow
} from "./rows.ts"
import { withoutPurged } from "./stateRefs.ts"
import { query } from "./tx.ts"

const decodeStateEvent = Schema.decodeUnknownEffect(FoldableEvent)

/** The slots from `leaf` up to the root (DATA-MODEL §4.4), or up to `limit` of them. */
const pathCte = (sql: SqlClient.SqlClient, chatId: ChatId, leaf: SlotId, limit: number | null) => sql`
  WITH RECURSIVE path(id, n) AS (
    SELECT id, 1 FROM slots WHERE id = ${leaf} AND chat_id = ${chatId}
    UNION ALL
    SELECT s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.id
    WHERE s.parent_slot_id IS NOT NULL AND (${limit} IS NULL OR p.n < ${limit})
  )`

/**
 * The alternate branches at slot `s` (DESIGN §3.2), with `also` on top: its siblings in
 * its lane that a path can reach, which is what `latestDescendant` follows. Roots are
 * found by chat and depth, the rest by parent, so the cost is the number of siblings. The
 * indexes are named: left to itself, SQLite took the lane's, which scans the whole lane for
 * every entry (5 s for a 60-slot window of the 100,000-message perf fixture).
 */
const siblingCount = (also = "") => {
  const reachable = `x.lane_id = s.lane_id ${also} AND ${reachableSlot("x")}`
  return `CASE WHEN s.parent_slot_id IS NULL
    THEN (SELECT count(*) FROM slots x INDEXED BY slots_chat_depth WHERE x.chat_id = s.chat_id AND x.depth = 0 AND ${reachable})
    ELSE (SELECT count(*) FROM slots x INDEXED BY slots_parent WHERE x.parent_slot_id = s.parent_slot_id AND ${reachable}) END`
}

/** A path entry's columns: the slot's, and its selected version's under their own names. */
const pathColumns = `v.id, v.slot_id, v.ordinal, v.status, v.speaker_entity_id, v.writer, v.content,
  v.macro_mode, v.origin, v.source_version_id, v.direction, v.hidden, v.starred, v.created_at, v.error_json, v.mark,
  v.frozen_macros, v.rollout_id,
  ${versionExtras("v")}, s.lane_id, s.parent_slot_id, s.depth, s.row_version, ${contextExcluded()} AS context_excluded,
  s.deleted_at IS NOT NULL AS slot_deleted,
  (SELECT count(*) FROM versions c WHERE c.slot_id = s.id AND c.deleted_at IS NULL) AS version_count,
  ${siblingCount()} AS branch_count, ${siblingCount("AND x.id < s.id")} AS branch_index,
  (SELECT f.writer = 'human' AND f.origin <> 'greeting' FROM versions f WHERE f.slot_id = s.id
    ORDER BY f.ordinal LIMIT 1) AS user_side`

/** The window of at most `limit` slots ending at `leaf`, root first, deleted ones included. */
export const pathWindow = (sql: SqlClient.SqlClient, chatId: ChatId, leaf: SlotId, limit: number) =>
  sql<PathRow>`
    ${pathCte(sql, chatId, leaf, limit)}
    SELECT ${sql.literal(pathColumns)}
    FROM path JOIN slots s ON s.id = path.id JOIN versions v ON v.id = s.selected_version_id
    ORDER BY s.depth`

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
          SELECT c.id, c.depth, d.n + 1 FROM down d JOIN slots c ON c.parent_slot_id = d.id
          WHERE d.n < ${remaining} AND d.id <> ${leaf.id}
            AND (SELECT count(*) FROM slots x WHERE x.parent_slot_id = d.id) = 1
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
  const lib = makeLibraryQueries(sql)
  const drafts = makeDraftStore(sql)

  const ownedChat = (userId: UserId, chatId: ChatId) =>
    sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))))
    )

  const windowEndingAt = (chatId: ChatId, leaf: SlotId, limit: number) => pathWindow(sql, chatId, leaf, limit)

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
    sql<{ id: string }>`SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.void : Effect.fail(new NotFound({ entity: "slot", id: slotId }))))
    )

  const handlers = {
    FindUserByHandle: ({ handle }) =>
      sql<UserRow>`SELECT * FROM users WHERE handle = ${handle}`.pipe(
        Effect.map(([row]) => (row ? toUser(row) : null)),
        query("FindUserByHandle")
      ),

    GetChat: ({ userId, chatId }) => ownedChat(userId, chatId).pipe(Effect.map(toChat), query("GetChat")),

    GetPath: ({ userId, chatId, leafSlotId, limit }) =>
      Effect.gen(function* () {
        const chat = yield* ownedChat(userId, chatId)
        const leaf = (leafSlotId ?? chat.active_leaf_slot_id) as SlotId | null
        if (leaf === null) return { entries: [], olderLeafSlotId: null }
        const rows = yield* pathWindow(sql, chatId, leaf, limit)
        if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: leaf })
        // Deleted messages are walked through but not shown; their replies stay in place.
        return {
          entries: rows.filter((row) => row.slot_deleted === 0).map(toPathEntry),
          olderLeafSlotId: rows[0]!.parent_slot_id as SlotId | null
        }
      }).pipe(query("GetPath")),

    ListVersions: ({ userId, slotId }) =>
      Effect.gen(function* () {
        const rows = yield* sql<VersionRow>`
          SELECT v.*, ${sql.literal(versionExtras("v"))} FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          WHERE v.slot_id = ${slotId} AND c.owner_user_id = ${userId}
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL
          ORDER BY v.ordinal`
        if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: slotId })
        return rows.map(toVersion)
      }).pipe(query("ListVersions")),

    StateEventsAt: ({ userId, chatId, slotId }) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        if (slotId !== null) yield* liveSlot(chatId, slotId)
        const rows =
          slotId === null
            ? yield* sql<{ key: string; scope: string | null; value_json: string }>`
                SELECT key, scope, value_json FROM state_events
                WHERE chat_id = ${chatId} AND slot_id IS NULL AND superseded_by_changeset IS NULL
                ORDER BY seq`
            : yield* sql<{ key: string; scope: string | null; value_json: string }>`
                ${pathCte(sql, chatId, slotId, null)}
                SELECT e.key, e.scope, e.value_json
                FROM state_events e
                LEFT JOIN path p ON p.id = e.slot_id
                LEFT JOIN slots s ON s.id = p.id
                WHERE e.chat_id = ${chatId} AND e.superseded_by_changeset IS NULL
                  AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
                  AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
                ORDER BY coalesce(s.depth, -1), e.seq`
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
        SELECT * FROM bin_items WHERE user_id = ${userId}
          AND (${before?.id ?? null} IS NULL OR (deleted_at, id) < (${before?.deletedAt ?? null}, ${before?.id ?? null}))
        ORDER BY deleted_at DESC, id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) => rows.map(toBinItem)),
        query("ListBin")
      ),

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

    ComposerHistory: ({ userId, chatId, draftId, limit }) =>
      Effect.gen(function* () {
        const draft = yield* drafts.findComposer(userId, chatId, draftId)
        if (draft === null) return yield* new NotFound({ entity: "draft", id: draftId })
        return yield* drafts.history(draft, limit)
      }).pipe(query("ComposerHistory")),

    DraftHistory: ({ userId, key, limit }) =>
      Effect.flatMap(drafts.get(userId, key), (draft) => drafts.history(draft, limit)).pipe(query("DraftHistory")),

    GetDraftState: ({ userId, key, seq }) =>
      Effect.flatMap(drafts.get(userId, key), (draft) => drafts.stateAt(draft, seq)).pipe(
        Effect.map((content) => ({ seq, content })),
        query("GetDraftState")
      ),

    ListLibrary: ({ userId, kind, tag, archived }) =>
      lib
        .refsWhere(
          `e.owner_user_id = ? AND e.kind = ? AND r.ref_kind <> 'chat_override' AND e.deleted_at IS NULL
           AND (e.archived_at IS NOT NULL) = ?
           AND (? IS NULL OR EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = ?))`,
          [userId, kind, archived ? 1 : 0, tag, tag]
        )
        .pipe(
          Effect.map((rows) => rows.map(toLibraryRef)),
          query("ListLibrary")
        ),

    GetRef: ({ userId, refId }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        return { ref: toLibraryRef(ref), doc: yield* lib.loadDoc(ref.head_revision_id) }
      }).pipe(query("GetRef")),

    RefHistory: ({ userId, refId, limit }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        const rows = yield* sql<{
          id: string
          parents: string
          origin: Revision["origin"]
          message: string | null
          doc_hash: string
          created_at: number
        }>`
          WITH RECURSIVE history(id, n) AS (
            SELECT ${ref.head_revision_id}, 1
            UNION ALL
            SELECT json_extract(r.parents, '$[0]'), h.n + 1 FROM entity_revisions r JOIN history h ON r.id = h.id
            WHERE json_extract(r.parents, '$[0]') IS NOT NULL AND h.n < ${limit}
          )
          SELECT r.id, r.parents, r.origin, r.message, r.doc_hash, r.created_at
          FROM history h JOIN entity_revisions r ON r.id = h.id ORDER BY h.n`
        return rows.map(
          (row) =>
            new Revision({
              id: row.id as RevisionId,
              parents: JSON.parse(row.parents) as Array<RevisionId>,
              origin: row.origin,
              message: row.message,
              docHash: row.doc_hash,
              createdAt: row.created_at
            })
        )
      }).pipe(query("RefHistory")),

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

    ListChatOverrides: ({ userId, chatId }) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        const rows = yield* lib.refsWhere("r.chat_id = ? AND e.owner_user_id = ? AND e.deleted_at IS NULL", [
          chatId,
          userId
        ])
        return rows.map(toLibraryRef)
      }).pipe(query("ListChatOverrides")),

    // --- Chats

    ListChats: ({ userId, limit, before }) =>
      sql<ChatRow>`
        SELECT * FROM chats WHERE owner_user_id = ${userId} AND deleted_at IS NULL
          AND (${before?.id ?? null} IS NULL
            OR (coalesce(last_message_at, created_at), id) < (${before?.at ?? null}, ${before?.id ?? null}))
        ORDER BY coalesce(last_message_at, created_at) DESC, id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) => rows.map(toChat)),
        query("ListChats")
      ),

    ReadPath: ({ userId, chatId, leafSlotId, range, limit }) =>
      Effect.gen(function* () {
        const chat = yield* ownedChat(userId, chatId)
        const leaf = (leafSlotId ?? chat.active_leaf_slot_id) as SlotId | null
        if (leaf === null) return new PathWindow({ leafSlotId: null, entries: [], older: null, newer: null })
        // Deleted messages are walked through but not shown; their replies stay in place.
        const window = (leafSlotId: SlotId, rows: ReadonlyArray<PathRow>, newer: SlotId | null, withOlder = true) =>
          new PathWindow({
            leafSlotId,
            entries: rows.filter((row) => row.slot_deleted === 0).map(toPathEntry),
            older: withOlder ? ((rows[0]?.parent_slot_id ?? null) as SlotId | null) : null,
            newer
          })
        const leafSlot = yield* slotIn(chatId, leaf)
        switch (range._tag) {
          case "Bottom":
            return window(leaf, yield* windowEndingAt(chatId, leaf, limit), null)
          case "Older": {
            yield* slotIn(chatId, range.from)
            return window(leaf, yield* windowEndingAt(chatId, range.from, limit), null)
          }
          case "Newer": {
            const after = yield* slotIn(chatId, range.after)
            const last = yield* walkTowards(sql, leafSlot, after, limit)
            if (last === null) return window(leaf, [], null, false)
            const rows = yield* windowEndingAt(chatId, last.id, last.depth - after.depth)
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
              // A slot on another path opens the path through it, on its latest replies.
              pathLeaf = yield* slotIn(chatId, yield* latestDescendant(anchor.id))
              lastDepth = lastDepthOn(pathLeaf.depth)
              found = yield* ancestorsAt(sql, pathLeaf, [lastDepth])
            }
            const end = found.get(lastDepth)!
            const first = Math.max(0, lastDepth - limit + 1)
            const rows = yield* windowEndingAt(chatId, end, lastDepth - first + 1)
            return window(pathLeaf.id, rows, end === pathLeaf.id ? null : end)
          }
        }
      }).pipe(query("ReadPath")),

    // --- Branches (DESIGN §3.2)
    BranchTip: ({ userId, chatId, slotId, index }) =>
      Effect.gen(function* () {
        const chat = yield* ownedChat(userId, chatId)
        const [slot] = yield* sql<{ parent_slot_id: string | null; lane_id: string }>`
          SELECT parent_slot_id, lane_id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`
        if (!slot) return yield* new NotFound({ entity: "slot", id: slotId })
        const [sibling] =
          slot.parent_slot_id === null
            ? yield* sql<{ id: SlotId }>`
                SELECT x.id FROM slots x INDEXED BY slots_chat_depth WHERE x.chat_id = ${chatId} AND x.depth = 0
                  AND x.lane_id = ${slot.lane_id} AND ${sql.literal(reachableSlot("x"))}
                ORDER BY x.id LIMIT 1 OFFSET ${index}`
            : yield* sql<{ id: SlotId }>`
                SELECT x.id FROM slots x INDEXED BY slots_parent WHERE x.parent_slot_id = ${slot.parent_slot_id}
                  AND x.lane_id = ${slot.lane_id} AND ${sql.literal(reachableSlot("x"))}
                ORDER BY x.id LIMIT 1 OFFSET ${index}`
        if (!sibling) return yield* new NotFound({ entity: "branch", id: `${slotId}#${index}` })
        return { slotId: sibling.id, tipSlotId: yield* latestDescendant(sibling.id), chatRowVersion: chat.row_version }
      }).pipe(query("BranchTip")),

    GetSlot: ({ userId, slotId }) =>
      sql<PathRow & { chat_id: ChatId }>`
        SELECT ${sql.literal(pathColumns)}, s.chat_id
        FROM slots s JOIN chats c ON c.id = s.chat_id JOIN versions v ON v.id = s.selected_version_id
        WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
        Effect.flatMap(([row]) =>
          row
            ? Effect.succeed({ chatId: row.chat_id, entry: toPathEntry(row) })
            : Effect.fail(new NotFound({ entity: "slot", id: slotId }))
        ),
        query("GetSlot")
      ),

    GetVersion: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<VersionRow>`
          SELECT v.*, ${sql.literal(versionExtras("v"))} FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
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
