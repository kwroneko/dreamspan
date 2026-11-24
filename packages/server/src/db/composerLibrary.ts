// Cards, lorebooks and presets attached to a workshop's composer and not sent yet
// (spec/WORKSHOP-CARDS.md §4.4): `composer_library`, one row per item of a composer draft.
// Sending the message takes the items it carries off the draft in the send's transaction.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { MessageLibrary } from "@dreamspan/shared/chat.ts"
import type { ComposerLibraryItem } from "@dreamspan/shared/composerApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound, StorageError } from "./ops.ts"
import { sweptComposerLibrary } from "./pendingChats.ts"

/** As many as a message carries (`MessageLibrary`). */
const MAX_ITEMS = 16

export const composerLibrary = (sql: SqlClient.SqlClient) => {
  /** The user's composer draft of a live chat; `workshop`: one of a workshop's. */
  const owned = (userId: UserId, chatId: string, draftId: string, workshop: boolean, forkId?: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql`SELECT d.id FROM drafts d JOIN chats c ON c.id=d.target_id
      WHERE d.id=${draftId} AND d.user_id=${userId} AND d.target_kind='composer'
        AND c.id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
        AND (${workshop ? 0 : 1} OR c.kind='workshop')
        ${forkId === undefined ? sql`` : sql`AND d.field = ${forkId}`}`
      if (!row) return yield* new NotFound({ entity: "composer", id: draftId })
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
      yield* owned(userId, chatId, draftId, false)
      return yield* list(userId, draftId)
    })
  const set = (
    userId: UserId,
    chatId: string,
    draftId: string,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
    carriedFrom?: string
  ) =>
    Effect.gen(function* () {
      yield* owned(userId, chatId, draftId, add.length > 0)
      for (const refId of remove) yield* sql`DELETE FROM composer_library WHERE draft_id=${draftId} AND ref_id=${refId}`
      const held = carriedFrom === undefined ? null : yield* sweptComposerLibrary(sql, userId, carriedFrom)
      for (const refId of add) {
        if (carriedFrom !== undefined) {
          if (!held?.includes(refId) || remove.includes(refId)) continue
          // The receipt survives removal or send. A retry reads the draft as it is now.
          const [applied] = yield* sql`INSERT INTO composer_library_carries (draft_id, source_chat_id, ref_id)
            VALUES (${draftId}, ${carriedFrom}, ${refId}) ON CONFLICT DO NOTHING RETURNING ref_id`
          if (!applied) continue
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
  /** A send takes only the items still attached to its draft. */
  const consume = (userId: UserId, chatId: string, forkId: string, draftId: string | undefined, sent: MessageLibrary) =>
    Effect.gen(function* () {
      if (draftId === undefined || sent.length === 0) return
      yield* owned(userId, chatId, draftId, true, forkId)
      const rows = yield* sql<MessageLibrary[number]>`SELECT ref_id AS refId, kind FROM composer_library
        WHERE draft_id = ${draftId}`
      const attached = new Map(rows.map((item) => [item.refId, item.kind]))
      for (const { refId, kind } of sent)
        if (attached.get(refId) !== kind) return yield* new NotFound({ entity: "composer attachment", id: refId })
      yield* sql`DELETE FROM composer_library WHERE draft_id = ${draftId} AND ref_id IN ${sql.in(sent.map((item) => item.refId))}`
    })
  return { read, set, consume }
}
