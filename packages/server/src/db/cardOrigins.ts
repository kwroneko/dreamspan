// Cards added from a card source (spec/CARD-SOURCES.md §3.7, §4.5, §8): `AdoptRemoteCard`
// stores what `ImportFile` stores for a new card file and, in the same transaction, the
// `card_origins` row that says which source card it is; `HeldRemoteCards` finds, for a page
// of results, the cards the user already has, by that row or by the same file imported from
// disk (`entity_refs.source_hash`).
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { NotFound } from "@rp/shared/errors.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { LibraryImport } from "@rp/shared/libraryImport.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import type { ReadOps, RefOperationRefused, StorageError, WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

type Writes = Parameters<typeof WriteOps.of>[0]

/** `ImportFile`'s write (libraryWrites.ts), run inside the adoption's transaction. */
type ImportFile = (
  payload: Parameters<Writes["ImportFile"]>[0]
) => Effect.Effect<LibraryImport, NotFound | RefOperationRefused | StorageError | SqlError.SqlError>

interface HeldRow {
  readonly remote_id: string
  readonly entity_id: string
  readonly ref_id: string
  readonly archived: number
  readonly remote_version: string | null
}

export const makeCardOriginReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    HeldRemoteCards: ({ userId, sourceId, items }) =>
      Effect.gen(function* () {
        if (items.length === 0) return []
        const ids = [...new Set(items.map((item) => item.remoteId))]
        const adopted = yield* sql<HeldRow>`
          SELECT o.remote_id, o.entity_id, r.id AS ref_id, e.archived_at IS NOT NULL AS archived,
            o.remote_version
          FROM card_origins o
          JOIN entities e ON e.id = o.entity_id
          JOIN entity_refs r ON r.entity_id = e.id
          WHERE o.owner_user_id = ${userId} AND o.source_id = ${sourceId} AND ${sql.in("o.remote_id", ids)}
            AND e.deleted_at IS NULL AND e.purged_at IS NULL`
        const found = new Map(adopted.map((row) => [row.remote_id, row]))
        // The same file imported from disk: its hash is the source's version id, when that's a SHA-256.
        const hashes = items.filter((item) => !found.has(item.remoteId) && item.sha256 !== null)
        if (hashes.length > 0) {
          const byHash = yield* sql<{ source_hash: string; entity_id: string; ref_id: string; archived: number }>`
            SELECT r.source_hash, e.id AS entity_id, r.id AS ref_id, e.archived_at IS NOT NULL AS archived
            FROM entity_refs r
            JOIN entities e ON e.id = r.entity_id
            WHERE ${sql.in(
              "r.source_hash",
              hashes.map((item) => item.sha256!)
            )}
              AND e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL
            ORDER BY e.created_at`
          const first = new Map<string, (typeof byHash)[number]>()
          for (const row of byHash) if (!first.has(row.source_hash)) first.set(row.source_hash, row)
          for (const item of hashes) {
            const row = first.get(item.sha256!)
            if (row && !found.has(item.remoteId))
              found.set(item.remoteId, { ...row, remote_id: item.remoteId, remote_version: item.sha256 })
          }
        }
        return [...found.values()].map((row) => ({
          remoteId: row.remote_id,
          entityId: row.entity_id as EntityId,
          refId: row.ref_id as RefId,
          archived: row.archived === 1,
          remoteVersion: row.remote_version
        }))
      }).pipe(query("HeldRemoteCards"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeAdoptWriteHandlers = (importFile: ImportFile) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    /** The live card the user has from this source card, if any; an origin left by a binned or purged card goes. */
    const heldCard = (userId: UserId, sourceId: string, remoteId: string) =>
      Effect.gen(function* () {
        const [origin] = yield* sql<{ entity_id: string; ref_id: string | null; gone: number }>`
          SELECT o.entity_id, r.id AS ref_id, (e.deleted_at IS NOT NULL OR e.purged_at IS NOT NULL) AS gone
          FROM card_origins o
          JOIN entities e ON e.id = o.entity_id
          LEFT JOIN entity_refs r ON r.entity_id = e.id
          WHERE o.owner_user_id = ${userId} AND o.source_id = ${sourceId} AND o.remote_id = ${remoteId}`
        if (!origin) return null
        if (origin.gone === 1 || origin.ref_id === null) {
          yield* sql`DELETE FROM card_origins WHERE entity_id = ${origin.entity_id}`
          return null
        }
        return { entityId: origin.entity_id as EntityId, refId: origin.ref_id as RefId }
      })
    return {
      AdoptRemoteCard: ({ userId, sourceId, remoteId, remoteVersion, file }) =>
        Effect.gen(function* () {
          const held = yield* heldCard(userId, sourceId, remoteId)
          if (held) return { ...held, existing: true }
          const imported = yield* importFile({ userId, intoRefId: null, kind: "card", ...file })
          yield* sql`INSERT INTO card_origins ${sql.insert({
            entity_id: imported.ref.entityId,
            owner_user_id: userId,
            source_id: sourceId,
            remote_id: remoteId,
            remote_version: remoteVersion,
            remote_sha256: file.sourceHash,
            recognized_by: "adopted",
            created_at: Date.now()
          })}`
          return { entityId: imported.ref.entityId, refId: imported.ref.id, existing: false }
        }).pipe(transaction(sql, "AdoptRemoteCard"))
    } satisfies Partial<Writes>
  })
