// Read operation handlers. They run inside the reader workers on read-only connections.
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { MergePreview, Revision, type RevisionId } from "@rp/shared/library.ts"
import { StateEventData } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { toStorageError } from "./connection.ts"
import { toBinItem, toRecoveredText } from "./bin.ts"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef } from "./library.ts"
import { FoldableStateEvent, NotFound, ReadOps, RefOperationRefused, StorageError } from "./ops.ts"
import {
  type ChatRow,
  type PathRow,
  toChat,
  toPathEntry,
  toUser,
  toVersion,
  type UserRow,
  versionColumns,
  type VersionRow
} from "./rows.ts"
import { query } from "./tx.ts"

const decodeStateEvent = Schema.decodeUnknownEffect(StateEventData)

export const makeReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)
  const drafts = makeDraftStore(sql)

  const ownedChat = (userId: UserId, chatId: ChatId) =>
    sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))))
    )

  /** The slots from the root to `leaf`, walking parent links (DATA-MODEL §4.4). */
  const pathCte = (chatId: ChatId, leaf: SlotId) => sql`
    WITH RECURSIVE path(id, parent_slot_id) AS (
      SELECT id, parent_slot_id FROM slots WHERE id = ${leaf} AND chat_id = ${chatId}
      UNION ALL
      SELECT s.id, s.parent_slot_id FROM slots s JOIN path p ON s.id = p.parent_slot_id
    )`

  return ReadOps.of({
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
        if (leaf === null) return { entries: [], hasMore: false }
        // Walks up from the leaf and stops after `limit` slots.
        const rows = yield* sql<PathRow & Record<string, unknown>>`
          WITH RECURSIVE path(id, parent_slot_id, n) AS (
            SELECT id, parent_slot_id, 1 FROM slots WHERE id = ${leaf} AND chat_id = ${chatId}
            UNION ALL
            SELECT s.id, s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON s.id = p.parent_slot_id
            WHERE p.n < ${limit}
          )
          SELECT s.id AS slot_id, s.lane_id, s.parent_slot_id, s.depth, s.row_version, s.context_excluded,
            s.deleted_at IS NOT NULL AS slot_deleted,
            (SELECT count(*) FROM versions c WHERE c.slot_id = s.id AND c.deleted_at IS NULL) AS version_count,
            ${sql.literal(versionColumns("v"))}
          FROM path JOIN slots s ON s.id = path.id JOIN versions v ON v.id = s.selected_version_id
          ORDER BY s.depth`
        if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: leaf })
        // Deleted messages are walked through but not shown; their replies stay in place.
        return {
          entries: rows.filter((row) => row.slot_deleted === 0).map(toPathEntry),
          hasMore: rows[0]!.parent_slot_id !== null
        }
      }).pipe(query("GetPath")),

    ListVersions: ({ userId, slotId }) =>
      Effect.gen(function* () {
        const rows = yield* sql<VersionRow>`
          SELECT v.* FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          WHERE v.slot_id = ${slotId} AND c.owner_user_id = ${userId}
            AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL
          ORDER BY v.ordinal`
        if (rows.length === 0) return yield* new NotFound({ entity: "slot", id: slotId })
        return rows.map(toVersion)
      }).pipe(query("ListVersions")),

    StateEventsAt: ({ userId, chatId, slotId }) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        const rows =
          slotId === null
            ? yield* sql<{ key: string; scope: string | null; value_json: string }>`
                SELECT key, scope, value_json FROM state_events
                WHERE chat_id = ${chatId} AND slot_id IS NULL AND superseded_by_changeset IS NULL
                ORDER BY seq`
            : yield* sql<{ key: string; scope: string | null; value_json: string }>`
                ${pathCte(chatId, slotId)}
                SELECT e.key, e.scope, e.value_json
                FROM state_events e
                LEFT JOIN path p ON p.id = e.slot_id
                LEFT JOIN slots s ON s.id = p.id
                WHERE e.chat_id = ${chatId} AND e.superseded_by_changeset IS NULL
                  AND (e.slot_id IS NULL OR p.id IS NOT NULL)
                  AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
                ORDER BY coalesce(s.depth, -1), e.seq`
        return yield* Effect.forEach(rows, (row) =>
          decodeStateEvent({ key: row.key, value: JSON.parse(row.value_json) }).pipe(
            Effect.map((data) => new FoldableStateEvent({ scope: row.scope, data })),
            Effect.mapError(
              (error) => new StorageError({ reason: "corrupt", operation: "StateEventsAt", message: error.message })
            )
          )
        )
      }).pipe(query("StateEventsAt")),

    ListBin: ({ userId, limit, before }) =>
      sql<Parameters<typeof toBinItem>[0]>`
        SELECT * FROM bin_items WHERE user_id = ${userId} AND (${before} IS NULL OR deleted_at < ${before})
        ORDER BY deleted_at DESC, id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) => rows.map(toBinItem)),
        query("ListBin")
      ),

    ListRecoveredTexts: ({ userId, source, limit }) =>
      sql<Parameters<typeof toRecoveredText>[0]>`
        SELECT * FROM recovered_texts WHERE user_id = ${userId}
          AND (${source?.targetKind ?? null} IS NULL OR (source_kind = ${source?.targetKind ?? null}
            AND source_id = ${source?.targetId ?? null} AND source_field = ${source?.field ?? null}))
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
        if (ref.follows_ref_id === null) {
          return yield* new RefOperationRefused({
            refId,
            reason: "This ref doesn't follow another, so there's nothing to merge."
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

    CountTo: ({ n }) =>
      sql<{ n: number }>`
        WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n})
        SELECT count(*) AS n FROM c`.pipe(
        Effect.map(([row]) => row?.n ?? 0),
        Effect.catchTag("SqlError", (error) => Effect.fail(toStorageError("CountTo")(error)))
      )
  })
})
