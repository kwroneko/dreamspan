import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { MessageImages } from "@dreamspan/shared/chat.ts"
import type { ComposerImage } from "@dreamspan/shared/composerApi.ts"
import { attachedFrom, mediaHeldBy } from "./media.ts"
import { NotFound, StorageError } from "./ops.ts"

/** The row as the API gives it: a workshop's attachment adds its kind, name and path (§6.1). */
interface Row {
  readonly position: number
  readonly id: string
  readonly mediaId: string | null
  readonly altText: string
  readonly status: ComposerImage["status"]
  readonly kind: string
  readonly name: string | null
  readonly path: string | null
  readonly card_json: string | null
}
const columns = `rowid AS position, id, media_id AS mediaId, alt_text AS altText, status, kind, name, path,
  (SELECT json_object('name', c.name, 'format', c.format) FROM media_card_files c
    WHERE c.media_id = composer_images.media_id) AS card_json`
const toImage = ({ kind, name, path, card_json, ...row }: Row): ComposerImage => ({
  ...row,
  ...(kind === "file" ? { kind: "file" as const } : {}),
  ...(name !== null ? { name } : {}),
  ...(path !== null ? { path } : {}),
  ...(card_json !== null ? { card: JSON.parse(card_json) as NonNullable<ComposerImage["card"]> } : {})
})

/** What an attachment's file may be: any type for a file, else a PNG, JPEG, GIF or WebP image. */
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

/**
 * An attachment's own fields as the client gave them (§6.1): a file always has its path in
 * Files; a name is a plain name, and with a path it's that path's last part.
 */
export const attachmentFieldsFit = (file: {
  readonly kind?: "file"
  readonly name?: string
  readonly path?: string
}) => {
  if (file.kind === "file" && file.path === undefined) return false
  if (file.name !== undefined && (file.name === "" || /[/\u0000-\u001f\u007f]/.test(file.name))) return false
  if (
    file.path !== undefined &&
    file.name !== undefined &&
    file.path.slice(file.path.lastIndexOf("/") + 1) !== file.name
  )
    return false
  return true
}

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
      const rows = yield* sql<Row>`SELECT ${sql.literal(columns)}
      FROM composer_images WHERE draft_id=${draftId} AND (status='active' OR id IN ${sql.in(ids)}) ORDER BY rowid`
      return rows.map(toImage)
    })
  const set = (
    userId: UserId,
    chatId: string,
    draftId: string,
    id: string,
    mediaId: string | null,
    altText: string,
    file: { readonly kind?: "file"; readonly name?: string; readonly path?: string } = {}
  ) =>
    Effect.gen(function* () {
      yield* owned(userId, chatId, draftId)
      const [existing] = yield* sql<{ draft_id: string }>`SELECT draft_id FROM composer_images WHERE id=${id}`
      if (existing && existing.draft_id !== draftId) return yield* new NotFound({ entity: "composer image", id })
      if (mediaId !== null && !existing) {
        // A file of any type only where its chat is a workshop (§6.1); a story's are images.
        // Its name and path are what the model is told (§6.1): the path must be where this user
        // attached the copy from, the name that path's own.
        const [media] = !attachmentFieldsFit(file)
          ? []
          : file.kind === "file"
            ? yield* sql`SELECT m.id FROM media_assets m JOIN chats c ON c.id=${chatId} AND c.kind='workshop'
            WHERE m.id=${mediaId} AND ${mediaHeldBy(sql, "m.id", userId)}
              AND ${attachedFrom(sql, "m.id", userId, file.path!)}`
            : file.path !== undefined
              ? yield* sql`SELECT m.id FROM media_assets m
            WHERE m.id=${mediaId} AND ${mediaHeldBy(sql, "m.id", userId)} AND m.mime IN ${sql.in(IMAGE_MIMES)}
              AND ${attachedFrom(sql, "m.id", userId, file.path)}`
              : yield* sql`SELECT m.id FROM media_assets m
            WHERE m.id=${mediaId} AND ${mediaHeldBy(sql, "m.id", userId)} AND m.mime IN ${sql.in(IMAGE_MIMES)}`
        if (!media) return yield* new NotFound({ entity: file.kind === "file" ? "file" : "image", id: mediaId })
        const [count] = yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM composer_images WHERE draft_id=${draftId} AND status='active'`
        if (count!.n >= 32)
          return yield* new StorageError({
            reason: "constraint",
            operation: "SetComposerImage",
            message: "A message can hold at most 32 attachments."
          })
      }
      yield* sql`INSERT INTO composer_images (id,draft_id,media_id,alt_text,status,kind,name,path)
      VALUES (${id},${draftId},${mediaId},${altText},${mediaId === null ? "removed" : "active"},
        ${file.kind ?? "image"},${file.name ?? null},${file.path ?? null}) ON CONFLICT(id) DO NOTHING`
      if (mediaId === null) yield* sql`UPDATE composer_images SET status='removed' WHERE id=${id} AND status='active'`
      const [row] = yield* sql<Row>`SELECT ${sql.literal(columns)} FROM composer_images WHERE id=${id}`
      return toImage(row!)
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
