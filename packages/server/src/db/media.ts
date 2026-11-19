// Media files (DATA-MODEL §11): content-addressed under the data directory, recorded in
// media_assets and reachable by a user only through their media_refs, or a copy they attached
// from Files (`mediaHeldBy`).
import type { SqlClient } from "effect/sql"

/** Where the file with this SHA-256 lives, relative to the data directory. */
export const mediaPath = (sha256: string) => `media/${sha256.slice(0, 2)}/${sha256}`

/** Whether a stored path is one `mediaPath` makes, so it can't name a file anywhere else. */
export const isMediaPath = (path: string) => /^media\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path)

/** Whether a path is a card source's cached image (`sources/cache.ts`), which thumbnails are made from too. */
export const isSourceCachePath = (path: string) => /^cache\/sources\/blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path)

/**
 * Whether `userId` holds the media in `column` (an SQL expression): a reference of theirs
 * (`media_refs`), or a copy they attached from Files (a `file_versions` row of origin
 * `attachment`, which goes when nothing names it, files/routes.ts `attach`).
 */
export const mediaHeldBy = (sql: SqlClient.SqlClient, column: string, userId: string) =>
  sql`(EXISTS (SELECT 1 FROM media_refs r WHERE r.media_id = ${sql.literal(column)} AND r.owner_user_id = ${userId})
    OR EXISTS (SELECT 1 FROM file_versions f WHERE f.media_id = ${sql.literal(column)}
      AND f.owner_user_id = ${userId} AND f.origin = 'attachment'))`

/**
 * Whether `userId` attached the media in `column` from the Files path `path` (an attachment's
 * `path` is the model's pointer to the file, so it must be where the copy came from).
 */
export const attachedFrom = (sql: SqlClient.SqlClient, column: string, userId: string, path: string) =>
  sql`EXISTS (SELECT 1 FROM file_versions f WHERE f.media_id = ${sql.literal(column)}
    AND f.owner_user_id = ${userId} AND f.origin = 'attachment' AND f.path = ${path})`
