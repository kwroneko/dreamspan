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
  protectedChanges,
  validateDoc,
  withoutGrantedAgentEdits
} from "@rp/shared/editing.ts"
import { InvalidDocument } from "@rp/shared/editorApi.ts"
import { Schema, Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { docHash, searchText } from "./documents.ts"
import { makeCardForkWriteHandlers } from "./cardForkWrites.ts"
import { makeEditorWriteHandlers } from "./editorWrites.ts"
import { makeLibraryQueries, type RefRow, toLibraryRef } from "./library.ts"
import { mediaPath } from "./media.ts"
import { sharedNote } from "./sharedNotes.ts"
import { FollowerMerge, NotFound, RefChange, RefOperationRefused, StaleWrite, WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

/** Where an imported revision came from: the file's name and hash. */
interface ImportSource {
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

/** The URIs a card document's `assets` name. */
const assetUris = (assets: unknown) =>
  Array.isArray(assets)
    ? assets.flatMap((asset) => (Predicate.isObject(asset) && typeof asset.uri === "string" ? [asset.uri] : []))
    : []

export const makeLibraryWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    const { drafts } = bin

    /** The user's live chat, or NotFound. */
    const liveChat = (userId: UserId, chatId: string) =>
      sql<{
        id: string
      }>`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
        Effect.flatMap(([chat]) => (chat ? Effect.void : Effect.fail(new NotFound({ entity: "chat", id: chatId }))))
      )

    /**
     * A chat override following `ref`, starting at `head` (its head unless the chat used an
     * older revision): changes for that chat only (DESIGN §4).
     */
    const insertOverride = (ref: RefRow, chatId: string, head: string = ref.head_revision_id) =>
      Effect.gen(function* () {
        const id = uuidv7()
        const at = Date.now()
        yield* sql`INSERT INTO entity_refs ${sql.insert({
          id,
          entity_id: ref.entity_id,
          ref_kind: "chat_override",
          head_revision_id: head,
          follows_ref_id: ref.id,
          merge_base_revision_id: head,
          label: ref.label,
          subtitle: "",
          chat_id: chatId,
          created_at: at,
          updated_at: at
        })}`
        return yield* reload(id)
      })

    const insertRevision = (options: {
      readonly entityId: string
      readonly schemaVersion: number
      readonly doc: EncodedDoc
      readonly parents: ReadonlyArray<string>
      readonly origin: "import" | "user" | "merge"
      readonly originRef: string | null
      readonly message: string | null
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
          created_at: Date.now()
        })}`
        return id
      })

    const reload = (refId: string) => lib.refsWhere("r.id = ?", [refId]).pipe(Effect.map(([row]) => row!))

    const moveHead = (refId: string, head: string, mergeBase: string | null) =>
      sql`UPDATE entity_refs SET head_revision_id = ${head}, merge_base_revision_id = coalesce(${mergeBase}, merge_base_revision_id),
          row_version = row_version + 1, updated_at = ${Date.now()}
        WHERE id = ${refId}`

    /** A revision's content hash and document schema version. */
    const revision = (id: string) =>
      sql<{ doc_hash: string; schema_version: number }>`
      SELECT doc_hash, schema_version FROM entity_revisions WHERE id = ${id}`.pipe(Effect.map(([r]) => r!))

    /**
     * A merge grants nothing the head didn't have: a preset's or card's regex approval survives only with
     * the scripts it was given for, so scripts merged in from a file never arrive approved, and
     * the agent's permission to edit a note or module stays off where it was off (DESIGN §11,
     * §4.1a; @rp/shared/editing.ts).
     */
    const withoutGrants = (ref: RefRow, doc: Doc) =>
      Effect.map(lib.loadDoc(ref.head_revision_id), (ours) => {
        const next = withoutGrantedAgentEdits(ref.kind, ours, doc)
        return (ref.kind === "preset" || ref.kind === "card") &&
          next.regex_approved === true &&
          !keepsRegexApproval(ours, next)
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

    /** Merges `ref` with what it follows, if that needs no help from the user. */
    const applyMerge = (ref: RefRow) =>
      Effect.gen(function* () {
        const plan = yield* lib.planMerge(ref)
        switch (plan.outcome) {
          case "up_to_date":
            // What it follows moved on but brought nothing new, so only the merge base moves.
            if (ref.followed_head !== null && plan.theirsHead !== ref.merge_base_revision_id) {
              yield* moveHead(ref.id, ref.head_revision_id, plan.theirsHead)
            }
            break
          case "fast_forward": {
            // Moving to exactly what it follows would bring along a permission the user gave
            // there and not here: then it's a merge revision with the permission kept off.
            const doc = yield* withoutGrants(ref, plan.merged)
            if (docHash(doc) === docHash(plan.merged)) {
              yield* moveHead(ref.id, plan.theirsHead, plan.theirsHead)
              break
            }
            const merge = yield* insertRevision({
              entityId: ref.entity_id,
              schemaVersion: (yield* revision(ref.head_revision_id)).schema_version,
              doc: encode(doc),
              parents: [ref.head_revision_id, plan.theirsHead],
              origin: "merge",
              originRef: ref.follows_ref_id,
              message: mergeMessage(ref)
            })
            yield* moveHead(ref.id, merge, plan.theirsHead)
            return "merged" as MergeOutcome
          }
          case "merged": {
            const merge = yield* insertRevision({
              entityId: ref.entity_id,
              schemaVersion: (yield* revision(ref.head_revision_id)).schema_version,
              doc: encode(yield* withoutGrants(ref, plan.merged)),
              parents: [ref.head_revision_id, plan.theirsHead],
              origin: "merge",
              originRef: ref.follows_ref_id,
              message: mergeMessage(ref)
            })
            yield* moveHead(ref.id, merge, plan.theirsHead)
            break
          }
        }
        return plan.outcome
      })

    /** Non-card followers merge transitively. Cards only merge their own import line. */
    const flowToFollowers = (refId: string) =>
      Effect.gen(function* () {
        const outcomes: Array<FollowerMerge> = []
        if ((yield* reload(refId)).kind === "card") return outcomes
        const queue = [refId]
        while (queue.length > 0) {
          const followers = yield* lib.refsWhere("r.follows_ref_id = ?", [queue.shift()!])
          for (const follower of followers) {
            const outcome: MergeOutcome = yield* applyMerge(follower)
            outcomes.push(new FollowerMerge({ refId: follower.id as RefId, outcome }))
            // A follower that changed passes the change on to its own followers.
            if (outcome === "fast_forward" || outcome === "merged") queue.push(follower.id)
          }
        }
        return outcomes
      })

    const changed = (refId: string) =>
      Effect.gen(function* () {
        const followers = yield* flowToFollowers(refId)
        return new RefChange({ ref: toLibraryRef(yield* reload(refId)), followers })
      })

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
      readonly origin: "user" | "import"
      readonly originRef: string | null
      readonly sourcePath: string | null
      readonly sourceHash: string | null
      readonly createdAt?: number
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
          message: options.message ?? null
        })
        yield* sql`INSERT INTO entity_refs ${sql.insert({
          id: refId,
          entity_id: entityId,
          ref_kind: "upstream",
          head_revision_id: first,
          // An imported upstream has merged its import (see refSelect in library.ts).
          merge_base_revision_id: options.origin === "import" ? first : null,
          label: options.label,
          subtitle: options.subtitle,
          source_path: options.sourcePath,
          source_hash: options.sourceHash,
          created_at: at,
          updated_at: at
        })}`
        return yield* reload(refId)
      })

    /** A new import of an upstream ref, merged with the ref's own edits and passed on to its followers. */
    const importInto = (
      ref: RefRow,
      options: {
        readonly doc: EncodedDoc
        readonly schemaVersion: number
        readonly originRef: string | null
        readonly sourcePath: string | null
        readonly sourceHash: string | null
      }
    ) =>
      Effect.gen(function* () {
        if (ref.ref_kind !== "upstream") {
          return yield* new RefOperationRefused({ refId: ref.id, reason: "Only upstream refs take imports." })
        }
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
        const last = ref.followed_head === null ? null : yield* revision(ref.followed_head)
        if (last === null || last.doc_hash !== doc.hash) {
          yield* insertRevision({
            entityId: ref.entity_id,
            schemaVersion: options.schemaVersion,
            doc,
            parents: ref.followed_head === null ? [] : [ref.followed_head],
            origin: "import",
            originRef: options.originRef,
            message: null
          })
        }
        yield* sql`UPDATE entity_refs SET source_path = coalesce(${options.sourcePath}, source_path),
                   source_hash = coalesce(${options.sourceHash}, source_hash) WHERE id = ${ref.id}`
        return yield* mergeAndFlow(yield* reload(ref.id))
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
      StImportCharacterNote: ({ userId, cardEntityId, prompt, useChara, placement, scanLore, sourcePath }) =>
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
            sourcePath: `${sourcePath}#character_author_note`,
            sourceHash: null
          }
          const [existing] = yield* sql<{ id: string }>`
            SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
            JOIN entity_revisions h ON h.id = r.head_revision_id
            WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
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

      CreateEntity: ({ userId, kind, label, subtitle, doc, schemaVersion, origin, sourcePath }) =>
        createUpstream({
          userId,
          kind,
          label,
          subtitle,
          doc: encode(doc),
          schemaVersion,
          origin,
          originRef: sourcePath,
          sourcePath,
          sourceHash: null
        }).pipe(
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

      SetEntityArchived: ({ userId, entityId, archived }) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`
          UPDATE entities SET archived_at = ${archived ? Date.now() : null}
          WHERE id = ${entityId} AND owner_user_id = ${userId} AND deleted_at IS NULL RETURNING id`
          if (rows.length === 0) return yield* new NotFound({ entity: "entity", id: entityId })
        }).pipe(transaction(sql, "SetEntityArchived")),

      SetRefArchived: ({ userId, refId, archived }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.ref_kind === "chat_override")
            return yield* new RefOperationRefused({ refId, reason: "A chat's own copy can't be archived." })
          yield* sql`UPDATE entities
            SET archived_at = CASE WHEN ${archived ? 1 : 0} = 1 THEN coalesce(archived_at, ${Date.now()}) END
            WHERE id = ${ref.entity_id}`
          return toLibraryRef(yield* reload(refId))
        }).pipe(transaction(sql, "SetRefArchived")),

      EditRef: ({ userId, refId, doc, expectedRowVersion, message, commitDraft }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          yield* checkRowVersion(ref, expectedRowVersion)
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
            origin: "user",
            originRef: null,
            message
          })
          yield* moveHead(ref.id, edit, null)
          return yield* changed(ref.id)
        }).pipe(transaction(sql, "EditRef")),

      ForkRef: ({ userId, refId, label, subtitle }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.kind === "card")
            return yield* new RefOperationRefused({ refId, reason: "Cards use independent forks." })
          if (ref.ref_kind === "chat_override") {
            return yield* new RefOperationRefused({
              refId,
              reason: "A chat override can't be forked; promote it to a variant instead."
            })
          }
          const id = uuidv7()
          const at = Date.now()
          yield* sql`INSERT INTO entity_refs ${sql.insert({
            id,
            entity_id: ref.entity_id,
            ref_kind: "variant",
            head_revision_id: ref.head_revision_id,
            follows_ref_id: ref.id,
            merge_base_revision_id: ref.head_revision_id,
            label,
            subtitle,
            created_at: at,
            updated_at: at
          })}`
          return toLibraryRef(yield* reload(id))
        }).pipe(transaction(sql, "ForkRef")),

      CreateChatOverride: ({ userId, refId, chatId }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.kind === "card")
            return yield* new RefOperationRefused({ refId, reason: "Cards use independent forks." })
          if (ref.ref_kind === "chat_override") {
            return yield* new RefOperationRefused({ refId, reason: "This is already a chat override." })
          }
          yield* liveChat(userId, chatId)
          return toLibraryRef(yield* insertOverride(ref, chatId))
        }).pipe(transaction(sql, "CreateChatOverride")),

      PromoteOverride: ({ userId, refId, label, subtitle, expectedRowVersion }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.kind === "card")
            return yield* new RefOperationRefused({ refId, reason: "Cards use independent forks." })
          if (ref.ref_kind !== "chat_override") {
            return yield* new RefOperationRefused({ refId, reason: "Only chat overrides can be promoted." })
          }
          yield* checkRowVersion(ref, expectedRowVersion)
          const head = ref.head_revision_id
          yield* sql`UPDATE entity_refs SET head_revision_id = ${head}, ref_kind = 'variant', chat_id = NULL, label = ${label}, subtitle = ${subtitle},
                     row_version = row_version + 1, updated_at = ${Date.now()}
                   WHERE id = ${refId}`
          return toLibraryRef(yield* reload(refId))
        }).pipe(transaction(sql, "PromoteOverride")),

      MergeFollowed: ({ userId, refId }) =>
        Effect.flatMap(lib.ownedRef(userId, refId), mergeAndFlow).pipe(transaction(sql, "MergeFollowed")),

      ResolveMerge: ({ userId, refId, doc, theirsRevisionId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.followed_head === null) {
            return yield* new RefOperationRefused({
              refId,
              reason: "This ref follows nothing, so there's nothing to merge."
            })
          }
          yield* checkRowVersion(ref, expectedRowVersion)
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
            originRef: ref.follows_ref_id,
            message: `${mergeMessage(ref)}, resolved by hand`
          })
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
              if (assets.size > 0) card.asset_media_ids = Object.fromEntries(assets)
              doc = encode(card)
            }
          }
          const source: ImportSource = {
            originRef: JSON.stringify({ file: input.sourceName, sha256: input.sourceHash }),
            sourcePath: input.sourceName,
            sourceHash: input.sourceHash
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
            const merged = yield* importInto(into, { doc, schemaVersion: input.schemaVersion, ...source })
            upstream = yield* reload(into.id)
            outcome = merged.outcome
            followers = merged.change.followers
          }
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
      checkReferences
    }
    return { ...handlers, ...makeEditorWriteHandlers(steps), ...makeCardForkWriteHandlers(steps) }
  })
