// Cards added from a card source (spec/CARD-SOURCES.md §3.7, §4.5, §8): `AdoptRemoteCard`
// stores what `ImportFile` stores for a new card file and, in the same transaction, the
// `card_origins` row that says which source card it is; `AdoptAndStartChat` does that and
// then `StartChat`, in one transaction, for a first send, and `AdoptAndCommitDrafts` does it
// and saves the edits typed on the card before as its revision 2. A source's card's edits are
// `remote_card` drafts (`<source>:<remote>`) until then: every adoption moves them to the new
// card's fields, so nothing typed is lost. `HeldRemoteCards` finds, for a page
// of results, the cards the user already has, by that row or by the same file imported from
// disk (`entity_refs.source_hash`).
//
// Updates (§3.8, §11 phase 5): `remote_version` is the source's version the user has,
// `seen_version` the newest the source reported. `NoteRemoteVersions` records what results and
// Check for a newer version report, `TakeRemoteVersion` what Review and merge or Replace took,
// and `AdoptRemoteVersionAsCard` adds the newer file as a card of its own and takes it, in one
// transaction. `CardOrigin` reads a card's row for its editor.
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { LibraryImport } from "@rp/shared/libraryImport.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { DraftKey } from "@rp/shared/drafts.ts"
import type { ReadOps, RefChange, RefOperationRefused, StartChatResult, StorageError, WriteOps } from "./ops.ts"
import type { EditConflict, InvalidDocument } from "@rp/shared/editorApi.ts"
import type { StaleWrite } from "@rp/shared/errors.ts"
import { makeDraftStore } from "./drafts.ts"
import { query, transaction } from "./tx.ts"

type Writes = Parameters<typeof WriteOps.of>[0]

/** `ImportFile`'s write (libraryWrites.ts), run inside the adoption's transaction. */
type ImportFile = (
  payload: Parameters<Writes["ImportFile"]>[0]
) => Effect.Effect<LibraryImport, NotFound | RefOperationRefused | StorageError | SqlError.SqlError>

/** `CommitEditorDrafts`' write (editorWrites.ts), run after the adoption in its transaction. */
type CommitDrafts = (
  payload: Parameters<Writes["CommitEditorDrafts"]>[0]
) => Effect.Effect<RefChange, NotFound | StaleWrite | EditConflict | InvalidDocument | StorageError | SqlError.SqlError>

/** The writer's draft store (bin.ts): ending a draft keeps its text in the bin. */
type Drafts = ReturnType<typeof makeDraftStore>

/** Where a source's card's drafts are: `remote_card`, `<source>:<remote>`. */
const remoteTarget = (sourceId: string, remoteId: string) => `${sourceId}:${remoteId}`

/** `StartChat`'s write (chatSetupWrites.ts), run after the adoptions in their transaction. */
type StartChat = (
  payload: Parameters<Writes["StartChat"]>[0]
) => Effect.Effect<typeof StartChatResult.Type, NotFound | StorageError | SqlError.SqlError>

interface HeldRow {
  readonly remote_id: string
  readonly entity_id: string
  readonly ref_id: string
  readonly archived: number
  readonly remote_version: string | null
  readonly seen_version: string | null
}

