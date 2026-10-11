// Library write handlers (DATA-MODEL §3.2). They run in the writer worker, each as one
// transaction. Every change to a ref flows on to the refs that follow it.
import type { EntityId } from "@rp/shared/chat.ts"
import type { Doc, MergeOutcome, RefId } from "@rp/shared/library.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { BinLimits } from "@rp/shared/bin.ts"
import { makeBin } from "./bin.ts"
import { makeDraftStore } from "./drafts.ts"
import { docHash, makeLibraryQueries, type RefRow, searchText, toLibraryRef } from "./library.ts"
import { FollowerMerge, NotFound, RefChange, RefOperationRefused, StaleWrite, WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeLibraryWriteHandlers = (binLimits: BinLimits) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    const drafts = makeDraftStore(sql, makeBin(sql, binLimits).recover)

    const insertRevision = (options: {
      readonly entityId: string
      readonly schemaVersion: number
      readonly doc: Doc
      readonly parents: ReadonlyArray<string>
      readonly origin: "import" | "user" | "merge"
      readonly originRef: string | null
      readonly message: string | null
    }) =>
      Effect.gen(function* () {
        const id = uuidv7()
        yield* sql`INSERT INTO entity_revisions ${sql.insert({
          id,
          entity_id: options.entityId,
          parents: JSON.stringify(options.parents),
          doc_json: JSON.stringify(options.doc),
          doc_hash: docHash(options.doc),
          schema_version: options.schemaVersion,
          origin: options.origin,
          origin_ref: options.originRef,
          message: options.message,
          search_text: searchText(options.doc),
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

    /**
     * Merges `ref` with what it follows, if that needs no help from the user. Documents
     * of different schema versions can't be merged, so they count as conflicts.
     */
    const applyMerge = (ref: RefRow) =>
      Effect.gen(function* () {
        const plan = yield* lib.planMerge(ref)
        switch (plan.outcome) {
          case "fast_forward":
            yield* moveHead(ref.id, plan.theirsHead, plan.theirsHead)
            break
          case "merged": {
            const merge = yield* insertRevision({
              entityId: ref.entity_id,
              schemaVersion: plan.schemaVersion!,
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
      }).pipe(Effect.catchTag("RefOperationRefused", () => Effect.succeed<MergeOutcome>("conflicts")))

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
            : new RefChange({ ref: toLibraryRef(ref), followers: [] })
        return { outcome, change }
      })

    const checkRowVersion = (ref: RefRow, expected: number) =>
      ref.row_version === expected
        ? Effect.void
        : Effect.fail(new StaleWrite({ entity: "ref", id: ref.id, expected, actual: ref.row_version }))

    const handlers = {
      CreateEntity: ({ userId, kind, label, subtitle, doc, schemaVersion, origin, sourcePath }) =>
        Effect.gen(function* () {
          const at = Date.now()
          const entityId = uuidv7()
          const refId = uuidv7()
          yield* sql`INSERT INTO entities ${sql.insert({ id: entityId, owner_user_id: userId, kind, created_at: at })}`
          const first = yield* insertRevision({
            entityId,
            schemaVersion,
            doc,
            parents: [],
            origin,
            originRef: sourcePath,
            message: null
          })
          yield* sql`INSERT INTO entity_refs ${sql.insert({
            id: refId,
            entity_id: entityId,
            ref_kind: "upstream",
            head_revision_id: first,
            // An imported upstream has merged its import (see refSelect in library.ts).
            merge_base_revision_id: origin === "import" ? first : null,
            label,
            subtitle,
            source_path: sourcePath,
            created_at: at,
            updated_at: at
          })}`
          return { entityId: entityId as EntityId, ref: toLibraryRef(yield* reload(refId)) }
        }).pipe(transaction(sql, "CreateEntity")),

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
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, refId)
          if (ref.ref_kind !== "upstream") {
            return yield* new RefOperationRefused({ refId, reason: "Only upstream refs take imports." })
          }
          // Imports form their own line of revisions, which the upstream ref merges in like
          // a variant merges its upstream, so the user's edits to the upstream survive.
          const last = ref.followed_head === null ? null : yield* revision(ref.followed_head)
          // Importing what was last imported adds nothing to that line.
          if (last === null || last.doc_hash !== docHash(doc) || last.schema_version !== schemaVersion) {
            yield* insertRevision({
              entityId: ref.entity_id,
              schemaVersion,
              doc,
              parents: ref.followed_head === null ? [] : [ref.followed_head],
              origin: "import",
              originRef: sourcePath,
              message: null
            })
          }
          yield* sql`UPDATE entity_refs SET source_path = coalesce(${sourcePath}, source_path),
                     source_hash = coalesce(${sourceHash}, source_hash) WHERE id = ${refId}`
          return yield* mergeAndFlow(yield* reload(refId))
        }).pipe(transaction(sql, "ImportUpstream")),

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
            schemaVersion: yield* lib.mergeSchemaVersion(ref, theirsRevisionId),
            doc,
            parents: [ref.head_revision_id, theirsRevisionId],
            origin: "merge",
            originRef: ref.follows_ref_id,
            message: `${mergeMessage(ref)}, resolved by hand`
          })
          yield* moveHead(ref.id, merge, theirsRevisionId)
          return yield* changed(ref.id)
        }).pipe(transaction(sql, "ResolveMerge"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
    return handlers
  })
