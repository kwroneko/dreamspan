// Library write handlers (DATA-MODEL §3.2). They run in the writer worker, each as one
// transaction. Every change to a ref flows on to the refs that follow it.
import type { EntityId } from "@rp/shared/chat.ts"
import { NOTE_SCHEMA_VERSION } from "@rp/shared/docs/note.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, EntityKind, MergeOutcome, RefId } from "@rp/shared/library.ts"
import { ImportedFollower, LibraryImport } from "@rp/shared/libraryImport.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { docHash, searchText } from "./documents.ts"
import { makeLibraryQueries, type RefRow, toLibraryRef } from "./library.ts"
import { mediaPath } from "./media.ts"
import { FollowerMerge, NotFound, RefChange, RefOperationRefused, StaleWrite, WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

/** Where an imported revision came from: the file's name and hash. */
interface ImportSource {
  readonly originRef: string
  readonly sourcePath: string
  readonly sourceHash: string
}

/** A document as stored, its hash and search text already worked out (in a format worker). */
class EncodedDoc {
  readonly json: string
  readonly hash: string
  readonly searchText: string
  constructor(json: string, hash: string, searchText: string) {
    this.json = json
    this.hash = hash
    this.searchText = searchText
  }
}

const encode = (doc: Doc | EncodedDoc) =>
  doc instanceof EncodedDoc ? doc : new EncodedDoc(JSON.stringify(doc), docHash(doc), searchText(doc))

export const makeLibraryWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    const { drafts } = bin

    const insertRevision = (options: {
      readonly entityId: string
      readonly schemaVersion: number
      readonly doc: Doc | EncodedDoc
      readonly parents: ReadonlyArray<string>
      readonly origin: "import" | "user" | "merge"
      readonly originRef: string | null
      readonly message: string | null
    }) =>
      Effect.gen(function* () {
        const id = uuidv7()
        const doc = encode(options.doc)
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
          case "fast_forward":
            yield* moveHead(ref.id, plan.theirsHead, plan.theirsHead)
            break
          case "merged": {
            const merge = yield* insertRevision({
              entityId: ref.entity_id,
              schemaVersion: (yield* revision(ref.head_revision_id)).schema_version,
              doc: plan.merged,
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

    /** Merges every ref that follows `refId`, transitively, and reports each outcome. */
    const flowToFollowers = (refId: string) =>
      Effect.gen(function* () {
        const outcomes: Array<FollowerMerge> = []
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
      readonly doc: Doc | EncodedDoc
      readonly schemaVersion: number
      readonly origin: "user" | "import"
      readonly originRef: string | null
      readonly sourcePath: string | null
      readonly sourceHash: string | null
    }) =>
      Effect.gen(function* () {
        const at = Date.now()
        const entityId = uuidv7()
        const refId = uuidv7()
        yield* sql`INSERT INTO entities ${sql.insert({ id: entityId, owner_user_id: options.userId, kind: options.kind, created_at: at })}`
        const first = yield* insertRevision({
          entityId,
          schemaVersion: options.schemaVersion,
          doc: options.doc,
          parents: [],
          origin: options.origin,
          originRef: options.originRef,
          message: null
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
        readonly doc: Doc | EncodedDoc
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
        const doc = encode(options.doc)
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
          yield* importInto(existing, { doc, schemaVersion: NOTE_SCHEMA_VERSION, ...source })
          return yield* reload(existing.id)
        }
        return yield* createUpstream({
          userId,
          kind: "note",
          label: "Character's Note",
          subtitle: "",
          doc,
          schemaVersion: NOTE_SCHEMA_VERSION,
          origin: "import",
          ...source
        })
      })

    const handlers = {
      CreateEntity: ({ userId, kind, label, subtitle, doc, schemaVersion, origin, sourcePath }) =>
        createUpstream({
          userId,
          kind,
          label,
          subtitle,
          doc,
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

      EditRef: ({ userId, refId, doc, expectedRowVersion, message, commitDraft }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          yield* checkRowVersion(ref, expectedRowVersion)
          yield* drafts.commit(userId, commitDraft)
          // An edit that changes nothing creates no revision.
          const current = yield* revision(ref.head_revision_id)
          if (current.doc_hash === docHash(doc)) return new RefChange({ ref: toLibraryRef(ref), followers: [] })
          const edit = yield* insertRevision({
            entityId: ref.entity_id,
            schemaVersion: current.schema_version,
            doc,
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
          if (ref.ref_kind === "chat_override") {
            return yield* new RefOperationRefused({ refId, reason: "This is already a chat override." })
          }
          const [chat] = yield* sql<{
            id: string
          }>`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
          if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
          const id = uuidv7()
          const at = Date.now()
          yield* sql`INSERT INTO entity_refs ${sql.insert({
            id,
            entity_id: ref.entity_id,
            ref_kind: "chat_override",
            head_revision_id: ref.head_revision_id,
            follows_ref_id: ref.id,
            merge_base_revision_id: ref.head_revision_id,
            label: ref.label,
            subtitle: "",
            chat_id: chatId,
            created_at: at,
            updated_at: at
          })}`
          return toLibraryRef(yield* reload(id))
        }).pipe(transaction(sql, "CreateChatOverride")),

      PromoteOverride: ({ userId, refId, label, subtitle, expectedRowVersion }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.ref_kind !== "chat_override") {
            return yield* new RefOperationRefused({ refId, reason: "Only chat overrides can be promoted." })
          }
          yield* checkRowVersion(ref, expectedRowVersion)
          yield* sql`UPDATE entity_refs SET ref_kind = 'variant', chat_id = NULL, label = ${label}, subtitle = ${subtitle},
                     row_version = row_version + 1, updated_at = ${Date.now()}
                   WHERE id = ${refId}`
          return toLibraryRef(yield* reload(refId))
        }).pipe(transaction(sql, "PromoteOverride")),

      ImportUpstream: ({ userId, refId, doc, schemaVersion, sourcePath, sourceHash }) =>
        Effect.flatMap(lib.ownedRef(userId, refId), (ref) =>
          importInto(ref, { doc, schemaVersion, originRef: sourcePath, sourcePath, sourceHash })
        ).pipe(transaction(sql, "ImportUpstream")),

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
          const merge = yield* insertRevision({
            entityId: ref.entity_id,
            schemaVersion: (yield* revision(ref.head_revision_id)).schema_version,
            doc,
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
          // A new version without an avatar (a JSON card) keeps the card's current one, which
          // would otherwise be dropped as the new import's change.
          const current =
            kind === "card" && into !== null && !input.media.some((file) => file.role === "avatar")
              ? (yield* lib.loadDoc(into.head_revision_id)).avatar_media_id
              : null
          const keptAvatar = typeof current === "string" ? current : null
          // Stored as the format worker encoded it, unless a card's media change it.
          let doc: Doc | EncodedDoc = new EncodedDoc(input.docJson, input.docHash, input.searchText)
          if (kind === "card" && (input.media.length > 0 || keptAvatar !== null)) {
            const card = JSON.parse(input.docJson) as Record<string, unknown>
            const assets: Array<[string, string]> = []
            card.avatar_media_id = keptAvatar
            for (const file of input.media) {
              const id = yield* recordMedia(userId, file)
              if (file.role === "avatar") card.avatar_media_id = id
              else assets.push([file.uri, id])
            }
            // fromEntries, since a URI comes from the file and could be "__proto__".
            if (assets.length > 0) card.asset_media_ids = Object.fromEntries(assets)
            doc = card
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
          const note =
            input.noteDocJson === null ? null : yield* importNote(userId, upstream.entity_id, input.noteDocJson, source)
          return new LibraryImport({
            created: intoRefId === null,
            ref: toLibraryRef(upstream),
            outcome,
            followers: yield* Effect.forEach(followers, ({ refId, outcome }) =>
              Effect.map(reload(refId), (ref) => new ImportedFollower({ refId, label: ref.label, outcome }))
            ),
            note: note && toLibraryRef(note),
            keptAvatar: keptAvatar !== null
          })
        }).pipe(transaction(sql, "ImportFile"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
    return handlers
  })
