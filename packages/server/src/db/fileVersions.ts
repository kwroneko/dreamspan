// File versions (spec/FILES-AND-ENVIRONMENT.md §1.3, §10): an account's earlier file contents,
// in the content-addressed media store. The bytes are written first, on the main thread
// (importer/mediaFiles.ts, held from the sweep), then recorded here in one transaction.
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { mediaPath } from "./media.ts"
import { composerImages } from "./composerImages.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"
import { toRolloutEffect } from "./workshopEffects.ts"
import { EffectUndoRefused } from "@dreamspan/shared/workshopApi.ts"

/** The Files quota counts each media row once, including when several paths hold it. */
const versionBytes = (sql: SqlClient.SqlClient, userId: string, sha256?: string) =>
  sql<{ bytes: number | null }>`SELECT sum(m.byte_size) AS bytes FROM media_assets m
    WHERE m.id IN (SELECT media_id FROM file_versions WHERE owner_user_id = ${userId} AND media_id IS NOT NULL)
    ${sha256 === undefined ? sql`` : sql`AND m.sha256 = ${sha256}`}`.pipe(Effect.map(([row]) => row?.bytes ?? 0))

export const makeFileVersionWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RecordFileVersions: ({ userId, versions, actorUserId }) =>
      Effect.gen(function* () {
        const ids: Array<string> = []
        const now = Date.now()
        for (const version of versions) {
          let mediaId: string | null = null
          if (version.sha256 !== null) {
            yield* sql`INSERT INTO media_assets ${sql.insert({
              id: uuidv7(),
              sha256: version.sha256,
              mime: version.mime,
              width: null,
              height: null,
              byte_size: version.byteSize,
              path: mediaPath(version.sha256),
              created_at: now
            })} ON CONFLICT (sha256) DO NOTHING`
            const [row] = yield* sql<{ id: string }>`SELECT id FROM media_assets WHERE sha256 = ${version.sha256}`
            // No media_refs row: a version is reached through its own row, and a reference
            // would keep the bytes after retention removed the version.
            mediaId = row!.id
          }
          const id = uuidv7()
          yield* sql`INSERT INTO file_versions ${sql.insert({
            id,
            owner_user_id: userId,
            path: version.path,
            inode: version.inode,
            media_id: mediaId,
            byte_size: version.byteSize,
            origin: version.origin,
            actor_user_id: actorUserId ?? userId,
            rollout_id: version.rolloutId ?? null,
            tool_call_id: version.rolloutId ? (version.toolCallId ?? null) : null,
            created_at: now
          })}`
          ids.push(id)
        }
        return ids
      }).pipe(transaction(sql, "RecordFileVersions")),
    RecordAttachmentCopy: ({ userId, path, inode, media, composer, maxAddedBytes }) =>
      Effect.gen(function* () {
        const addedBytes = (yield* versionBytes(sql, userId, media.sha256)) > 0 ? 0 : media.byteSize
        // A prune can drop a duplicate after the route checked it. Ask for a reservation
        // for the full copy before recording it in that case.
        if (addedBytes > maxAddedBytes) return null
        yield* sql`INSERT INTO media_assets ${sql.insert({
          id: uuidv7(),
          sha256: media.sha256,
          mime: media.mime,
          width: media.width,
          height: media.height,
          byte_size: media.byteSize,
          path: mediaPath(media.sha256),
          created_at: Date.now()
        })} ON CONFLICT (sha256) DO NOTHING`
        const [row] = yield* sql<{ id: string; mime: string }>`
          SELECT id, mime FROM media_assets WHERE sha256 = ${media.sha256}`
        // One copy per path and content: attaching it again names the same one.
        const [held] = yield* sql`SELECT 1 FROM file_versions
          WHERE owner_user_id = ${userId} AND media_id = ${row!.id} AND origin = 'attachment' AND path = ${path}`
        if (!held)
          yield* sql`INSERT INTO file_versions ${sql.insert({
            id: uuidv7(),
            owner_user_id: userId,
            path,
            inode,
            media_id: row!.id,
            byte_size: media.byteSize,
            origin: "attachment",
            actor_user_id: userId,
            rollout_id: null,
            tool_call_id: null,
            created_at: Date.now()
          })}`
        if (composer) {
          const name = path.slice(path.lastIndexOf("/") + 1)
          const image = media.mime.startsWith("image/") && row!.mime === media.mime
          yield* composerImages(sql).set(userId, composer.chatId, composer.draftId, composer.id, row!.id, name, {
            name,
            path,
            ...(image ? {} : { kind: "file" as const })
          })
        }
        return { mediaId: row!.id, mime: row!.mime, addedBytes }
      }).pipe(transaction(sql, "RecordAttachmentCopy")),
    MoveFileReferences: ({ userId, from, to }) =>
      Effect.gen(function* () {
        // `from` itself, and every path below it: the prefix swapped for `to`.
        const below = `${from}/`
        const toBelow = `${to}/`
        // The move never replaces (renameNoReplace), so nothing of the owner's was at `to`: shares
        // and invitations still recorded there were stale, and go rather than block these.
        for (const table of ["file_shares", "file_share_invitations"] as const) {
          yield* sql`DELETE FROM ${sql(table)} WHERE owner_user_id = ${userId}
            AND (path = ${to} OR substr(path, 1, ${toBelow.length}) = ${toBelow})
            AND NOT (path = ${from} OR substr(path, 1, ${below.length}) = ${below})`
          yield* sql`UPDATE OR IGNORE ${sql(table)} SET path = ${to} || substr(path, ${from.length + 1})
            WHERE owner_user_id = ${userId} AND (path = ${from} OR substr(path, 1, ${below.length}) = ${below})`
        }
        yield* sql`UPDATE OR IGNORE drafts SET target_id = ${to} || substr(target_id, ${from.length + 1})
          WHERE user_id = ${userId} AND target_kind = 'file'
            AND (target_id = ${from} OR substr(target_id, 1, ${below.length}) = ${below})`
      }).pipe(transaction(sql, "MoveFileReferences")),
    PruneFileVersions: ({ userId, before, limit }) =>
      Effect.gen(function* () {
        const gone = yield* sql<{ media_id: string | null }>`DELETE FROM file_versions WHERE id IN (
            SELECT id FROM file_versions WHERE created_at < ${before} AND origin <> 'attachment'
              ${userId === undefined ? sql`` : sql`AND owner_user_id = ${userId}`}
            LIMIT ${limit})
          RETURNING media_id`
        // An attachment copy stays while its owner's messages (live or in the bin), their
        // amendment history or an active composer attachment name it.
        const dropped = yield* sql<{ media_id: string | null }>`DELETE FROM file_versions
          WHERE origin = 'attachment' ${userId === undefined ? sql`` : sql`AND owner_user_id = ${userId}`}
            AND NOT EXISTS (SELECT 1 FROM version_attachments a
              JOIN versions v ON v.id = a.version_id JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
              WHERE a.media_id = file_versions.media_id AND c.owner_user_id = file_versions.owner_user_id)
            AND NOT EXISTS (SELECT 1 FROM composer_images i JOIN drafts d ON d.id = i.draft_id
              WHERE i.media_id = file_versions.media_id AND i.status = 'active'
                AND d.user_id = file_versions.owner_user_id)
            AND NOT EXISTS (SELECT 1 FROM version_history h
              JOIN versions v ON v.id = h.version_id JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
              WHERE c.owner_user_id = file_versions.owner_user_id AND h.images_json IS NOT NULL
                AND instr(h.images_json, file_versions.media_id) > 0)
          RETURNING media_id`
        const media = [
          ...new Set([...gone, ...dropped].flatMap((row) => (row.media_id === null ? [] : [row.media_id])))
        ]
        // A content goes only when nothing names it: no other version, no account's reference,
        // saved address, cover, attachment or composer image.
        const removed = media.length
          ? yield* sql<{ id: string }>`DELETE FROM media_assets
              WHERE id IN (SELECT value FROM json_each(${JSON.stringify(media)}))
                AND NOT EXISTS (SELECT 1 FROM file_versions WHERE media_id = media_assets.id)
                AND NOT EXISTS (SELECT 1 FROM media_refs WHERE media_id = media_assets.id)
                AND NOT EXISTS (SELECT 1 FROM saved_media WHERE media_id = media_assets.id)
                AND NOT EXISTS (SELECT 1 FROM chats WHERE cover_media_id = media_assets.id)
                AND NOT EXISTS (SELECT 1 FROM forks WHERE cover_media_id = media_assets.id)
                AND NOT EXISTS (SELECT 1 FROM version_attachments WHERE media_id = media_assets.id)
                AND NOT EXISTS (SELECT 1 FROM composer_images WHERE media_id = media_assets.id)
              RETURNING id`
          : []
        return { versions: gone.length, attachments: dropped.length, media: removed.length }
      }).pipe(transaction(sql, "PruneFileVersions")),
    /** The file was put back on disk by the host; this marks the agent's change undone. */
    CompleteFileUndo: (input) =>
      Effect.gen(function* () {
        const [owned] = yield* sql`SELECT 1 FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${input.rolloutId} AND c.owner_user_id = ${input.userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "workshop rollout", id: input.rolloutId })
        const select = () => sql<Parameters<typeof toRolloutEffect>[0]>`SELECT * FROM rollout_effects
          WHERE rollout_id = ${input.rolloutId} AND tool_call_id = ${input.toolCallId} AND seq = ${input.seq}`
        const [row] = yield* select()
        if (!row || !row.kind.startsWith("file."))
          return yield* new EffectUndoRefused({ message: "That file change is unavailable." })
        if (row.undone_at === null)
          yield* sql`UPDATE rollout_effects SET undone_at = ${Math.max(Date.now(), row.created_at)},
            undo_result_json = ${JSON.stringify(input.result)}
            WHERE rollout_id = ${input.rolloutId} AND tool_call_id = ${input.toolCallId} AND seq = ${input.seq}`
        const [done] = yield* select()
        return toRolloutEffect(done!)
      }).pipe(transaction(sql, "CompleteFileUndo"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})

export const makeFileVersionReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    FileVersion: ({ userId, id }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          id: string
          path: string
          inode: number | null
          byte_size: number
          origin: string
          sha256: string | null
          media_path: string | null
          created_at: number
        }>`SELECT v.id, v.path, v.inode, v.byte_size, v.origin, m.sha256, m.path AS media_path, v.created_at
          FROM file_versions v LEFT JOIN media_assets m ON m.id = v.media_id
          WHERE v.id = ${id} AND v.owner_user_id = ${userId}`
        if (!row) return yield* new NotFound({ entity: "file version", id })
        return {
          id: row.id,
          path: row.path,
          inode: row.inode,
          byteSize: row.byte_size,
          origin: row.origin,
          sha256: row.sha256,
          mediaPath: row.media_path,
          createdAt: row.created_at
        }
      }).pipe(query("FileVersion")),
    FileBinItem: ({ userId, itemId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ id: string; title: string; origin_json: string }>`
          SELECT id, title, origin_json FROM bin_items WHERE id = ${itemId} AND user_id = ${userId} AND kind = 'file'`
        if (!row) return yield* new NotFound({ entity: "file in the bin", id: itemId })
        const origin = JSON.parse(row.origin_json) as { path?: unknown; entryKind?: unknown }
        return {
          id: row.id,
          path: String(origin.path ?? ""),
          name: row.title,
          entryKind: String(origin.entryKind ?? "file")
        }
      }).pipe(query("FileBinItem")),
    FileBinItemIds: ({ userId }) =>
      sql<{ id: string }>`SELECT id FROM bin_items WHERE user_id = ${userId} AND kind = 'file'`.pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        query("FileBinItemIds")
      ),
    // Folders other accounts shared with this one (§1.4), for its commands' binds (A5). Shares
    // from a disabled account don't count.
    FileSharesGrantedTo: ({ userId }) =>
      sql<{
        id: string
        owner_user_id: string
        handle: string
        path: string
        inode: number | null
        device: number | null
        birth_ms: number | null
        suspended_at: number | null
        created_at: number
        mode: string
      }>`
        SELECT s.id, s.owner_user_id, u.handle, s.path, s.inode, s.device, s.birth_ms, s.suspended_at, s.created_at, s.mode
        FROM file_shares s JOIN users u ON u.id = s.owner_user_id
        WHERE s.grantee_user_id = ${userId} AND u.disabled_at IS NULL
        ORDER BY u.handle, s.path`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            ownerId: row.owner_user_id,
            ownerHandle: row.handle,
            path: row.path,
            inode: row.inode,
            device: row.device,
            birthMs: row.birth_ms,
            suspendedAt: row.suspended_at,
            createdAt: row.created_at,
            mode: row.mode === "edit" ? ("edit" as const) : ("view" as const)
          }))
        ),
        query("FileSharesGrantedTo")
      ),
    FileVersionBytes: ({ userId, sha256 }) => versionBytes(sql, userId, sha256).pipe(query("FileVersionBytes"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
