// Media files (DATA-MODEL §11): content-addressed under the data directory, recorded in
// media_assets and reachable by a user only through their media_refs, or a copy they attached
// from Files (`mediaHeldBy`).
import { Effect } from "effect"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { backgroundHeldBy } from "./backgroundMedia.ts"
import type { SqlClient } from "effect/sql"

/** Where the file with this SHA-256 lives, relative to the data directory. */
export const mediaPath = (sha256: string) => `media/${sha256.slice(0, 2)}/${sha256}`

/** Whether a stored path is one `mediaPath` makes, so it can't name a file anywhere else. */
export const isMediaPath = (path: string) => /^media\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path)

/** Whether a path is a card source's cached image (`sources/cache.ts`), which thumbnails are made from too. */
export const isSourceCachePath = (path: string) => /^cache\/sources\/blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path)

/** Whether the account holds these bytes through a copy attached from Files. */
export const attachmentHeldBy = (sql: SqlClient.SqlClient, column: string, userId: string) =>
  sql`EXISTS (SELECT 1 FROM file_versions f WHERE f.media_id = ${sql.literal(column)}
    AND f.owner_user_id = ${userId} AND f.origin = 'attachment')`

/** A durable account reference for media outside the gallery. */
export const mediaReferenceHeldBy = (sql: SqlClient.SqlClient, column: string, userId: string) =>
  sql`(EXISTS (SELECT 1 FROM media_refs r WHERE r.media_id = ${sql.literal(column)} AND r.owner_user_id = ${userId})
    AND NOT ${backgroundHeldBy(sql, column, userId, true)})`

/**
 * Whether `userId` holds the media in `column` (an SQL expression): a reference of theirs
 * (`media_refs`), or a copy they attached from Files (a `file_versions` row of origin
 * `attachment`, which goes when nothing names it, files/routes.ts `attach`).
 */
export const mediaHeldBy = (sql: SqlClient.SqlClient, column: string, userId: string) =>
  sql`(${mediaReferenceHeldBy(sql, column, userId)}
    OR ${attachmentHeldBy(sql, column, userId)})`

/**
 * Whether `userId` attached the media in `column` from the Files path `path` (an attachment's
 * `path` points to the original in Files, so it must be where the copy came from).
 */
export const attachedFrom = (sql: SqlClient.SqlClient, column: string, userId: string, path: string) =>
  sql`EXISTS (SELECT 1 FROM file_versions f WHERE f.media_id = ${sql.literal(column)}
    AND f.owner_user_id = ${userId} AND f.origin = 'attachment' AND f.path = ${path})`

/** An upload the account can preview in its composer until it sends or removes it. */
export const stagedAttachmentHeldBy = (sql: SqlClient.SqlClient, column: string, userId: string) =>
  sql`EXISTS (
    SELECT 1 FROM composer_images i JOIN drafts d ON d.id = i.draft_id
    JOIN chats c ON c.id = d.target_id /* chat:includes-pending: the user previews a pending workshop's files too */
    WHERE i.media_id = ${sql.literal(column)} AND i.staged = 1 AND i.status = 'active'
      AND d.user_id = ${userId} AND c.deleted_at IS NULL)`

/** Drops the row only when the bytes have no other holder, returning the hash for disk cleanup. */
export const discardUnheldMedia = (sql: SqlClient.SqlClient, mediaId: string) =>
  sql<{ sha256: string }>`DELETE FROM media_assets WHERE id = ${mediaId}
    AND NOT EXISTS (SELECT 1 FROM media_refs WHERE media_id = media_assets.id)
    AND NOT EXISTS (SELECT 1 FROM file_versions WHERE media_id = media_assets.id)
    AND NOT EXISTS (SELECT 1 FROM saved_media WHERE media_id = media_assets.id)
    AND NOT EXISTS (SELECT 1 FROM chats WHERE cover_media_id = media_assets.id) /* chat:includes-pending: covers are kept until swept */
    AND NOT EXISTS (SELECT 1 FROM forks WHERE cover_media_id = media_assets.id)
    AND NOT EXISTS (SELECT 1 FROM version_attachments WHERE media_id = media_assets.id)
    AND NOT EXISTS (SELECT 1 FROM composer_images WHERE media_id = media_assets.id)
    AND NOT EXISTS (SELECT 1 FROM swept_composer_files WHERE media_id = media_assets.id)
    RETURNING sha256`

export interface MediaUpload {
  readonly sha256: string
  readonly mime: string
  readonly byteSize: number
  readonly width: number | null
  readonly height: number | null
}

/** Records the shared bytes and reports whether this operation created the account's hold. */
export const recordMediaReference = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  file: MediaUpload,
  verifiedImage?: true
) {
  yield* sql`INSERT INTO media_assets ${sql.insert({
    id: uuidv7(),
    sha256: file.sha256,
    mime: file.mime,
    width: file.width,
    height: file.height,
    byte_size: file.byteSize,
    path: mediaPath(file.sha256),
    created_at: Date.now()
  })} ON CONFLICT (sha256) DO NOTHING`
  if (verifiedImage)
    yield* sql`UPDATE media_assets SET mime = ${file.mime}, width = ${file.width}, height = ${file.height}
      WHERE sha256 = ${file.sha256} AND mime = 'application/octet-stream'`
  const [row] = yield* sql<{ id: string }>`SELECT id FROM media_assets WHERE sha256 = ${file.sha256}`
  const mediaId = row!.id
  const created = yield* sql`INSERT INTO media_refs ${sql.insert({ media_id: mediaId, owner_user_id: userId })}
    ON CONFLICT DO NOTHING RETURNING media_id`
  return { mediaId, created: created.length !== 0 }
})
