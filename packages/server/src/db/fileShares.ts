// Folders shared with other accounts, and the versions list (spec/FILES-AND-ENVIRONMENT.md §1.3,
// §1.4, §10): `file_shares` rows (owner, path, the folder's identity, grantee, Can view or Can
// edit), made when the other account accepts a `file_share_invitations` row, written otherwise
// only by the owner; the host resolves `/files/Shared/<owner>/<folder>` for a grantee from what's
// read here, and checks the folder at the path is still the one shared.
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
  readonly inode: number | null
  readonly device: number | null
  readonly birth_ms: number | null
  readonly suspended_at: number | null
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
  displayName: row.display_name,
  inode: row.inode,
  device: row.device,
  birthMs: row.birth_ms,
  suspendedAt: row.suspended_at
})

interface InvitationRow {
  readonly id: string
  readonly owner_user_id: string
  readonly path: string
  readonly mode: "view" | "edit"
  readonly created_at: number
  readonly handle: string
  readonly display_name: string
  readonly grantee_user_id: string | null
}

const toInvitation = (row: InvitationRow) => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  path: row.path,
  mode: row.mode,
  createdAt: row.created_at,
  handle: row.handle,
  displayName: row.display_name,
  granteeUserId: row.grantee_user_id
})

export const makeFileShareWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  /** A share of the owner's, with the grantee's names (the owner's view of it). */
  const ownShare = (userId: string, where: { id: string } | { path: string; granteeUserId: string }) =>
    Effect.map(
      "id" in where
        ? sql<ShareRow>`SELECT s.*, u.handle, u.display_name FROM file_shares s JOIN users u ON u.id = s.grantee_user_id
            WHERE s.owner_user_id = ${userId} AND s.id = ${where.id}`
        : sql<ShareRow>`SELECT s.*, u.handle, u.display_name FROM file_shares s JOIN users u ON u.id = s.grantee_user_id
            WHERE s.owner_user_id = ${userId} AND s.path = ${where.path} AND s.grantee_user_id = ${where.granteeUserId}`,
      ([row]) => (row ? toShare(row) : null)
    )
  return {
    InviteToFolder: ({ userId, path, inode, device, birthMs, handle, mode }) =>
      Effect.gen(function* () {
        // The account the name is now, if enabled. An account named so later never gets it.
        const [grantee] = yield* sql<{ id: string }>`SELECT id FROM users
          WHERE handle = ${handle} AND id != ${userId} AND disabled_at IS NULL`
        if (grantee) {
          // Already accepted: the mode changes. (The owner knows that account: it accepted.)
          const [held] = yield* sql<{ id: string }>`UPDATE file_shares SET mode = ${mode}
            WHERE owner_user_id = ${userId} AND path = ${path} AND grantee_user_id = ${grantee.id}
              AND suspended_at IS NULL AND inode = ${inode} AND device = ${device}
              AND birth_ms IS ${birthMs} RETURNING id`
          if (held) return { share: (yield* ownShare(userId, { id: held.id }))! }
        }
        yield* sql`INSERT INTO file_share_invitations ${sql.insert({
          id: uuidv7(),
          owner_user_id: userId,
          path,
          inode,
          device,
          birth_ms: birthMs,
          handle,
          grantee_user_id: grantee?.id ?? null,
          mode,
          created_at: Date.now()
        })} ON CONFLICT (owner_user_id, path, handle) DO UPDATE SET mode = excluded.mode,
          inode = excluded.inode, device = excluded.device, birth_ms = excluded.birth_ms, declined_at = NULL`
        const [row] = yield* sql<InvitationRow>`SELECT i.*, i.handle AS display_name FROM file_share_invitations i
          WHERE i.owner_user_id = ${userId} AND i.path = ${path} AND i.handle = ${handle}`
        return { invitation: toInvitation(row!) }
      }).pipe(transaction(sql, "InviteToFolder")),
    AnswerShareInvitation: ({ userId, invitationId, accept }) =>
      Effect.gen(function* () {
        if (!accept) {
          // Declined: it stays in the owner's list as Invited, like one to a name with no account
          // (the owner can't tell the two apart), and only stops showing for this account.
          const declined = yield* sql<{ id: string }>`UPDATE file_share_invitations SET declined_at = ${Date.now()}
            WHERE id = ${invitationId} AND grantee_user_id = ${userId} AND declined_at IS NULL
              AND owner_user_id IN (SELECT id FROM users WHERE disabled_at IS NULL) RETURNING id`
          if (declined.length === 0) return yield* new NotFound({ entity: "invitation", id: invitationId })
          return null
        }
        const [invitation] = yield* sql<{
          owner_user_id: string
          path: string
          inode: number | null
          device: number | null
          birth_ms: number | null
          mode: "view" | "edit"
        }>`DELETE FROM file_share_invitations WHERE id = ${invitationId} AND grantee_user_id = ${userId}
          AND declined_at IS NULL
          AND owner_user_id IN (SELECT id FROM users WHERE disabled_at IS NULL)
          RETURNING owner_user_id, path, inode, device, birth_ms, mode`
        if (!invitation) return yield* new NotFound({ entity: "invitation", id: invitationId })
        // The share starts now, on the folder the invitation was made on.
        yield* sql`INSERT INTO file_shares ${sql.insert({
          id: uuidv7(),
          owner_user_id: invitation.owner_user_id,
          path: invitation.path,
          inode: invitation.inode,
          device: invitation.device,
          birth_ms: invitation.birth_ms,
          grantee_user_id: userId,
          mode: invitation.mode,
          created_at: Date.now(),
          suspended_at: null
        })} ON CONFLICT (owner_user_id, path, grantee_user_id) DO UPDATE SET mode = excluded.mode,
          inode = excluded.inode, device = excluded.device, birth_ms = excluded.birth_ms, created_at = excluded.created_at, suspended_at = NULL`
        const [row] = yield* sql<ShareRow>`SELECT s.*, u.handle, u.display_name FROM file_shares s
          JOIN users u ON u.id = s.owner_user_id
          WHERE s.owner_user_id = ${invitation.owner_user_id} AND s.path = ${invitation.path}
            AND s.grantee_user_id = ${userId}`
        return toShare(row!)
      }).pipe(transaction(sql, "AnswerShareInvitation")),
    RebindFolderShare: ({ userId, shareId, inode, device, birthMs }) =>
      Effect.gen(function* () {
        const done = yield* sql<{
          id: string
        }>`UPDATE file_shares SET inode = ${inode}, device = ${device}, birth_ms = ${birthMs},
          suspended_at = NULL, created_at = ${Date.now()}
          WHERE id = ${shareId} AND owner_user_id = ${userId} RETURNING id`
        if (done.length === 0) return yield* new NotFound({ entity: "share", id: shareId })
        return (yield* ownShare(userId, { id: shareId }))!
      }).pipe(transaction(sql, "RebindFolderShare")),
    StopSharingFolder: ({ userId, shareId }) =>
      Effect.gen(function* () {
        const gone = yield* sql<{ id: string }>`DELETE FROM file_shares
          WHERE id = ${shareId} AND owner_user_id = ${userId} RETURNING id`
        const taken = yield* sql<{ id: string }>`DELETE FROM file_share_invitations
          WHERE id = ${shareId} AND owner_user_id = ${userId} RETURNING id`
        if (gone.length === 0 && taken.length === 0) return yield* new NotFound({ entity: "share", id: shareId })
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
    // Under the name typed, whether or not it named an account: the owner learns nothing from it.
    ShareInvitationsSent: ({ userId }) =>
      sql<InvitationRow>`SELECT i.*, i.handle AS display_name FROM file_share_invitations i
        WHERE i.owner_user_id = ${userId} ORDER BY i.path, i.created_at, i.id`.pipe(
        Effect.map((rows) => rows.map(toInvitation)),
        query("ShareInvitationsSent")
      ),
    ShareInvitationsReceived: ({ userId }) =>
      sql<InvitationRow>`SELECT i.id, i.owner_user_id, i.path, i.mode, i.created_at, i.grantee_user_id, u.handle,
        u.display_name
        FROM file_share_invitations i JOIN users u ON u.id = i.owner_user_id
        WHERE i.grantee_user_id = ${userId} AND i.declined_at IS NULL AND u.disabled_at IS NULL ORDER BY i.created_at, i.id`.pipe(
        Effect.map((rows) => rows.map(toInvitation)),
        query("ShareInvitationsReceived")
      ),
    ListFileVersions: ({ userId, path, limit, since }) =>
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
        WHERE v.owner_user_id = ${userId} AND v.path = ${path} AND v.created_at >= ${since ?? 0}
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
