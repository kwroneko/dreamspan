// File versions (spec/FILES-AND-ENVIRONMENT.md §1.3, §10): an account's earlier file contents,
// in the content-addressed media store. The bytes are written first, on the main thread
// (importer/mediaFiles.ts, held from the sweep), then recorded here in one transaction.
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { mediaPath } from "./media.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"
import { toRolloutEffect } from "./workshopEffects.ts"
import { EffectUndoRefused } from "@rp/shared/workshopApi.ts"

export const makeFileVersionWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RecordFileVersions: ({ userId, versions }) =>
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
            mediaId = row!.id
            yield* sql`INSERT INTO media_refs ${sql.insert({ media_id: mediaId, owner_user_id: userId })} ON CONFLICT DO NOTHING`
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
            actor_user_id: userId,
            rollout_id: version.rolloutId ?? null,
            tool_call_id: version.rolloutId ? (version.toolCallId ?? null) : null,
            created_at: now
          })}`
          ids.push(id)
        }
        return ids
      }).pipe(transaction(sql, "RecordFileVersions")),
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
        }>`SELECT v.id, v.path, v.inode, v.byte_size, v.origin, m.sha256, m.path AS media_path
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
          mediaPath: row.media_path
        }
      }).pipe(query("FileVersion"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
