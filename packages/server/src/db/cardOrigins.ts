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
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import type { LibraryImport } from "@dreamspan/shared/libraryImport.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { DraftKey } from "@dreamspan/shared/drafts.ts"
import type { ReadOps, RefChange, RefOperationRefused, StartChatResult, StorageError, WriteOps } from "./ops.ts"
import type { EditConflict, InvalidDocument } from "@dreamspan/shared/editorApi.ts"
import type { StaleWrite } from "@dreamspan/shared/errors.ts"
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

/**
 * What an adopted file is, by its document: a lorebook's has top-level `entries` and no
 * greeting, a card's the reverse (a card's own book is under `character_book`). A standalone
 * lorebook from a source (spec/CARD-SOURCES.md §3.9) is added as a lorebook.
 */
export const adoptedKind = (docJson: string): "card" | "lorebook" => {
  try {
    const doc: unknown = JSON.parse(docJson)
    return typeof doc === "object" &&
      doc !== null &&
      Array.isArray((doc as { entries?: unknown }).entries) &&
      !("first_mes" in doc)
      ? "lorebook"
      : "card"
  } catch {
    return "card"
  }
}

/** `StartChat`'s write (chatSetupWrites.ts), run after the adoptions in their transaction. */
type StartChat = (
  payload: Parameters<Writes["StartChat"]>[0]
) => Effect.Effect<typeof StartChatResult.Type, NotFound | StorageError | SqlError.SqlError>

/**
 * A card's newest live fork, forks of forks included (§3.7: a family whose original is in the
 * bin goes to its newest live fork), or undefined when every card of the family is gone.
 */
export const newestLiveFork = (sql: SqlClient.SqlClient, userId: UserId, entityId: string) =>
  Effect.map(
    sql<{ entity_id: string; ref_id: string; archived: number }>`
      WITH RECURSIVE family(id) AS (
        SELECT id FROM entities WHERE forked_from_entity_id = ${entityId} AND owner_user_id = ${userId}
        UNION SELECT e.id FROM entities e JOIN family f ON e.forked_from_entity_id = f.id
          WHERE e.owner_user_id = ${userId}
      )
      SELECT e.id AS entity_id, r.id AS ref_id, e.archived_at IS NOT NULL AS archived
      FROM family f
      JOIN entities e ON e.id = f.id
      JOIN entity_refs r ON r.entity_id = e.id
      WHERE e.owner_user_id = ${userId} AND e.kind IN ('card', 'lorebook')
        AND e.kind = (SELECT o.kind FROM entities o WHERE o.id = ${entityId})
        AND e.deleted_at IS NULL AND e.purged_at IS NULL
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1`,
    (rows) => rows[0]
  )

interface HeldRow {
  readonly remote_id: string
  readonly entity_id: string
  readonly ref_id: string
  readonly archived: number
  readonly remote_version: string | null
  readonly seen_version: string | null
  readonly current_remote_id?: string | null
  readonly remote_locator?: string | null
  readonly ignored?: number
}

/**
 * An imported file whose bytes match a trusted archive response: its card's origin records the
 * archive's version (`recognized`). A card that already tracks this entry by its source link
 * (`linked`, version unknown) is confirmed in place; one with another origin keeps it.
 */