export const makeCardOriginReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const drafts = makeDraftStore(sql)
  return {
    CardOrigin: ({ userId, entityId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          source_id: string
          remote_id: string
          remote_version: string
          seen_version: string | null
        }>`
          SELECT o.source_id, o.remote_id, o.remote_version, o.seen_version
          FROM card_origins o
          JOIN entities e ON e.id = o.entity_id
          WHERE o.entity_id = ${entityId} AND o.owner_user_id = ${userId}
            AND e.deleted_at IS NULL AND e.purged_at IS NULL`
        return row
          ? {
              sourceId: row.source_id,
              remoteId: row.remote_id,
              remoteVersion: row.remote_version,
              seenVersion: row.seen_version
            }
          : null
      }).pipe(query("CardOrigin")),
    RemoteCardDrafts: ({ userId, targetId }) =>
      Effect.gen(function* () {
        const rows = yield* sql<Parameters<typeof drafts.toDraft>[0]>`
          SELECT d.*, (SELECT count(*) FROM draft_history h WHERE h.draft_id = d.id) AS history_length
          FROM drafts d
          WHERE d.user_id = ${userId} AND d.target_kind = 'remote_card' AND d.target_id = ${targetId}
          ORDER BY d.field`
        return rows.map((row) => drafts.toDraft(row))
      }).pipe(query("RemoteCardDrafts")),
    HeldRemoteCards: ({ userId, sourceId, items }) =>
      Effect.gen(function* () {
        if (items.length === 0) return []
        const ids = [...new Set(items.map((item) => item.remoteId))]
        const adopted = yield* sql<HeldRow>`
          SELECT o.remote_id, o.entity_id, r.id AS ref_id, e.archived_at IS NOT NULL AS archived,
            o.remote_version, o.seen_version
          FROM card_origins o
          JOIN entities e ON e.id = o.entity_id
          JOIN entity_refs r ON r.entity_id = e.id
          WHERE o.owner_user_id = ${userId} AND o.source_id = ${sourceId} AND ${sql.in("o.remote_id", ids)}
            AND e.deleted_at IS NULL AND e.purged_at IS NULL`
        const found = new Map(adopted.map((row) => [row.remote_id, row]))
        const adoptedIds = new Set(found.keys())
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
              found.set(item.remoteId, {
                ...row,
                remote_id: item.remoteId,
                remote_version: item.sha256,
                seen_version: null
              })
          }
        }
        return [...found.values()].map((row) => ({
          remoteId: row.remote_id,
          entityId: row.entity_id as EntityId,
          refId: row.ref_id as RefId,
          archived: row.archived === 1,
          remoteVersion: row.remote_version,
          seenVersion: row.seen_version,
          // Only an origin row records versions; a card found by its file's hash has none.
          tracked: adoptedIds.has(row.remote_id)
        }))
      }).pipe(query("HeldRemoteCards"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeAdoptWriteHandlers = (
  importFile: ImportFile,
  startChat: StartChat,
  commitDrafts: CommitDrafts,
  drafts: Drafts
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    /**
     * The edits typed on a source's card before it was added become the card's own unsaved
     * edits, on its head revision. A field the card already has a draft of keeps that one.
     */
    const moveDrafts = (userId: UserId, sourceId: string, remoteId: string, refId: RefId) =>
      sql`UPDATE OR IGNORE drafts SET target_kind = 'entity_field', target_id = ${refId},
            base_revision = (SELECT head_revision_id FROM entity_refs WHERE id = ${refId})
          WHERE user_id = ${userId} AND target_kind = 'remote_card' AND target_id = ${remoteTarget(sourceId, remoteId)}`
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
    const adopt = ({ userId, sourceId, remoteId, remoteVersion, file }: Parameters<Writes["AdoptRemoteCard"]>[0]) =>
      Effect.gen(function* () {
        const held = yield* heldCard(userId, sourceId, remoteId)
        if (held) {
          yield* moveDrafts(userId, sourceId, remoteId, held.refId)
          return { ...held, existing: true }
        }
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
        yield* moveDrafts(userId, sourceId, remoteId, imported.ref.id)
        return { entityId: imported.ref.entityId, refId: imported.ref.id, existing: false }
      })
    /** The user's live card's origin row, or NotFound. */
    const ownOrigin = (userId: UserId, entityId: EntityId) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ source_id: string; remote_id: string }>`
          SELECT o.source_id, o.remote_id FROM card_origins o JOIN entities e ON e.id = o.entity_id
          WHERE o.entity_id = ${entityId} AND o.owner_user_id = ${userId}
            AND e.deleted_at IS NULL AND e.purged_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "card origin", id: entityId })
        return row
      })
    const take = (userId: UserId, entityId: EntityId, version: string) =>
      Effect.gen(function* () {
        yield* ownOrigin(userId, entityId)
        yield* sql`UPDATE card_origins SET remote_version = ${version} WHERE entity_id = ${entityId}`
      })
    return {
      NoteRemoteVersions: ({ userId, sourceId, items }) =>
        Effect.gen(function* () {
          let noted = 0
          for (const { remoteId, version } of items) {
            // Null stands for "the version the user has"; a version reported again writes nothing.
            const changed = yield* sql<{ entity_id: string }>`
              UPDATE card_origins
              SET seen_version = CASE WHEN ${version} = remote_version THEN NULL ELSE ${version} END
              WHERE owner_user_id = ${userId} AND source_id = ${sourceId} AND remote_id = ${remoteId}
                AND coalesce(seen_version, remote_version) IS NOT ${version}
              RETURNING entity_id`
            noted += changed.length
          }
          return { noted }
        }).pipe(transaction(sql, "NoteRemoteVersions")),
      TakeRemoteVersion: ({ userId, entityId, version }) =>
        take(userId, entityId, version).pipe(transaction(sql, "TakeRemoteVersion")),
      AdoptRemoteVersionAsCard: ({ userId, entityId, version, file }) =>
        Effect.gen(function* () {
          yield* ownOrigin(userId, entityId)
          // A card of its own: an import of the file, with no origin row (the first card keeps it).
          const imported = yield* importFile({ userId, intoRefId: null, kind: "card", ...file })
          yield* take(userId, entityId, version)
          return { entityId: imported.ref.entityId, refId: imported.ref.id }
        }).pipe(transaction(sql, "AdoptRemoteVersionAsCard")),
      AdoptAndCommitDrafts: ({ adopt: card, fields, message }) =>
        Effect.gen(function* () {
          const adopted = yield* adopt(card)
          const [ref] = yield* sql<{
            row_version: number
          }>`SELECT row_version FROM entity_refs WHERE id = ${adopted.refId}`
          const change = yield* commitDrafts({
            userId: card.userId,
            refId: adopted.refId,
            expectedRowVersion: ref!.row_version,
            fields,
            message
          })
          return { adopted, change }
        }).pipe(transaction(sql, "AdoptAndCommitDrafts")),
      RevertRemoteDrafts: ({ userId, targetId }) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ field: string }>`SELECT field FROM drafts WHERE user_id = ${userId}
            AND target_kind = 'remote_card' AND target_id = ${targetId} AND status = 'active'`
          let reverted = 0
          for (const { field } of rows) {
            const row = yield* drafts.find(userId, new DraftKey({ targetKind: "remote_card", targetId, field }))
            if (row === null) continue
            yield* drafts.end(row, "discarded")
            reverted++
          }
          return { reverted }
        }).pipe(transaction(sql, "RevertRemoteDrafts")),
      AdoptRemoteCard: (payload) => adopt(payload).pipe(transaction(sql, "AdoptRemoteCard")),
      AdoptAndStartChat: ({ adopt: cards, start }) =>
        Effect.gen(function* () {
          const adopted: Array<{ placeholder: EntityId; entityId: EntityId; refId: RefId; existing: boolean }> = []
          for (const { placeholder, ...card } of cards) {
            const added = yield* adopt(card)
            adopted.push({ placeholder, ...added })
          }
          const swap = new Map<string, EntityId>(adopted.map((card) => [card.placeholder, card.entityId]))
          const id = (entity: EntityId) => swap.get(entity) ?? entity
          const started = yield* startChat({
            ...start,
            cards: [...new Set(start.cards.map(id))],
            persona: start.persona === null ? null : id(start.persona),
            greeters: start.greeters.map((greeter) => ({ ...greeter, entityId: id(greeter.entityId) })),
            first:
              start.first.speakerEntityId === null
                ? start.first
                : { ...start.first, speakerEntityId: id(start.first.speakerEntityId) }
          })
          return { ...started, adopted }
        }).pipe(transaction(sql, "AdoptAndStartChat"))
    } satisfies Partial<Writes>
  })
