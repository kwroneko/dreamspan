// Cards, lorebooks and presets attached to a workshop's composer and not sent yet
// (spec/WORKSHOP-CARDS.md §4.4): `composer_library`, one row per item of a composer draft.
// Sending the message takes the items it carries off the draft in the send's transaction.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { MessageLibrary } from "@dreamspan/shared/chat.ts"
import type { ComposerLibraryHandover, ComposerLibraryItem } from "@dreamspan/shared/composerApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { pinLibrary } from "./libraryAttachments.ts"
import { NotFound, StorageError } from "./ops.ts"
import { recentlySweptWorkshop } from "./pendingChats.ts"

/** As many as a message carries (`MessageLibrary`). */
const MAX_ITEMS = 16

export const composerLibrary = (sql: SqlClient.SqlClient) => {
  /** The user's composer draft of a live chat; `workshop`: one of a workshop's. */
  const owned = (userId: UserId, chatId: string, draftId: string, requireWorkshop: boolean, forkId?: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ status: string }>`SELECT c.status FROM drafts d JOIN chats c ON c.id=d.target_id
      WHERE d.id=${draftId} AND d.user_id=${userId} AND d.target_kind='composer'
        AND c.id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
        ${requireWorkshop ? sql`AND c.kind='workshop'` : sql``}
        ${forkId === undefined ? sql`` : sql`AND d.field = ${forkId}`}`
      if (!row) return yield* new NotFound({ entity: "composer", id: draftId })
      return row
    })
  /** The draft's items still in the library (not binned), in the order attached. */
  const list = (userId: UserId, draftId: string) =>
    sql<ComposerLibraryItem>`SELECT l.kind, l.ref_id AS refId, r.label AS name
      FROM composer_library l JOIN entity_refs r ON r.id = l.ref_id JOIN entities e ON e.id = r.entity_id
      WHERE l.draft_id = ${draftId} AND e.owner_user_id = ${userId} AND e.kind = l.kind
        AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL
      ORDER BY l.position`
  const read = (userId: UserId, chatId: string, draftId: string) =>
    Effect.gen(function* () {
      yield* owned(userId, chatId, draftId, true)
      return yield* list(userId, draftId)
    })
  // One move consumes the swept source's item in the same transaction that attaches it.
  const move = (userId: UserId, source: string, chatId: string, refId: string) =>
    Effect.gen(function* () {
      const [moved] = yield* sql`DELETE FROM swept_composer_library
        WHERE chat_id = ${source} AND user_id = ${userId} AND ref_id = ${refId}
        RETURNING ref_id`
      if (moved === undefined) return false
      yield* sql`UPDATE composer_library_handovers SET chat_id = ${chatId}
        WHERE chat_id = ${source} AND user_id = ${userId} AND ref_id = ${refId}`
      return true
    })

  const applyUrl = (userId: UserId, chatId: string, handover: ComposerLibraryHandover, refId: string) =>
    Effect.gen(function* () {
      const { originChatId, operationId } = handover
      const [applied] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM composer_library_handovers
        WHERE origin_chat_id = ${originChatId} AND user_id = ${userId}
          AND operation_id = ${operationId} AND ref_id = ${refId}`
      if (applied !== undefined) return yield* move(userId, applied.chat_id, chatId, refId)
      if (originChatId !== chatId) {
        const moved = yield* move(userId, originChatId, chatId, refId)
        if (!moved && !(yield* recentlySweptWorkshop(sql, userId, originChatId))) return false
      }
      yield* sql`INSERT INTO composer_library_handovers (origin_chat_id, user_id, operation_id, ref_id, chat_id)
        VALUES (${originChatId}, ${userId}, ${operationId}, ${refId}, ${chatId})`
      return true
    })

  const sweptForReplacement = (userId: UserId, source: string) =>
    sql<{ refId: RefId }>`SELECT s.ref_id AS refId FROM swept_composer_library s
      JOIN entity_refs r ON r.id = s.ref_id JOIN entities e ON e.id = r.entity_id
      WHERE s.chat_id = ${source} AND s.user_id = ${userId}
        AND e.owner_user_id = ${userId} AND e.kind IN ('card', 'lorebook', 'preset')
        AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL
      ORDER BY s.position, s.ref_id LIMIT ${MAX_ITEMS}`.pipe(Effect.map((rows) => rows.map((row) => row.refId)))

  const set = (
    userId: UserId,
    chatId: string,
    draftId: string,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
    carriedFrom?: string,
    handover?: ComposerLibraryHandover
  ) =>
    Effect.gen(function* () {
      const { status } = yield* owned(userId, chatId, draftId, add.length > 0)
      for (const refId of remove) yield* sql`DELETE FROM composer_library WHERE draft_id=${draftId} AND ref_id=${refId}`
      for (const refId of add) {
        if (carriedFrom !== undefined) {
          // A carry needs the swept workshop's item even when a client also supplies a URL.
          if (remove.includes(refId) || !(yield* move(userId, carriedFrom, chatId, refId))) continue
        } else if (handover !== undefined) {
          if (status !== "pending" || remove.includes(refId) || !(yield* applyUrl(userId, chatId, handover, refId)))
            continue
        }
        const [ref] = yield* sql<{
          kind: string
        }>`SELECT e.kind FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          WHERE r.id = ${refId} AND e.owner_user_id = ${userId} AND e.kind IN ('card', 'lorebook', 'preset')
            AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL`
        if (!ref) return yield* new NotFound({ entity: "ref", id: refId })
        // After the last one there: several at once keep the order they were picked in.
        yield* sql`INSERT INTO composer_library (draft_id, ref_id, kind, position)
          VALUES (${draftId}, ${refId}, ${ref.kind},
            (SELECT coalesce(max(position), 0) + 1 FROM composer_library WHERE draft_id = ${draftId}))
          ON CONFLICT DO NOTHING`
      }
      const items = yield* list(userId, draftId)
      if (items.length > MAX_ITEMS)
        return yield* new StorageError({
          reason: "constraint",
          operation: "SetComposerLibrary",
          message: `A message can carry at most ${MAX_ITEMS} cards, lorebooks and presets.`
        })
      return items
    })
  /** Authorize and pin the send's attachments before it can be posted or queued. */
  const takeForSend = (
    userId: UserId,
    chatId: string,
    forkId: string,
    draftId: string | undefined,
    sent: MessageLibrary
  ) =>
    Effect.gen(function* () {
      if (sent.length === 0) return []
      if (draftId === undefined) return yield* new NotFound({ entity: "composer attachment", id: sent[0]!.refId })
      yield* owned(userId, chatId, draftId, true, forkId)
      const rows = yield* sql<MessageLibrary[number]>`SELECT ref_id AS refId, kind FROM composer_library
        WHERE draft_id = ${draftId}`
      const attached = new Map(rows.map((item) => [item.refId, item.kind]))
      for (const { refId, kind } of sent)
        if (attached.get(refId) !== kind) return yield* new NotFound({ entity: "composer attachment", id: refId })
      const pins = yield* pinLibrary(sql, userId, chatId, sent)
      yield* sql`DELETE FROM composer_library WHERE draft_id = ${draftId} AND ref_id IN ${sql.in(sent.map((item) => item.refId))}`
      return pins
    })
  return { read, set, sweptForReplacement, takeForSend }
}