const recognizeRemoteFile = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  sourceId: string,
  remoteId: string,
  version: string,
  sha256: string,
  locator?: string
) =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{64}$/.test(sha256) || version === "") return
    const [match] = yield* sql<{ entity_id: string }>`
    SELECT e.id AS entity_id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
    WHERE e.owner_user_id = ${userId} AND e.kind = 'card'
      AND e.deleted_at IS NULL AND e.purged_at IS NULL AND r.source_hash = ${sha256}
    ORDER BY e.created_at, e.id LIMIT 1`
    if (!match) return
    yield* sql`UPDATE card_origins SET recognized_by = 'recognized', remote_version = ${version},
        current_remote_id = coalesce(current_remote_id, ${remoteId}), remote_locator = coalesce(${locator ?? null}, remote_locator),
        remote_sha256 = ${sha256},
        seen_version = CASE WHEN seen_version = ${version} THEN NULL ELSE seen_version END,
        seen_remote_id = CASE WHEN seen_version = ${version} THEN NULL ELSE seen_remote_id END
      WHERE entity_id = ${match.entity_id} AND owner_user_id = ${userId} AND recognized_by = 'linked'
        AND source_id = ${sourceId} AND (remote_id = ${remoteId} OR current_remote_id = ${remoteId})`
    yield* sql`INSERT OR IGNORE INTO card_origins ${sql.insert({
      entity_id: match.entity_id,
      owner_user_id: userId,
      source_id: sourceId,
      remote_id: remoteId,
      remote_version: version,
      current_remote_id: remoteId,
      remote_locator: locator ?? null,
      remote_sha256: sha256,
      recognized_by: "recognized",
      created_at: Date.now()
    })}`
  })

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
          recognized_by: string
          current_remote_id: string | null
          remote_locator: string | null
          seen_remote_id: string | null
          ignore_updates: number
        }>`
          SELECT o.source_id, o.remote_id, o.remote_version, o.seen_version, o.recognized_by,
            o.current_remote_id, o.remote_locator, o.seen_remote_id, o.ignore_updates
          FROM card_origins o
          JOIN entities e ON e.id = o.entity_id
          WHERE o.entity_id = ${entityId} AND o.owner_user_id = ${userId}
            AND e.deleted_at IS NULL AND e.purged_at IS NULL`
        return row
          ? {
              sourceId: row.source_id,
              remoteId: row.remote_id,
              remoteVersion: row.remote_version,
              currentRemoteId: row.current_remote_id ?? row.remote_id,
              locator: row.remote_locator,
              seenRemoteId: row.seen_remote_id,
              seenVersion: row.seen_version,
              recognized: row.recognized_by !== "adopted",
              linked: row.recognized_by === "linked",
              ignoreUpdates: row.ignore_updates === 1
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
        const origins = yield* sql<HeldRow & { gone: number; recognized_by: string }>`
          SELECT o.remote_id, o.entity_id, r.id AS ref_id, e.archived_at IS NOT NULL AS archived,
            o.remote_version, CASE WHEN o.ignore_updates = 1 THEN NULL ELSE o.seen_version END AS seen_version,
            o.recognized_by, o.current_remote_id, o.remote_locator,
            (e.deleted_at IS NOT NULL OR e.purged_at IS NOT NULL) AS gone, o.ignore_updates AS ignored, o.recognized_by = 'linked' AS weak, 0 AS successor
          FROM card_origins o JOIN entities e ON e.id = o.entity_id LEFT JOIN entity_refs r ON r.entity_id = e.id
          WHERE o.owner_user_id = ${userId} AND o.source_id = ${sourceId} AND ${sql.in("o.remote_id", ids)}
          UNION ALL
          SELECT o.current_remote_id AS remote_id, o.entity_id, r.id AS ref_id, e.archived_at IS NOT NULL AS archived,
            o.remote_version, CASE WHEN o.ignore_updates = 1 THEN NULL ELSE o.seen_version END AS seen_version,
            o.recognized_by, o.current_remote_id, o.remote_locator,
            (e.deleted_at IS NOT NULL OR e.purged_at IS NOT NULL) AS gone, o.ignore_updates AS ignored, o.recognized_by = 'linked' AS weak, 1 AS successor
          FROM card_origins o JOIN entities e ON e.id = o.entity_id LEFT JOIN entity_refs r ON r.entity_id = e.id
          WHERE o.owner_user_id = ${userId} AND o.source_id = ${sourceId}
            AND ${sql.in("o.current_remote_id", ids)} AND o.current_remote_id <> o.remote_id
          ORDER BY weak, successor`
        const found = new Map<string, HeldRow>()
        // Entries held only by a linked card (no byte match yet): an imported file whose bytes
        // match still goes before it, so the match can be recognized.
        const linkedOnly = new Set<string>()
        // A byte-confirmed or added card goes before one only linked to the entry, and an entry's
        // own id before a successor's. Confirmed imports and additions record versions; a bin
        // fallback does not.
        const tracked = new Set<string>()
        for (const row of origins) {
          if (found.has(row.remote_id)) continue
          if (row.gone === 0 && row.ref_id !== null) {
            found.set(row.remote_id, row)
            tracked.add(row.remote_id)
            if (row.recognized_by === "linked") linkedOnly.add(row.remote_id)
            continue
          }
          // The card is in the bin: its newest live fork stands for the family.
          const fork = yield* newestLiveFork(sql, userId, row.entity_id)
          if (fork)
            found.set(row.remote_id, {
              ...fork,
              remote_id: row.remote_id,
              remote_version: row.remote_version,
              seen_version: null
            })
        }
        // The same file imported from disk: its hash is the source's version id, when that's a SHA-256.
        const open = (remoteId: string) => !found.has(remoteId) || linkedOnly.has(remoteId)
        const hashes = items.filter((item) => open(item.remoteId) && item.sha256 !== null)
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
            if (row && open(item.remoteId)) {
              found.set(item.remoteId, {
                ...row,
                remote_id: item.remoteId,
                remote_version: item.sha256,
                seen_version: null
              })
              linkedOnly.delete(item.remoteId)
              tracked.delete(item.remoteId)
            }
          }
        }
        return [...found.values()].map((row) => ({
          remoteId: row.remote_id,
          entityId: row.entity_id as EntityId,
          refId: row.ref_id as RefId,
          archived: row.archived === 1,
          remoteVersion: row.remote_version,
          seenVersion: row.seen_version,
          // A confirmed origin records versions; a hash match still needs confirmation.
          tracked: tracked.has(row.remote_id),
          ignored: row.ignored === 1,
          currentRemoteId: row.current_remote_id ?? row.remote_id,
          locator: row.remote_locator ?? null
        }))
      }).pipe(query("HeldRemoteCards")),
    EditedRemoteCards: () =>
      Effect.gen(function* () {
        const rows = yield* sql<{ user_id: string; target_id: string }>`
          SELECT DISTINCT user_id, target_id FROM drafts
          WHERE target_kind = 'remote_card' AND status = 'active'`
        // The target is `<source>:<remote>`; a source id has no colon.
        return rows.flatMap((row) => {
          const at = row.target_id.indexOf(":")
          return at > 0
            ? [
                {
                  userId: row.user_id as UserId,
                  sourceId: row.target_id.slice(0, at),
                  remoteId: row.target_id.slice(at + 1)
                }
              ]
            : []
        })
      }).pipe(query("EditedRemoteCards"))
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
          WHERE o.owner_user_id = ${userId} AND o.source_id = ${sourceId} AND (o.remote_id = ${remoteId} OR o.current_remote_id = ${remoteId})
          ORDER BY o.recognized_by = 'linked', (o.remote_id = ${remoteId}) DESC, o.created_at LIMIT 1`
        if (!origin) return null
        if (origin.gone === 1 || origin.ref_id === null) {
          // In the bin: its newest live fork is the user's card from there (§3.7).
          const fork = yield* newestLiveFork(sql, userId, origin.entity_id)
          if (fork) return { entityId: fork.entity_id as EntityId, refId: fork.ref_id as RefId }
          yield* sql`DELETE FROM card_origins WHERE entity_id = ${origin.entity_id}`
          return null
        }
        return { entityId: origin.entity_id as EntityId, refId: origin.ref_id as RefId }
      })
    const adopt = ({
      userId,
      sourceId,
      remoteId,
      remoteVersion,
      file,
      locator
    }: Parameters<Writes["AdoptRemoteCard"]>[0]) =>
      Effect.gen(function* () {
        const kind = adoptedKind(file.docJson)
        // Recognizing an imported file by its hash is for cards (§3.7); a lorebook is found by its origin.
        if (kind === "card")
          yield* recognizeRemoteFile(sql, userId, sourceId, remoteId, remoteVersion, file.sourceHash, locator)
        const held = yield* heldCard(userId, sourceId, remoteId)
        if (held) {
          yield* moveDrafts(userId, sourceId, remoteId, held.refId)
          return { ...held, existing: true }
        }
        const imported = yield* importFile({ userId, intoRefId: null, kind, ...file })
        yield* sql`INSERT INTO card_origins ${sql.insert({
          entity_id: imported.ref.entityId,
          owner_user_id: userId,
          source_id: sourceId,
          remote_id: remoteId,
          remote_version: remoteVersion,
          current_remote_id: remoteId,
          remote_locator: locator ?? null,
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
    const take = (
      userId: UserId,
      entityId: EntityId,
      version: string,
      currentId?: string,
      locator?: string | null,
      sha256?: string
    ) =>
      Effect.gen(function* () {
        yield* ownOrigin(userId, entityId)
        yield* sql`UPDATE card_origins SET remote_version = ${version},
          current_remote_id = coalesce(${currentId ?? null}, current_remote_id, remote_id),
          remote_locator = CASE WHEN ${locator === undefined ? 0 : 1} THEN ${locator ?? null} ELSE remote_locator END,
          remote_sha256 = coalesce(${sha256 ?? null}, remote_sha256),
          seen_remote_id = CASE WHEN seen_version = ${version} THEN NULL ELSE seen_remote_id END,
          seen_version = CASE WHEN seen_version = ${version} THEN NULL ELSE seen_version END
          WHERE entity_id = ${entityId} AND owner_user_id = ${userId}`
      })
    return {
      RecognizeRemoteCards: ({ userId, sourceId, items }) =>
        Effect.gen(function* () {
          for (const item of items)
            yield* recognizeRemoteFile(sql, userId, sourceId, item.remoteId, item.version, item.sha256, item.locator)
        }).pipe(transaction(sql, "RecognizeRemoteCards")),
      NoteRemoteVersions: ({ userId, sourceId, items }) =>
        Effect.gen(function* () {
          let noted = 0
          for (const { remoteId, version, currentId, locator } of items) {
            // Null stands for "the version the user has"; a version reported again writes nothing.
            const changed = yield* sql<{ entity_id: string }>`
              UPDATE card_origins
              SET seen_version = CASE WHEN ${version} = remote_version THEN NULL ELSE ${version} END,
                seen_remote_id = CASE WHEN ${version} = remote_version THEN NULL ELSE ${currentId ?? remoteId} END,
                remote_locator = coalesce(${locator ?? null}, remote_locator)
              WHERE owner_user_id = ${userId} AND source_id = ${sourceId} AND (remote_id = ${remoteId} OR current_remote_id = ${remoteId})
                AND (coalesce(seen_version, remote_version) IS NOT ${version}
                  OR (${locator ?? null} IS NOT NULL AND remote_locator IS NOT ${locator ?? null}))
              RETURNING entity_id`
            noted += changed.length
          }
          return { noted }
        }).pipe(transaction(sql, "NoteRemoteVersions")),
      SetRemoteUpdatesIgnored: ({ userId, entityId, ignored }) =>
        Effect.gen(function* () {
          yield* ownOrigin(userId, entityId)
          yield* sql`UPDATE card_origins SET ignore_updates = ${ignored ? 1 : 0}
            WHERE entity_id = ${entityId} AND owner_user_id = ${userId}`
        }).pipe(transaction(sql, "SetRemoteUpdatesIgnored")),
      TakeRemoteVersion: ({ userId, entityId, version, currentId, locator, sha256 }) =>
        take(userId, entityId, version, currentId, locator, sha256).pipe(transaction(sql, "TakeRemoteVersion")),
      AdoptRemoteVersionAsCard: ({ userId, entityId, version, file, currentId, locator }) =>
        Effect.gen(function* () {
          const origin = yield* ownOrigin(userId, entityId)
          // A card of its own, which tracks the entry too, from the version it was added from
          // (owner, 2026-11-16): both cards get future update notices.
          const imported = yield* importFile({ userId, intoRefId: null, kind: "card", ...file })
          yield* sql`INSERT INTO card_origins ${sql.insert({
            entity_id: imported.ref.entityId,
            owner_user_id: userId,
            source_id: origin.source_id,
            remote_id: origin.remote_id,
            remote_version: version,
            current_remote_id: currentId ?? origin.remote_id,
            remote_locator: locator ?? null,
            remote_sha256: file.sourceHash,
            recognized_by: "adopted",
            created_at: Date.now()
          })}`
          // The first card's notice for this version ends; a later version notifies both.
          yield* take(userId, entityId, version, currentId, locator, file.sourceHash)
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
