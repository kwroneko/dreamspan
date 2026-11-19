// Folders shared with other accounts, and the versions list (spec/FILES-AND-ENVIRONMENT.md §1.3,
// §1.4, §10): `file_shares` rows (owner, path, grantee, Can view or Can edit), written only by the
// owner; the host resolves `/files/Shared/<owner>/<folder>` for a grantee from what's read here.
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

interface ShareRow {
  readonly id: string
  readonly owner_user_id: string
  readonly path: string
  readonly grantee_user_id: string
  readonly mode: "view" | "edit"
  readonly created_at: number
  readonly handle: string
  readonly display_name: string
}

const toShare = (row: ShareRow) => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  path: row.path,
  granteeUserId: row.grantee_user_id,
  mode: row.mode,
  createdAt: row.created_at,
  handle: row.handle,
  displayName: row.display_name
})

export const makeFileShareWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ShareFolder: ({ userId, path, inode, granteeUserId, mode }) =>
      Effect.gen(function* () {
        const [grantee] = yield* sql<{ id: string }>`SELECT id FROM users
          WHERE id = ${granteeUserId} AND id != ${userId} AND disabled_at IS NULL`
        if (!grantee) return yield* new NotFound({ entity: "account", id: granteeUserId })
        yield* sql`INSERT INTO file_shares ${sql.insert({
          id: uuidv7(),
          owner_user_id: userId,
          path,
          inode,
          grantee_user_id: granteeUserId,
          mode,
          created_at: Date.now()
        })} ON CONFLICT (owner_user_id, path, grantee_user_id) DO UPDATE SET mode = excluded.mode, inode = excluded.inode`
        const [row] = yield* sql<ShareRow>`SELECT s.*, u.handle, u.display_name FROM file_shares s
          JOIN users u ON u.id = s.grantee_user_id
          WHERE s.owner_user_id = ${userId} AND s.path = ${path} AND s.grantee_user_id = ${granteeUserId}`
        return toShare(row!)
      }).pipe(transaction(sql, "ShareFolder")),
    StopSharingFolder: ({ userId, shareId }) =>
      Effect.gen(function* () {
        const gone = yield* sql<{ id: string }>`DELETE FROM file_shares
          WHERE id = ${shareId} AND owner_user_id = ${userId} RETURNING id`
        if (gone.length === 0) return yield* new NotFound({ entity: "share", id: shareId })
      }).pipe(transaction(sql, "StopSharingFolder"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})

export const makeFileShareReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SharedByMe: ({ userId }) =>
      sql<ShareRow>`SELECT s.*, u.handle, u.display_name FROM file_shares s
        JOIN users u ON u.id = s.grantee_user_id
        WHERE s.owner_user_id = ${userId} ORDER BY s.path, s.created_at, s.id`.pipe(
        Effect.map((rows) => rows.map(toShare)),
        query("SharedByMe")
      ),
    // The owner's name is theirs (`handle`); a disabled owner's folders aren't offered.
    SharesWithMe: ({ userId }) =>
      sql<ShareRow>`SELECT s.*, u.handle, u.display_name FROM file_shares s
        JOIN users u ON u.id = s.owner_user_id
        WHERE s.grantee_user_id = ${userId} AND u.disabled_at IS NULL ORDER BY u.handle, s.path`.pipe(
        Effect.map((rows) => rows.map(toShare)),
        query("SharesWithMe")
      ),
    ListFileVersions: ({ userId, path, limit }) =>
      sql<{
        id: string
        created_at: number
        origin: string
        byte_size: number
        media_id: string | null
        handle: string | null
        display_name: string | null
      }>`SELECT v.id, v.created_at, v.origin, v.byte_size, v.media_id, u.handle, u.display_name
        FROM file_versions v LEFT JOIN users u ON u.id = v.actor_user_id
        WHERE v.owner_user_id = ${userId} AND v.path = ${path}
        ORDER BY v.created_at DESC, v.id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            createdAt: row.created_at,
            origin: row.origin,
            byteSize: row.byte_size,
            hasContent: row.media_id !== null,
            actor: row.handle === null ? null : { handle: row.handle, displayName: row.display_name ?? row.handle }
          }))
        ),
        query("ListFileVersions")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
