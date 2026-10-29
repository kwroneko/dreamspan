import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import type { MessageImages } from "@rp/shared/chat.ts"
import type { ComposerImage } from "@rp/shared/composerApi.ts"
import { NotFound, StorageError } from "./ops.ts"

export const composerImages = (sql: SqlClient.SqlClient) => {
  const owned = (userId: UserId, chatId: string, draftId: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql`SELECT d.id FROM drafts d JOIN chats c ON c.id=d.target_id
      WHERE d.id=${draftId} AND d.user_id=${userId} AND d.target_kind='composer'
        AND c.id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL`
      if (!row) return yield* new NotFound({ entity: "composer", id: draftId })
    })
  const read = (userId: UserId, chatId: string, draftId: string, ids: readonly string[]) =>
    Effect.gen(function* () {
      yield* owned(userId, chatId, draftId)
      return yield* sql<ComposerImage>`SELECT rowid AS position, id, media_id AS mediaId, alt_text AS altText, status
      FROM composer_images WHERE draft_id=${draftId} AND (status='active' OR id IN ${sql.in(ids)}) ORDER BY rowid`
    })
  const set = (userId: UserId, chatId: string, draftId: string, id: string, mediaId: string | null, altText: string) =>
    Effect.gen(function* () {
      yield* owned(userId, chatId, draftId)
      const [existing] = yield* sql<{ draft_id: string }>`SELECT draft_id FROM composer_images WHERE id=${id}`
      if (existing && existing.draft_id !== draftId) return yield* new NotFound({ entity: "composer image", id })
      if (mediaId !== null && !existing) {
        const [media] = yield* sql`SELECT m.id FROM media_assets m JOIN media_refs r ON r.media_id=m.id
        WHERE m.id=${mediaId} AND r.owner_user_id=${userId} AND m.mime IN ('image/png','image/jpeg','image/gif','image/webp')`
        if (!media) return yield* new NotFound({ entity: "image", id: mediaId })
        const [count] = yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM composer_images WHERE draft_id=${draftId} AND status='active'`
        if (count!.n >= 32)
          return yield* new StorageError({
            reason: "constraint",
            operation: "SetComposerImage",
            message: "A message can hold at most 32 images."
          })
      }
      yield* sql`INSERT INTO composer_images (id,draft_id,media_id,alt_text,status)
      VALUES (${id},${draftId},${mediaId},${altText},${mediaId === null ? "removed" : "active"}) ON CONFLICT(id) DO NOTHING`
      if (mediaId === null) yield* sql`UPDATE composer_images SET status='removed' WHERE id=${id} AND status='active'`
      const [row] =
        yield* sql<ComposerImage>`SELECT rowid AS position, id, media_id AS mediaId, alt_text AS altText, status FROM composer_images WHERE id=${id}`
      return row!
    })
  const consume = (
    userId: UserId,
    chatId: string,
    draftId: string | undefined,
    ids: readonly string[],
    images: MessageImages
  ) =>
    Effect.gen(function* () {
      if (!ids.length) return
      if (!draftId || ids.length !== images.length || new Set(ids).size !== ids.length)
        return yield* new NotFound({ entity: "composer images", id: draftId ?? "" })
      yield* owned(userId, chatId, draftId)
      for (const [index, id] of ids.entries()) {
        const [row] =
          yield* sql`SELECT id FROM composer_images WHERE id=${id} AND draft_id=${draftId} AND status='active' AND media_id=${images[index]!.mediaId}`
        if (!row) return yield* new NotFound({ entity: "composer image", id })
        yield* sql`UPDATE composer_images SET status='sent' WHERE id=${id}`
      }
    })
  return { read, set, consume }
}
