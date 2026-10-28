import { newSharedNote } from "@rp/shared/editing.ts"
import type { WriteOps } from "./ops.ts"
import { NotFound, StaleWrite } from "./ops.ts"
import { Effect } from "effect"
import type { LibrarySteps } from "./editorWrites.ts"
import { readSnippet, snippetFork, snippetKey } from "./snippets.ts"
import { writeOverride } from "./forkState.ts"
import { toLibraryRef } from "./library.ts"
import { transaction } from "./tx.ts"

export const makeSnippetWrites = (steps: LibrarySteps) => {
  const { sql, lib, drafts } = steps
  const handlers = {
    CreateSnippet: ({ userId, chatId, forkId, title, content }) =>
      Effect.gen(function* () {
        const fork = yield* snippetFork(sql, userId, chatId, forkId)
        const doc = {
          ...newSharedNote(title.trim() || "Untitled snippet", content),
          owner: { shared: chatId ?? "global" }
        }
        const ref = yield* steps.createUpstream({
          userId,
          kind: "note",
          label: doc.title,
          subtitle: "",
          doc: steps.encode(doc),
          schemaVersion: 1,
          origin: "user",
          originRef: null,
          sourcePath: null,
          sourceHash: null
        })
        yield* drafts.save({
          userId,
          key: snippetKey(ref.id, fork),
          draftId: null,
          content,
          base: null,
          baseRevision: ref.head_revision_id,
          checkTarget: Effect.void
        })
        if (fork !== null && chatId !== null)
          yield* writeOverride(
            sql,
            { id: fork, chatId },
            {
              kind: "snippet_revision",
              targetId: ref.entity_id,
              slotId: null,
              valueId: ref.head_revision_id,
              flag: null
            }
          )
        return (yield* readSnippet(sql, userId, ref, chatId, fork))!
      }).pipe(transaction(sql, "CreateSnippet")),
    SaveSnippet: ({ userId, chatId, forkId, refId, title, content, expectedRevision }) =>
      Effect.gen(function* () {
        const fork = yield* snippetFork(sql, userId, chatId, forkId)
        const ref = yield* lib.ownedRef(userId, refId)
        const current = yield* readSnippet(sql, userId, ref, chatId, fork)
        if (!current) return yield* new NotFound({ entity: "snippet", id: refId })
        if (current.revision !== expectedRevision)
          return yield* new StaleWrite({ entity: "snippet", id: refId, expected: 0, actual: 1 })
        const key = snippetKey(ref.id, current.global ? null : fork)
        yield* drafts.save({
          userId,
          key,
          draftId: current.draft?.id ?? null,
          content,
          base: current.draft ? { rowVersion: current.draft.rowVersion, session: current.draft.session } : null,
          baseRevision: current.revision,
          checkTarget: Effect.void
        })
        const old = yield* lib.loadDoc(current.revision)
        const encoded = steps.encode({ ...old, title, content })
        const revision = yield* steps.insertRevision({
          entityId: ref.entity_id,
          schemaVersion: 1,
          doc: encoded,
          parents: [current.revision],
          origin: "user",
          originRef: null,
          message: "Snippet draft"
        })
        if (current.global) {
          yield* steps.moveHead(ref.id, revision, null)
          yield* steps.changed(ref.id)
        } else
          yield* writeOverride(
            sql,
            { id: fork!, chatId: chatId! },
            { kind: "snippet_revision", targetId: ref.entity_id, slotId: null, valueId: revision, flag: null }
          )
        return (yield* readSnippet(sql, userId, yield* steps.reload(ref.id), chatId, fork))!
      }).pipe(transaction(sql, "SaveSnippet")),
    MakeSnippetGlobal: ({ userId, chatId, forkId, refId, expectedRevision }) =>
      Effect.gen(function* () {
        const fork = yield* snippetFork(sql, userId, chatId, forkId)
        const ref = yield* lib.ownedRef(userId, refId)
        const current = yield* readSnippet(sql, userId, ref, chatId, fork)
        if (!current) return yield* new NotFound({ entity: "snippet", id: refId })
        if (current.revision !== expectedRevision)
          return yield* new StaleWrite({ entity: "snippet", id: refId, expected: 0, actual: 1 })
        if (!current.global) {
          const doc = yield* lib.loadDoc(current.revision)
          const revision = yield* steps.insertRevision({
            entityId: ref.entity_id,
            schemaVersion: 1,
            doc: steps.encode({ ...doc, owner: { shared: "global" } }),
            parents: [current.revision],
            origin: "user",
            originRef: null,
            message: "Made snippet global"
          })
          yield* steps.moveHead(ref.id, revision, null)
          yield* steps.changed(ref.id)
        }
        return (yield* readSnippet(sql, userId, yield* steps.reload(toLibraryRef(ref).id), chatId, fork))!
      }).pipe(transaction(sql, "MakeSnippetGlobal"))
  } satisfies Pick<Parameters<typeof WriteOps.of>[0], "CreateSnippet" | "SaveSnippet" | "MakeSnippetGlobal">
  return handlers
}
