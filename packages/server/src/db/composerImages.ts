import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ATTACHMENTS_FOLDER, FILES_TOP, nameOf, parentOf } from "@dreamspan/shared/files.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { MessageImages } from "@dreamspan/shared/chat.ts"
import type { ComposerImage } from "@dreamspan/shared/composerApi.ts"
import { attachedFrom, discardUnheldMedia, mediaHeldBy } from "./media.ts"
import { NotFound, StorageError, type PublishedAttachments } from "./ops.ts"

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
  const owned = (userId: UserId, chatId: string, draftId: string, forkId?: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql`SELECT d.id FROM drafts d JOIN chats c ON c.id=d.target_id
      WHERE d.id=${draftId} AND d.user_id=${userId} AND d.target_kind='composer'
        AND c.id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
        ${forkId === undefined ? sql`` : sql`AND d.field=${forkId}`}`
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
    file: { readonly kind?: "file"; readonly name?: string; readonly path?: string } = {},
    staged = false
  ) =>
    Effect.gen(function* () {
      yield* owned(userId, chatId, draftId)
      const [existing] = yield* sql<{ draft_id: string; staged: number; media_id: string | null }>`
        SELECT draft_id, staged, media_id FROM composer_images WHERE id=${id}`
      if (
        existing &&
        (existing.draft_id !== draftId || (staged && (!existing.staged || existing.media_id !== mediaId)))
      )
        return yield* new NotFound({ entity: "composer image", id })
      if (!existing) {
        const [swept] = yield* sql`SELECT 1 FROM swept_composer_files WHERE id=${id}`
        if (swept) return yield* new NotFound({ entity: "composer image", id })
      }
      if (mediaId !== null && !existing) {
        // A file of any type only where its chat is a workshop (§6.1); a story's are images.
        // Its name and path are what the model is told (§6.1): the path must be where this user
        // attached the copy from, the name that path's own.
        const [media] = staged
          ? yield* sql`SELECT id FROM chats /* chat:includes-pending: a pending workshop can stage files before its first send */
              WHERE id = ${chatId} AND kind = 'workshop'`
          : !attachmentFieldsFit(file)
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
      yield* sql`INSERT INTO composer_images (id,draft_id,media_id,alt_text,status,kind,name,path,staged)
      VALUES (${id},${draftId},${mediaId},${altText},${mediaId === null ? "removed" : "active"},
        ${file.kind ?? "image"},${file.name ?? null},${file.path ?? null},${staged ? 1 : 0}) ON CONFLICT(id) DO NOTHING`
      let discardedHash: string | null = null
      if (mediaId === null) {
        yield* sql`UPDATE composer_images SET status='removed', media_id=CASE WHEN staged=1 THEN NULL ELSE media_id END
          WHERE id=${id} AND status='active'`
        if (existing?.staged && existing.media_id)
          discardedHash = (yield* discardUnheldMedia(sql, existing.media_id))[0]?.sha256 ?? null
      }
      const [row] = yield* sql<Row>`SELECT ${sql.literal(columns)} FROM composer_images WHERE id=${id}`
      return {
        image: toImage(row!),
        discardedHash,
        removedStaged: mediaId === null && !!existing?.staged && existing.media_id !== null
      }
    })
  const consume = (
    userId: UserId,
    chatId: string,
    forkId: string,
    draftId: string | undefined,
    ids: readonly string[],
    images: MessageImages
  ) =>
    Effect.gen(function* () {
      if (!ids.length) return
      if (!draftId || ids.length !== images.length || new Set(ids).size !== ids.length)
        return yield* new NotFound({ entity: "composer images", id: draftId ?? "" })
      yield* owned(userId, chatId, draftId, forkId)
      for (const [index, id] of ids.entries()) {
        const [row] =
          yield* sql`SELECT id FROM composer_images WHERE id=${id} AND draft_id=${draftId} AND status='active' AND staged=0 AND media_id=${images[index]!.mediaId}`
        if (!row) return yield* new NotFound({ entity: "composer image", id })
        yield* sql`UPDATE composer_images SET status='sent' WHERE id=${id}`
      }
    })
  const stagedFiles = (userId: UserId, chatId: string, draftId: string, ids: readonly string[], forkId?: string) =>
    Effect.gen(function* () {
      yield* owned(userId, chatId, draftId, forkId)
      return yield* sql<{ id: string; mediaId: string; name: string; sha256: string; byteSize: number }>`
        SELECT i.id, m.id AS mediaId, i.name, m.sha256, m.byte_size AS byteSize
        FROM composer_images i JOIN media_assets m ON m.id = i.media_id
        WHERE i.draft_id = ${draftId} AND i.staged = 1 AND i.status = 'active' AND i.id IN ${sql.in(ids)}`
    })

  /** Records the prepared paths and their publication intents in the send transaction. */
  const publish = (
    userId: UserId,
    chatId: string,
    forkId: string,
    draftId: string | undefined,
    ids: readonly string[],
    images: MessageImages,
    files: PublishedAttachments
  ) =>
    Effect.gen(function* () {
      if (!files.length) return
      const rows = yield* stagedFiles(userId, chatId, draftId ?? "", ids, forkId)
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const { id, path, inode, token, device } of files) {
        const row = byId.get(id)
        const image = images[ids.indexOf(id)]
        if (
          !row ||
          image?.mediaId !== row.mediaId ||
          image.path !== path ||
          parentOf(path) !== `${FILES_TOP}/${ATTACHMENTS_FOLDER}` ||
          image.name !== nameOf(path)
        )
          return yield* new NotFound({ entity: "composer image", id })
        const time = Date.now()
        yield* sql`INSERT INTO file_versions (id, owner_user_id, path, inode, media_id, byte_size, origin,
          actor_user_id, rollout_id, tool_call_id, created_at)
          SELECT ${uuidv7()}, ${userId}, ${path}, ${inode}, ${row.mediaId}, ${row.byteSize}, 'attachment',
            ${userId}, NULL, NULL, ${time}
          WHERE NOT EXISTS (SELECT 1 FROM file_versions
            WHERE owner_user_id=${userId} AND path=${path} AND media_id=${row.mediaId} AND origin='attachment')`
        yield* sql`INSERT INTO attachment_publications (token, user_id, path, device, inode)
          VALUES (${token}, ${userId}, ${path}, ${device}, ${inode})`
        yield* sql`UPDATE composer_images SET staged=0, name=${image.name}, path=${path} WHERE id=${id}`
        byId.delete(id)
      }
    })
  return { read, set, consume, stagedFiles, publish }
}
