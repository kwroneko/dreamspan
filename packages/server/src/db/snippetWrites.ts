import { newSharedNote } from "@rp/shared/editing.ts"
import type { WriteOps } from "./ops.ts"
import { NotFound, StaleWrite } from "./ops.ts"
import { Effect } from "effect"
import type { LibrarySteps } from "./editorWrites.ts"
import { readSnippet, snippetFork, snippetKey } from "./snippets.ts"
import { writeOverride } from "./forkState.ts"
import { type RefRow, toLibraryRef } from "./library.ts"
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import { transaction } from "./tx.ts"

export const makeSnippetWrites = (steps: LibrarySteps) => {
  const { sql, lib, drafts } = steps
  /** A new revision with the snippet's text: the head of a global one, this fork's binding otherwise. */
  const commit = Effect.fnUntraced(function* (
    ref: RefRow,
    current: Snippet,
    fork: string | null,
    chatId: string | null,
    fields: { readonly title: string; readonly content: string },
    message: string
  ) {
    const old = yield* lib.loadDoc(current.revision)
    const revision = yield* steps.insertRevision({
      entityId: ref.entity_id,
      schemaVersion: 1,
      doc: steps.encode({ ...old, ...fields }),
      parents: [current.revision],
      origin: "user",
      originRef: null,
      message
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
  })
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
        // An inherited snippet or an existing shared note has no draft here yet. Seed
        // it from the resolved revision before recording the first edit, so Undo can
        // recover that text after a reload, without sharing another fork's history.
        let draft =
          current.draft ??
          (yield* drafts.save({
            userId,
            key,
            draftId: null,
            content: current.content,
            base: null,
            baseRevision: current.revision,
            checkTarget: Effect.void
          }))
        if (draft.content !== current.content)
          draft = yield* drafts.restore(userId, key, draft.id, 0, draft.rowVersion, current.content)
        yield* drafts.save({
          userId,
          key,
          draftId: draft.id,
          content,
          base: { rowVersion: draft.rowVersion, session: draft.session },
          baseRevision: current.revision,
          checkTarget: Effect.void
        })
        yield* commit(ref, current, fork, chatId, { title, content }, "Snippet draft")
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
          // Promotion keeps this view's undo history with the now-global text.
          if (current.draft) yield* sql`UPDATE drafts SET field = '' WHERE id = ${current.draft.id}`
          yield* steps.changed(ref.id)
        }
        return (yield* readSnippet(sql, userId, yield* steps.reload(toLibraryRef(ref).id), chatId, fork))!
      }).pipe(transaction(sql, "MakeSnippetGlobal")),
    // The text history is the snippet draft's (DESIGN §6.2): restoring a state records it as a
    // restore there, then saves that text as a revision, like typing it would.
    RestoreSnippet: ({ userId, chatId, forkId, refId, seq, expectedRevision }) =>
      Effect.gen(function* () {
        const fork = yield* snippetFork(sql, userId, chatId, forkId)
        const ref = yield* lib.ownedRef(userId, refId)
        const current = yield* readSnippet(sql, userId, ref, chatId, fork)
        if (!current?.draft) return yield* new NotFound({ entity: "snippet", id: refId })
        if (current.revision !== expectedRevision)
          return yield* new StaleWrite({ entity: "snippet", id: refId, expected: 0, actual: 1 })
        const key = snippetKey(ref.id, current.global ? null : fork)
        // Preserve a revision changed in the other note editor before restoring snippet
        // history. A restore entry cannot coalesce away the state the user selected.
        const draft =
          current.draft.content === current.content
            ? current.draft
            : yield* drafts.restore(userId, key, current.draft.id, 0, current.draft.rowVersion, current.content)
        const restored = yield* drafts.restore(userId, key, draft.id, seq, draft.rowVersion)
        yield* commit(
          ref,
          current,
          fork,
          chatId,
          { title: current.title, content: restored.content },
          "Restored snippet text"
        )
        return (yield* readSnippet(sql, userId, yield* steps.reload(ref.id), chatId, fork))!
      }).pipe(transaction(sql, "RestoreSnippet"))
  } satisfies Pick<
    Parameters<typeof WriteOps.of>[0],
    "CreateSnippet" | "SaveSnippet" | "MakeSnippetGlobal" | "RestoreSnippet"
  >
  return handlers
}
