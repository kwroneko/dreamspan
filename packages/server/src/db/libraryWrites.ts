import { safeAgentDocument } from "./agentDocuments.ts"
import { makeAgentHistoryWriteHandlers } from "./agentHistoryWrites.ts"
import { makeHistoryWriteHandlers } from "./historyWrites.ts"
import { makeWorkshopWriteHandlers } from "./workshopWrites.ts"
import { archiveCandidates } from "./cardArchive.ts"
import { newestLiveFork } from "./cardOrigins.ts"
import { makeForkMergeQueries } from "./forkMerge.ts"
import { libraryMergePolicies, defaultLibraryMergePolicy } from "@rp/shared/forkMerge.ts"
import { makeForkMergeWriteHandlers } from "./forkMergeWrites.ts"
import { makeRolloutEffectHandlers } from "./rolloutEffects.ts"
import { withMain } from "@rp/shared/presetOrder.ts"
import { PresetDoc } from "@rp/shared/docs/preset.ts"
import { getAt, parseField } from "@rp/shared/editing.ts"
// Library write handlers (DATA-MODEL §3.2). They run in the writer worker, each as one
// transaction. Every change to a ref flows on to the refs that follow it.
import type { EntityId } from "@rp/shared/chat.ts"
import { conditionCards, NOTE_SCHEMA_VERSION, type NoteDoc, readNoteCondition } from "@rp/shared/docs/note.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, EntityKind, MergeOutcome, RefId } from "@rp/shared/library.ts"
import { ImportedFollower, LibraryImport } from "@rp/shared/libraryImport.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import {
  hasSchema,
  keepsRegexApproval,
  withHtmlApprovals,
  protectedChanges,
  validateDoc,
  withoutGrantedAgentEdits
} from "@rp/shared/editing.ts"
import { InvalidDocument } from "@rp/shared/editorApi.ts"
import { replacementDoc } from "@rp/shared/cardReplace.ts"
import { DraftKey, entityDraftTarget } from "@rp/shared/drafts.ts"
import { isHeldField } from "@rp/shared/editing.ts"
import { editedDoc } from "@rp/shared/presetConditions.ts"
import { fieldContent } from "./drafts.ts"
import { Schema, Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { importFavourite, isFav } from "./cardFavourites.ts"
import { docHash, searchText } from "./documents.ts"
import { makeCardForkWriteHandlers } from "./cardForkWrites.ts"
import { makeEditorWriteHandlers } from "./editorWrites.ts"
import { makeLibraryReplaceWrites } from "./libraryReplaceWrites.ts"
import { makeLibraryQueries, type RefRow, toLibraryRef } from "./library.ts"
import { mediaPath } from "./media.ts"
import { sharedNote } from "./sharedNotes.ts"
import { type FollowerMerge, NotFound, RefChange, RefOperationRefused, StaleWrite, WriteOps } from "./ops.ts"
import { recordCardArrival } from "./stArrival.ts"
import { transaction } from "./tx.ts"

/** Where an imported revision came from: the file's name and hash. */
interface ImportSource {
  readonly modifiedAt?: number
  readonly originRef: string
  readonly sourcePath: string
  readonly sourceHash: string
}

/** A document as stored: its JSON, its hash and its search text. */
export interface EncodedDoc {
  readonly json: string
  readonly hash: string
  readonly searchText: string
}

const encode = (input: Doc): EncodedDoc => {
  const doc =
    Array.isArray(input.prompts) && Array.isArray(input.order)
      ? withMain(Schema.decodeUnknownSync(PresetDoc)(input))
      : input
  return { json: JSON.stringify(doc), hash: docHash(doc), searchText: searchText(doc) }
}
/** For a document changed in the writer before it is stored (a workshop tool's import). */
export const encodeLibraryDoc = encode

/** The URIs a card document's `assets` name. */
const assetUris = (assets: unknown) =>
  Array.isArray(assets)
    ? assets.flatMap((asset) => (Predicate.isObject(asset) && typeof asset.uri === "string" ? [asset.uri] : []))
    : []

export const makeLibraryWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    let archiveClock = 0
    const archiveTime = () => (archiveClock = Math.max(Date.now(), archiveClock + 1))
    yield* libraryMergePolicies.register(defaultLibraryMergePolicy)
    const { drafts } = bin
    const forkMerge = makeForkMergeQueries(sql)

    const insertRevision = (options: {
      readonly entityId: string
      readonly schemaVersion: number
      readonly doc: EncodedDoc
      readonly parents: ReadonlyArray<string>
      readonly origin: "import" | "user" | "merge" | "generation" | "agent" | "changeset"
      readonly originRef: string | null
      readonly message: string | null
      readonly modifiedAt?: number
    }) =>
      Effect.gen(function* () {
        const id = uuidv7()
        const { doc } = options
        // Every revision is valid for its kind. Callers check what users send and say why;
        // this is the backstop, so a bug fails loudly rather than storing a broken document.
        // Imports were checked against the schema in the format worker (importers.ts); a note,
        // small, is checked again here whatever its origin, as the writer completes it.
        const [entity] = yield* sql<{ kind: EntityKind }>`SELECT kind FROM entities WHERE id = ${options.entityId}`
        if (options.origin !== "import" || entity!.kind === "note") {
          const check = hasSchema(entity!.kind) ? validateDoc(entity!.kind, JSON.parse(doc.json)) : null
          if (check && !check.ok) {
            return yield* Effect.die(
              new Error(`refusing to store an invalid ${entity!.kind}: ${check.problems.join("; ")}`)
            )
          }
        }
        yield* sql`INSERT INTO entity_revisions ${sql.insert({
          id,
          entity_id: options.entityId,
          parents: JSON.stringify(options.parents),
          doc_json: doc.json,
          doc_hash: doc.hash,
          schema_version: options.schemaVersion,
          origin: options.origin,
          origin_ref: options.originRef,
          message: options.message,
          search_text: doc.searchText,
          created_at: options.modifiedAt ?? Date.now()
        })}`
        return id
      })

    const reload = (refId: string) => lib.refsWhere("r.id = ?", [refId]).pipe(Effect.map(([row]) => row!))

    const moveHead = (refId: string, head: string, mergeBase: string | null, modifiedAt = Date.now()) =>
      sql`UPDATE entity_refs SET head_revision_id = ${head}, merge_base_revision_id = coalesce(${mergeBase}, merge_base_revision_id),
          row_version = row_version + 1, updated_at = ${modifiedAt}
        WHERE id = ${refId}`

    /** A revision's content hash and document schema version. */
    const revision = (id: string) =>
      sql<{ doc_hash: string; schema_version: number; created_at: number }>`
      SELECT doc_hash, schema_version, created_at FROM entity_revisions WHERE id = ${id}`.pipe(Effect.map(([r]) => r!))

    /**
     * A merge grants nothing the head didn't have: a preset's or card's regex approval survives only with
     * the scripts it was given for, so scripts merged in from a file never arrive approved, and
     * the agent's permission to edit a note or module stays off where it was off (DESIGN §11,
     * §4.1a; @rp/shared/editing.ts).
     */
    const withoutGrants = (ref: RefRow, doc: Doc) =>
      Effect.map(lib.loadDoc(ref.head_revision_id), (ours) => {
        const granted = withoutGrantedAgentEdits(ref.kind, ours, doc)
        if (ref.kind !== "preset" && ref.kind !== "card") return granted
        // Panel permissions stay the head's: a merge neither grants nor takes them.
        const next = withHtmlApprovals(ours, granted)
        return next.regex_approved === true && !keepsRegexApproval(ours, next)
          ? { ...next, regex_approved: false }
          : next
      })

    /**
     * Media, cards and shared notes a document names that aren't the user's, as NotFound: a
     * note's owner card and condition cards, and the shared note a slot links to (§14.3).
     */
    const checkReferences = (userId: string, doc: Doc) =>
      Effect.gen(function* () {
        const media = [
          doc.avatar_media_id,
          ...Object.values(Predicate.isObject(doc.asset_media_ids) ? doc.asset_media_ids : {})
        ].filter((id) => id !== null && id !== undefined)
        for (const id of media) {
          const [held] = yield* sql<{ n: number }>`
            SELECT count(*) AS n FROM media_refs WHERE media_id = ${String(id)} AND owner_user_id = ${userId}`
          if (typeof id !== "string" || held!.n === 0) return yield* new NotFound({ entity: "media", id: String(id) })
        }
        const sharedScope = Predicate.isObject(doc.owner) ? doc.owner.shared : undefined
        if (sharedScope !== undefined && sharedScope !== "global") {
          const [chat] = yield* sql<{
            id: string
          }>`SELECT id FROM chats WHERE id = ${String(sharedScope)} AND owner_user_id = ${userId}`
          if (!chat) return yield* new NotFound({ entity: "chat", id: String(sharedScope) })
        }
        const cards = [
          Predicate.isObject(doc.owner) ? doc.owner.card : undefined,
          ...(doc.condition === undefined ? [] : conditionCards(readNoteCondition(doc.condition)))
        ].filter((card) => card !== undefined)
        for (const card of cards) {
          const [owned] = yield* sql<{ n: number }>`
            SELECT count(*) AS n FROM entities WHERE id = ${String(card)} AND owner_user_id = ${userId} AND kind = 'card'`
          if (typeof card !== "string" || owned!.n === 0)
            return yield* new NotFound({ entity: "card", id: String(card) })
        }
        if (doc.link !== undefined) {
          // A shared note links to nothing: it is what slots link to.
          const shared = Predicate.isObject(doc.owner) && doc.owner.shared !== undefined
          if (typeof doc.link !== "string" || shared || (yield* sharedNote(sql, userId as UserId, doc.link)) === null)
            return yield* new NotFound({ entity: "note", id: String(doc.link) })
        }
      })

    const mergeMessage = (ref: RefRow) =>
      ref.followed_label === null ? "Merged a new import" : `Merged changes from ${ref.followed_label}`

    const recordMerge = (ref: RefRow, revisionId: string, theirs: string, sourceRefId = ref.parent_ref_id) =>
      sql`INSERT INTO library_merges ${sql.insert({
        revision_id: revisionId,
        ref_id: ref.id,
        ours_revision_id: ref.head_revision_id,
        base_revision_id: ref.merge_base_revision_id,
        theirs_revision_id: theirs,
        source_ref_id: sourceRefId,
        selection_json: JSON.stringify({ excluded: [], resolutions: [] }),
        created_at: Date.now()
      })}`

    /** Importing a file or applying an update is explicit; it never changes children. */
    const applyMerge = (ref: RefRow) =>
      Effect.gen(function* () {
        const plan = yield* lib.planMerge(ref)
        if (ref.followed_head === null || plan.theirsHead === ref.merge_base_revision_id) return plan.outcome
        yield* forkMerge.noDrafts(
          (yield* sql<{ owner_user_id: UserId }>`SELECT owner_user_id FROM entities WHERE id = ${ref.entity_id}`)[0]!
            .owner_user_id,
          ref
        )
        if (plan.outcome === "conflicts") return plan.outcome
        // A clean imported update retains its source time. Actual merges with local
        // edits use now; accepting identical content keeps its previous Modified date.
        const modifiedAt =
          plan.outcome === "fast_forward"
            ? (yield* revision(plan.theirsHead)).created_at
            : plan.outcome === "up_to_date"
              ? ref.updated_at
              : undefined
        const merge = yield* insertRevision({
          entityId: ref.entity_id,
          schemaVersion: (yield* revision(ref.head_revision_id)).schema_version,
          doc: encode(yield* withoutGrants(ref, plan.merged)),
          parents: [ref.head_revision_id, plan.theirsHead],
          origin: "merge",
          originRef: ref.parent_ref_id,
          message: mergeMessage(ref),
          ...(modifiedAt === undefined ? {} : { modifiedAt })
        })
        yield* recordMerge(ref, merge, plan.theirsHead)
        yield* moveHead(ref.id, merge, plan.theirsHead, modifiedAt ?? Date.now())
        return plan.outcome
      })

    /** Forks keep their own head until an explicit merge. */
    const changed = (refId: string) =>
      Effect.map(reload(refId), (ref) => new RefChange({ ref: toLibraryRef(ref), followers: [] }))

    /** Merges `ref` with what it follows, and passes any change on to its followers. */
    const mergeAndFlow = (ref: RefRow) =>
      Effect.gen(function* () {
        const outcome = yield* applyMerge(ref)
        const change =
          outcome === "fast_forward" || outcome === "merged"
            ? yield* changed(ref.id)
            : new RefChange({ ref: toLibraryRef(yield* reload(ref.id)), followers: [] })
        return { outcome, change }
      })

    const checkRowVersion = (ref: RefRow, expected: number) =>
      ref.row_version === expected
        ? Effect.void
        : Effect.fail(new StaleWrite({ entity: "ref", id: ref.id, expected, actual: ref.row_version }))

    /** A new entity with its first revision and its upstream ref. */
    const createUpstream = (options: {
      readonly userId: string
      readonly kind: EntityKind
      readonly label: string
      readonly subtitle: string
      readonly doc: EncodedDoc
      readonly schemaVersion: number
      readonly origin: "user" | "import" | "generation" | "agent" | "changeset"
      readonly originRef: string | null
      readonly sourcePath: string | null
      readonly sourceHash: string | null
      readonly createdAt?: number
      readonly modifiedAt?: number
      readonly message?: string | null
    }) =>
      Effect.gen(function* () {
        const at = Date.now()
        const entityId = uuidv7()
        const refId = uuidv7()
        yield* sql`INSERT INTO entities ${sql.insert({ id: entityId, owner_user_id: options.userId, kind: options.kind, created_at: options.createdAt ?? at })}`
        const first = yield* insertRevision({
          entityId,
          schemaVersion: options.schemaVersion,
          doc: options.doc,
          parents: [],
          origin: options.origin,
          originRef: options.originRef,
          message: options.message ?? null,
          ...(options.modifiedAt === undefined ? {} : { modifiedAt: options.modifiedAt })
        })
        yield* sql`INSERT INTO entity_refs ${sql.insert({
          id: refId,
          entity_id: entityId,
          head_revision_id: first,
          // An imported upstream has merged its import (see refSelect in library.ts).
          merge_base_revision_id: options.origin === "import" ? first : null,
          label: options.label,
          subtitle: options.subtitle,
          source_path: options.sourcePath,
          source_hash: options.sourceHash,
          created_at: at,
          updated_at: options.modifiedAt ?? at
        })}`
        return yield* reload(refId)
      })

    /**
     * A fork (spec/LIBRARY-FORKS.md), every kind's: a new entity of the source's kind whose only
     * tie to it is the lineage on its entity row. One revision, `parents: []` (its history starts
     * here), the source revision's document unless `doc` replaces it; its own ref with `label`
     * and `subtitle`, no import source; the source's tags. The parent's later revisions reach it
     * only through an explicit merge (forkMerge.ts), from the revision it was forked from.
     */
    const forkEntity = (options: {
      readonly userId: UserId
      readonly ref: RefRow
      readonly label: string
      readonly subtitle: string
      readonly source?: string
      readonly doc?: Doc
      readonly message?: string
    }) =>
      Effect.gen(function* () {
        const { ref } = options
        const source = options.source ?? ref.head_revision_id
        const fork = yield* createUpstream({
          userId: options.userId,
          kind: ref.kind,
          label: options.label,
          subtitle: options.subtitle,
          doc: encode(options.doc ?? (yield* lib.loadDoc(source))),
          schemaVersion: (yield* revision(source)).schema_version,
          origin: "user",
          originRef: JSON.stringify({ forked: source }),
          sourcePath: null,
          sourceHash: null,
          message: options.message ?? `Forked from ${ref.label}${ref.subtitle ? ` · ${ref.subtitle}` : ""}`
        })
        yield* sql`UPDATE entities SET forked_from_entity_id = ${ref.entity_id}, forked_from_revision_id = ${source},
                     forked_at = ${Date.now()} WHERE id = ${fork.entity_id}`
        // Folders, the persona folder included.
        yield* sql`INSERT INTO entity_tags (entity_id, tag)
                     SELECT ${fork.entity_id}, tag FROM entity_tags WHERE entity_id = ${ref.entity_id}`
        return yield* reload(fork.id)
      })

    /** A new import of an entry, merged with its own edits. */
    const importInto = (
      ref: RefRow,
      options: {
        readonly doc: EncodedDoc
        readonly schemaVersion: number
        readonly originRef: string | null
        readonly sourcePath: string | null
        readonly sourceHash: string | null
        readonly modifiedAt?: number
        readonly stageMerge?: boolean
      }
    ) =>
      Effect.gen(function* () {
        // Until per-kind migrations exist, every revision of an entity has one schema
        // version, so merges never span versions.
        const current = yield* revision(ref.head_revision_id)
        if (options.schemaVersion !== current.schema_version) {
          return yield* new RefOperationRefused({
            refId: ref.id,
            reason: `This is schema version ${options.schemaVersion}, but the library holds version ${current.schema_version}, and documents can't be migrated yet.`
          })
        }
        // Imports form their own line of revisions, which the upstream ref merges in like
        // a variant merges its upstream, so the user's edits to the upstream survive.
        // Importing what was last imported adds nothing to that line.
        const { doc } = options
        const last = ref.import_head === null ? null : yield* revision(ref.import_head)
        if (last === null || last.doc_hash !== doc.hash) {
          yield* insertRevision({
            entityId: ref.entity_id,
            schemaVersion: options.schemaVersion,
            doc,
            parents: ref.import_head === null ? [] : [ref.import_head],
            origin: "import",
            originRef: options.originRef,
            ...(options.modifiedAt === undefined ? {} : { modifiedAt: options.modifiedAt }),
            message: null
          })
        }
        yield* sql`UPDATE entity_refs SET source_path = coalesce(${options.sourcePath}, source_path),
                   source_hash = coalesce(${options.sourceHash}, source_hash) WHERE id = ${ref.id}`
        if (options.stageMerge) {
          // New file on the import line, visible to the explicit merge preview. No content or notes change.
          yield* sql`UPDATE entity_refs SET row_version = row_version + 1 WHERE id = ${ref.id}`
          return { outcome: "conflicts" as const, change: yield* changed(ref.id) }
        }
        return yield* mergeAndFlow(yield* reload(ref.id))
      })

    /**
     * "Import a new version…" (§11.1): the file goes on the card's import line as a re-import's
     * does, and the card's next revision is the file's content wholesale with what a file can't
     * carry kept from the card (`replacementDoc`), two parents (the head, the import), its merge
     * base that import: so a later re-import of the same file is up to date, and a newer one
     * merges against this. Live text is what's sent (§14.2a): the fields typed since the last
     * revision take the new text, as a restore's do, what was typed one state back.
     */
    const replaceCard = (
      userId: UserId,
      ref: RefRow,
      current: Doc,
      file: EncodedDoc,
      schemaVersion: number,
      source: ImportSource,
      options: { readonly expectedHeadRevisionId: string }
    ) =>
      Effect.gen(function* () {
        if (ref.head_revision_id !== options.expectedHeadRevisionId) {
          return yield* new RefOperationRefused({
            refId: ref.id,
            reason: "The card changed since this version was previewed; import it again to see what it changes now."
          })
        }
        const head = yield* revision(ref.head_revision_id)
        if (schemaVersion !== head.schema_version) {
          return yield* new RefOperationRefused({
            refId: ref.id,
            reason: `This is schema version ${schemaVersion}, but the library holds version ${head.schema_version}, and documents can't be migrated yet.`
          })
        }
        const last = ref.import_head === null ? null : yield* revision(ref.import_head)
        const imported =
          last !== null && last.doc_hash === file.hash
            ? ref.import_head!
            : yield* insertRevision({
                entityId: ref.entity_id,
                schemaVersion,
                doc: file,
                parents: ref.import_head === null ? [] : [ref.import_head],
                origin: "import",
                originRef: source.originRef,
                message: null
              })
        yield* sql`UPDATE entity_refs SET source_path = ${source.sourcePath}, source_hash = ${source.sourceHash}
                   WHERE id = ${ref.id}`
        const next = replacementDoc(current, JSON.parse(file.json) as Doc)
        const encoded = encode(next)
        let outcome: MergeOutcome = "up_to_date"
        let headId = ref.head_revision_id
        if (encoded.hash !== head.doc_hash) {
          headId = yield* insertRevision({
            entityId: ref.entity_id,
            schemaVersion,
            doc: encoded,
            parents: [ref.head_revision_id, imported],
            origin: "merge",
            originRef: source.originRef,
            message: `Replaced with a new version from ${source.sourcePath}`
          })
          yield* recordMerge(ref, headId, imported, null)
          yield* moveHead(ref.id, headId, imported)
          outcome = "merged"
        } else if (imported !== ref.merge_base_revision_id) {
          yield* moveHead(ref.id, headId, imported)
        }
        const shown = editedDoc("card", next)
        const fields = yield* sql<{ field: string }>`SELECT field FROM drafts WHERE user_id = ${userId}
          AND target_kind = 'entity_field' AND target_id = ${entityDraftTarget(ref.id as RefId)} AND status = 'active'
          ORDER BY field`
        for (const { field } of fields) {
          if (isHeldField(field)) continue
          const row = yield* drafts.find(
            userId,
            new DraftKey({ targetKind: "entity_field", targetId: entityDraftTarget(ref.id as RefId), field })
          )
          const content = row === null ? null : fieldContent(shown, field)
          if (row !== null && content !== null) yield* drafts.settleOn(row, content, headId)
        }
        return { ref: yield* reload(ref.id), outcome }
      })

    /** Records a file in media storage for the user; the same bytes are one row for everyone. */
    const recordMedia = (
      userId: string,
      file: { sha256: string; mime: string; byteSize: number; width: number | null; height: number | null }
    ) =>
      Effect.gen(function* () {
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
        const [row] = yield* sql<{ id: string }>`SELECT id FROM media_assets WHERE sha256 = ${file.sha256}`
        yield* sql`INSERT INTO media_refs ${sql.insert({ media_id: row!.id, owner_user_id: userId })} ON CONFLICT DO NOTHING`
        return row!.id
      })

    /**
     * ST's Character's Note as the card's first note: a new note, or a new import of the
     * one an earlier import made, merged with the user's edits to it.
     */
    const importNote = (userId: string, cardEntityId: string, noteDocJson: string, source: ImportSource) =>
      Effect.gen(function* () {
        const doc: Doc = { ...(JSON.parse(noteDocJson) as Doc), owner: { card: cardEntityId } }
        const existing = yield* lib.cardNote(userId as UserId, cardEntityId)
        if (existing !== null) {
          yield* importInto(existing, { doc: encode(doc), schemaVersion: NOTE_SCHEMA_VERSION, ...source })
          return yield* reload(existing.id)
        }
        return yield* createUpstream({
          userId,
          kind: "note",
          label: "Character's Note",
          subtitle: "",
          doc: encode(doc),
          schemaVersion: NOTE_SCHEMA_VERSION,
          origin: "import",
          ...source
        })
      })

    /**
     * A card's other note an export carried (a former card module included): a new note, or a
     * new import of the one an earlier import made from the same id, merged with the user's edits.
     */
    const importOtherNote = (userId: string, cardEntityId: string, noteDocJson: string, source: ImportSource) =>
      Effect.gen(function* () {
        const doc: Doc = { ...(JSON.parse(noteDocJson) as Doc), owner: { card: cardEntityId } }
        const existing =
          typeof doc.module_id === "string"
            ? yield* lib.cardNoteFrom(userId as UserId, cardEntityId, doc.module_id)
            : null
        if (existing !== null) {
          yield* importInto(existing, { doc: encode(doc), schemaVersion: NOTE_SCHEMA_VERSION, ...source })
          return
        }
        yield* createUpstream({
          userId,
          kind: "note",
          label: typeof doc.title === "string" && doc.title !== "" ? doc.title : "Note",
          subtitle: "",
          doc: encode(doc),
          schemaVersion: NOTE_SCHEMA_VERSION,
          origin: "import",
          ...source
        })
      })

    const handlers = {
      RecordMessageImage: ({ userId, media }) =>
        recordMedia(userId, media).pipe(transaction(sql, "RecordMessageImage")),
      StImportCharacterNote: ({
        userId,
        cardEntityId,
        prompt,
        useChara,
        placement,
        scanLore,
        sourcePath,
        modifiedAt
      }) =>
        Effect.gen(function* () {
          const [card] = yield* sql<{ n: number }>`
            SELECT count(*) AS n FROM entities WHERE id = ${cardEntityId} AND owner_user_id = ${userId} AND kind = 'card'`
          if (card!.n === 0) return yield* new NotFound({ entity: "card", id: cardEntityId })
          // ST's "replace" keeps both notes [owner question 5]: the importer places it where the
          // author's note was, concretely (owner, 2026-11-01).
          const doc: NoteDoc = {
            schema_version: NOTE_SCHEMA_VERSION,
            title: "Character author's note",
            content: prompt,
            placement,
            owner: { card: cardEntityId },
            exportable: false,
            kind: "character_author_note",
            on_by_default: useChara,
            ...(scanLore ? { scan_lore: true } : {})
          }
          const source = {
            originRef: JSON.stringify({ file: sourcePath }),
            ...(modifiedAt === undefined ? {} : { modifiedAt }),
            sourcePath: `${sourcePath}#character_author_note`,
            sourceHash: null
          }
          const [existing] = yield* sql<{ id: string }>`
            SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
            JOIN entity_revisions h ON h.id = r.head_revision_id
            WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
              AND json_extract(h.doc_json, '$.owner.card') = ${cardEntityId}
              AND json_extract(h.doc_json, '$.kind') = 'character_author_note'
            ORDER BY e.id LIMIT 1`
          if (existing) {
            const ref = yield* lib.ownedRef(userId, existing.id)
            yield* importInto(ref, { doc: encode(doc), schemaVersion: NOTE_SCHEMA_VERSION, ...source })
            return { entity: ref.entity_id as EntityId, created: false }
          }
          const made = yield* createUpstream({
            userId,
            kind: "note",
            label: doc.title,
            subtitle: "",
            doc: encode(doc),
            schemaVersion: NOTE_SCHEMA_VERSION,
            origin: "import",
            ...source
          })
          return { entity: made.entity_id as EntityId, created: true }
        }).pipe(transaction(sql, "StImportCharacterNote")),

      CreateEntity: ({ userId, kind, label, subtitle, doc, schemaVersion, origin, originRef, sourcePath, tags }) =>
        Effect.gen(function* () {
          if (origin === "agent") yield* checkReferences(userId, doc)
          return yield* createUpstream({
            userId,
            kind,
            label,
            subtitle,
            doc: encode(doc),
            schemaVersion,
            origin,
            originRef: originRef ?? sourcePath,
            sourcePath,
            sourceHash: null
          })
        }).pipe(
          Effect.tap((ref) =>
            Effect.gen(function* () {
              for (const tag of new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)))
                yield* sql`INSERT INTO entity_tags ${sql.insert({ entity_id: ref.entity_id, tag })}`
            })
          ),
          Effect.map((ref) => ({ entityId: ref.entity_id as EntityId, ref: toLibraryRef(ref) })),
          transaction(sql, "CreateEntity")
        ),

      SetEntityTags: ({ userId, entityId, tags }) =>
        Effect.gen(function* () {
          const [entity] = yield* sql<{
            id: string
          }>`SELECT id FROM entities WHERE id = ${entityId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
          if (!entity) return yield* new NotFound({ entity: "entity", id: entityId })
          const unique = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))].sort()
          yield* sql`DELETE FROM entity_tags WHERE entity_id = ${entityId}`
          for (const tag of unique) yield* sql`INSERT INTO entity_tags ${sql.insert({ entity_id: entityId, tag })}`
          return unique
        }).pipe(transaction(sql, "SetEntityTags")),

      ArchiveUnusedCards: ({ userId, criteria, entityIds }) =>
        Effect.gen(function* () {
          const requested = new Set(entityIds)
          const eligible = (yield* archiveCandidates(sql, userId, criteria)).filter((c) => requested.has(c.entityId))
          const ids = eligible.map((c) => c.entityId)
          const archivedAt = archiveTime()
          yield* sql`UPDATE entities SET archived_at = ${archivedAt}
            WHERE owner_user_id = ${userId} AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
          return { entityIds: ids, archivedAt }
        }).pipe(transaction(sql, "ArchiveUnusedCards")),
      UndoCardArchive: ({ userId, entityIds, archivedAt }) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`UPDATE entities SET archived_at = NULL
            WHERE owner_user_id = ${userId} AND kind = 'card' AND deleted_at IS NULL
              AND archived_at = ${archivedAt} AND id IN (SELECT value FROM json_each(${JSON.stringify(entityIds)}))
            RETURNING id`
          return rows.length
        }).pipe(transaction(sql, "UndoCardArchive")),
      SetEntityArchived: ({ userId, entityId, archived }) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`
          UPDATE entities SET archived_at = CASE WHEN ${archived ? 1 : 0} = 1 THEN coalesce(archived_at, ${archiveTime()}) END
          WHERE id = ${entityId} AND owner_user_id = ${userId} AND deleted_at IS NULL RETURNING id`
          if (rows.length === 0) return yield* new NotFound({ entity: "entity", id: entityId })
        }).pipe(transaction(sql, "SetEntityArchived")),

      SetRefArchived: ({ userId, refId, archived }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          yield* sql`UPDATE entities
            SET archived_at = CASE WHEN ${archived ? 1 : 0} = 1 THEN coalesce(archived_at, ${archiveTime()}) END
            WHERE id = ${ref.entity_id}`
          return toLibraryRef(yield* reload(refId))
        }).pipe(transaction(sql, "SetRefArchived")),

      EditRef: ({ userId, refId, doc, expectedRowVersion, message, commitDraft, agentOriginRef }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          yield* checkRowVersion(ref, expectedRowVersion)
          if (agentOriginRef !== undefined) {
            doc = yield* withoutGrants(ref, doc)
            const valid = validateDoc(ref.kind, doc)
            if (!valid.ok) return yield* new InvalidDocument({ problems: valid.problems })
            doc = safeAgentDocument(ref.kind, yield* lib.loadDoc(ref.head_revision_id), valid.doc)
            yield* checkReferences(userId, doc)
            if (ref.kind === "preset")
              for (const book of (doc.lorebooks ?? []) as ReadonlyArray<{ id: string }>) {
                const owned = yield* lib.ownedRef(userId, book.id)
                if (owned.kind !== "lorebook") return yield* new NotFound({ entity: "lorebook", id: book.id })
              }
          }
          yield* drafts.commit(userId, commitDraft, {
            targetKind: "entity_field",
            targetId: refId,
            content: (key) => {
              const field = parseField(key)
              if (field === null) return null
              const value = getAt(doc, field.path)
              return field.kind === "text"
                ? typeof value === "string"
                  ? value
                  : null
                : (JSON.stringify(value) ?? null)
            }
          })
          // An edit that changes nothing creates no revision.
          const current = yield* revision(ref.head_revision_id)
          if (current.doc_hash === docHash(doc)) return new RefChange({ ref: toLibraryRef(ref), followers: [] })
          const edit = yield* insertRevision({
            entityId: ref.entity_id,
            schemaVersion: current.schema_version,
            doc: encode(doc),
            parents: [ref.head_revision_id],
            origin: agentOriginRef === undefined ? "user" : "agent",
            originRef: agentOriginRef ?? null,
            message
          })
          yield* moveHead(ref.id, edit, null)
          return yield* changed(ref.id)
        }).pipe(transaction(sql, "EditRef")),

      ForkRef: ({ userId, refId, label, subtitle }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.kind === "card")
            return yield* new RefOperationRefused({ refId, reason: "Cards fork with their names (ForkCard)." })
          return toLibraryRef(yield* forkEntity({ userId, ref, label, subtitle }))
        }).pipe(transaction(sql, "ForkRef")),

      MergeFollowed: ({ userId, refId }) =>
        Effect.flatMap(lib.ownedRef(userId, refId), mergeAndFlow).pipe(transaction(sql, "MergeFollowed")),

      ResolveMerge: ({ userId, refId, doc, theirsRevisionId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          yield* lib.checkMergeBase(ref)
          if (ref.followed_head === null) {
            return yield* new RefOperationRefused({
              refId,
              reason: "This ref follows nothing, so there's nothing to merge."
            })
          }
          yield* checkRowVersion(ref, expectedRowVersion)
          yield* forkMerge.noDrafts(userId, ref)
          if (ref.followed_head !== theirsRevisionId) {
            return yield* new RefOperationRefused({
              refId,
              reason: "What this ref follows changed again since the merge was previewed; preview it again."
            })
          }
          if (ref.followed_head === ref.merge_base_revision_id) {
            return yield* new RefOperationRefused({
              refId,
              reason: "There's no update to resolve: this already has everything it follows."
            })
          }
          // The resolved document comes from the client: it must be valid, keep each protected
          // field from one side or the other, and name only the user's own files and cards.
          const sides = [yield* lib.loadDoc(ref.head_revision_id), yield* lib.loadDoc(theirsRevisionId)]
          const valid = hasSchema(ref.kind) ? validateDoc(ref.kind, doc) : { ok: true as const, doc }
          if (!valid.ok) return yield* new InvalidDocument({ problems: valid.problems })
          yield* checkReferences(userId, valid.doc)
          const moved = protectedChanges(ref.kind, valid.doc, sides)
          if (moved.length > 0) {
            return yield* new InvalidDocument({
              problems: moved.map((field) => `${field}: this can only be kept from one side or the other.`)
            })
          }
          const merge = yield* insertRevision({
            entityId: ref.entity_id,
            schemaVersion: (yield* revision(ref.head_revision_id)).schema_version,
            doc: encode(yield* withoutGrants(ref, valid.doc)),
            parents: [ref.head_revision_id, theirsRevisionId],
            origin: "merge",
            originRef: ref.parent_ref_id,
            message: `${mergeMessage(ref)}, resolved by hand`
          })
          yield* recordMerge(ref, merge, theirsRevisionId)
          yield* moveHead(ref.id, merge, theirsRevisionId)
          return yield* changed(ref.id)
        }).pipe(transaction(sql, "ResolveMerge")),

      // --- Library import
      ImportFile: (input) =>
        Effect.gen(function* () {
          const { userId, intoRefId, kind } = input
          const into = intoRefId === null ? null : yield* lib.ownedRef(userId, intoRefId)
          if (into !== null && into.kind !== kind) {
            return yield* new RefOperationRefused({
              refId: into.id,
              reason: `This file is a ${kind}, not a ${into.kind}.`
            })
          }
          // A new version without some of the card's files (a JSON card has none) keeps the
          // card's current ones, which would otherwise be dropped as the new version's change:
          // its avatar, and the assets its own `assets` still name.
          const current = kind === "card" && into !== null ? yield* lib.loadDoc(into.head_revision_id) : null
          let keptAvatar = false
          let keptAssets = 0
          // Stored as the format worker encoded it, unless a card's files change it.
          let doc: EncodedDoc = { json: input.docJson, hash: input.docHash, searchText: input.searchText }
          if (kind === "card" && (input.media.length > 0 || current !== null)) {
            const card = JSON.parse(input.docJson) as Record<string, unknown>
            let avatar: string | null = null
            // A Map, since a URI comes from the file and could be "__proto__".
            const assets = new Map<string, string>()
            for (const file of input.media) {
              const id = yield* recordMedia(userId, file)
              if (file.role === "avatar") avatar = id
              else assets.set(file.uri, id)
            }
            if (avatar === null && typeof current?.avatar_media_id === "string") {
              avatar = current.avatar_media_id
              keptAvatar = true
            }
            const held = Predicate.isObject(current?.asset_media_ids) ? current.asset_media_ids : {}
            for (const uri of assetUris(card.assets)) {
              const id = Object.hasOwn(held, uri) ? held[uri] : undefined
              if (!assets.has(uri) && typeof id === "string") {
                assets.set(uri, id)
                keptAssets++
              }
            }
            // Untouched unless the file brought media or the card kept some of its own.
            if (input.media.length > 0 || keptAvatar || keptAssets > 0) {
              card.avatar_media_id = avatar
              // The cutout goes with its image (§14.5c): a kept avatar keeps the card's; the file's
              // own (an export of ours carried it) is bound to the file just stored; else the default.
              if (keptAvatar && current?.avatar_crop !== undefined) card.avatar_crop = current.avatar_crop
              else if (!keptAvatar && avatar !== null && Predicate.isObject(card.avatar_crop))
                card.avatar_crop = { ...card.avatar_crop, media_id: avatar }
              else delete card.avatar_crop
              if (assets.size > 0) card.asset_media_ids = Object.fromEntries(assets)
              doc = encode(card)
            }
          }
          // ST's global World Info books, sent with the preset ST had selected (§13): the user's
          // live library lorebooks among them, in the order given, each on.
          const lorebookIds = kind === "preset" ? [...new Set(input.presetLorebooks ?? [])] : []
          if (lorebookIds.length > 0) {
            const live = new Set(
              (yield* sql<{ id: string }>`
                SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
                WHERE ${sql.in("r.id", lorebookIds)} AND e.owner_user_id = ${userId} AND e.kind = 'lorebook'
                  AND e.deleted_at IS NULL`).map((row) => row.id)
            )
            const lorebooks = lorebookIds.filter((id) => live.has(id)).map((id) => ({ id, enabled: true }))
            if (lorebooks.length > 0) doc = encode({ ...(JSON.parse(doc.json) as Doc), lorebooks })
          }
          const source: ImportSource = {
            ...(input.modifiedAt === undefined ? {} : { modifiedAt: input.modifiedAt }),
            originRef: JSON.stringify({ file: input.sourceName, sha256: input.sourceHash }),
            sourcePath: input.sourceName,
            sourceHash: input.sourceHash
          }
          if (input.replace !== undefined) {
            if (into === null || kind !== "card" || current === null) {
              return yield* new RefOperationRefused({
                refId: (intoRefId ?? "") as RefId,
                reason: "Only a card takes a new version in place."
              })
            }
            const replaced = yield* replaceCard(userId, into, current, doc, input.schemaVersion, source, input.replace)
            return new LibraryImport({
              created: false,
              ref: toLibraryRef(replaced.ref),
              outcome: replaced.outcome,
              followers: [],
              note: null,
              keptAvatar,
              keptAssets
            })
          }
          let upstream: RefRow
          let outcome: MergeOutcome | null = null
          let followers: ReadonlyArray<FollowerMerge> = []
          if (into === null) {
            upstream = yield* createUpstream({
              userId,
              kind,
              label: input.label,
              ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
              subtitle: "",
              doc,
              schemaVersion: input.schemaVersion,
              origin: "import",
              ...source
            })
          } else {
            const merged = yield* importInto(into, {
              doc,
              schemaVersion: input.schemaVersion,
              ...source,
              ...(input.stageMerge ? { stageMerge: true } : {})
            })
            upstream = yield* reload(into.id)
            outcome = merged.outcome
            followers = merged.change.followers
          }
          if (kind === "card" && input.arrival !== undefined)
            yield* recordCardArrival(sql, userId, upstream.id, input.arrival)
          // ST's favourite flag (`extensions.fav`), on a first import and each re-import, unless
          // the user set the card's favourite here since; a card without one changes nothing.
          if (kind === "card") {
            const [flag] = yield* sql<{
              fav: unknown
            }>`SELECT json_extract(${doc.json}, '$.extensions.fav') AS fav`
            if (flag?.fav !== null && flag?.fav !== undefined)
              yield* importFavourite(sql, userId, upstream.entity_id, isFav(flag.fav))
          }
          // A source link naming an archive entry makes the card count as the user's copy of it
          // (owner, 2026-11-16), with its version unknown (empty) until one is taken; updates
          // still go through Review and merge. A card keeps one origin.
          if (kind === "card")
            for (const { sourceId, remoteId } of input.recognized ?? []) {
              const [held] = yield* sql<{ entity_id: string; gone: number }>`
                SELECT o.entity_id, (e.deleted_at IS NOT NULL OR e.purged_at IS NOT NULL) AS gone
                FROM card_origins o JOIN entities e ON e.id = o.entity_id
                WHERE o.owner_user_id = ${userId} AND o.source_id = ${sourceId} AND o.remote_id = ${remoteId}`
              // A family whose cards are all gone holds it no longer.
              if (held?.gone === 1 && (yield* newestLiveFork(sql, userId, held.entity_id)) === undefined)
                yield* sql`DELETE FROM card_origins WHERE entity_id = ${held.entity_id}`
              yield* sql`INSERT OR IGNORE INTO card_origins ${sql.insert({
                entity_id: upstream.entity_id,
                owner_user_id: userId,
                source_id: sourceId,
                remote_id: remoteId,
                remote_version: "",
                remote_sha256: input.sourceHash,
                recognized_by: "linked",
                created_at: Date.now()
              })}`
            }
          if (input.stageMerge)
            return new LibraryImport({
              created: false,
              ref: toLibraryRef(upstream),
              outcome: null,
              stagedRevisionId: upstream.import_head! as import("@rp/shared/library.ts").RevisionId,
              followers: [],
              note: null,
              keptAvatar,
              keptAssets
            })
          const noteDocJson =
            input.noteDocJson !== null && input.characterNoteScan
              ? JSON.stringify({ ...(JSON.parse(input.noteDocJson) as Doc), scan_lore: true })
              : input.noteDocJson
          const note = noteDocJson === null ? null : yield* importNote(userId, upstream.entity_id, noteDocJson, source)
          for (const json of input.notesDocJson ?? []) yield* importOtherNote(userId, upstream.entity_id, json, source)
          return new LibraryImport({
            created: intoRefId === null,
            ref: toLibraryRef(upstream),
            outcome,
            followers: yield* Effect.forEach(followers, ({ refId, outcome }) =>
              Effect.map(reload(refId), (ref) => new ImportedFollower({ refId, label: ref.label, outcome }))
            ),
            note: note && toLibraryRef(note),
            keptAvatar,
            keptAssets
          })
        }).pipe(transaction(sql, "ImportFile"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
    // The editors' writes (editorWrites.ts) and card forks (cardForkWrites.ts) work through the same steps.
    const steps = {
      sql,
      lib,
      drafts,
      encode,
      insertRevision,
      moveHead,
      changed,
      reload,
      checkRowVersion,
      revision,
      recordMedia,
      createUpstream,
      forkEntity,
      checkReferences,
      withoutGrants
    }
    return {
      ...handlers,
      ...makeEditorWriteHandlers(steps, bin),
      ...makeWorkshopWriteHandlers(steps, bin),

      ...makeLibraryReplaceWrites(steps),
      ...makeAgentHistoryWriteHandlers(steps, yield* makeHistoryWriteHandlers),
      ...makeCardForkWriteHandlers(steps),
      ...makeForkMergeWriteHandlers(steps),
      ...makeRolloutEffectHandlers(steps)
    }
  })
