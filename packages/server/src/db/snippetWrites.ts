// Snippets' writes: making one, and moving it between "This chat" and "All chats". Its text is
// edited as any library field is (drafts, `CommitEditorDrafts`), not here.
import { newSharedNote } from "@dreamspan/shared/editing.ts"
import type { WriteOps } from "./ops.ts"
import { NotFound, RefOperationRefused } from "./ops.ts"
import { Effect } from "effect"
import type { LibrarySteps } from "./editorWrites.ts"
import { chatFork, readSnippet } from "./snippets.ts"
import { transaction } from "./tx.ts"

export const makeSnippetWrites = (steps: LibrarySteps) => {
  const { sql, lib } = steps
  /**
   * Whether a note outside `chatId` shows the shared note: a card's note (in every chat with the
   * card), another chat's own note, or another chat's binding of one that links to it.
   */
  const shownOutside = (userId: string, entityId: string, chatId: string) =>
    sql<{ one: number }>`
      SELECT 1 AS one FROM entities e JOIN entity_refs r ON r.entity_id = e.id
      JOIN entity_revisions h ON h.id = r.head_revision_id
      WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
        AND json_extract(h.doc_json, '$.link') = ${entityId}
        AND coalesce(json_extract(h.doc_json, '$.owner.chat'), '') <> ${chatId}
      UNION ALL
      SELECT 1 FROM state_events ev JOIN entity_revisions b ON b.id = json_extract(ev.value_json, '$.revision')
      JOIN chats c ON c.id = ev.chat_id AND c.deleted_at IS NULL AND c.owner_user_id = ${userId}
      WHERE ev.key = 'note.binding' AND ev.chat_id <> ${chatId} AND ev.superseded_by_changeset IS NULL
        AND json_extract(b.doc_json, '$.link') = ${entityId}
      LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0))

  const handlers = {
    CreateSnippet: ({ userId, chatId, title, content }) =>
      Effect.gen(function* () {
        yield* chatFork(sql, userId, chatId, null)
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
        return (yield* readSnippet(sql, userId, ref, chatId))!
      }).pipe(transaction(sql, "CreateSnippet")),

    SetSnippetScope: ({ userId, chatId, refId, global }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        const current = yield* readSnippet(sql, userId, ref, chatId)
        if (!current) return yield* new NotFound({ entity: "snippet", id: refId })
        if (current.global !== global) {
          if (!global) {
            if (chatId === null)
              return yield* new RefOperationRefused({ refId, reason: "Only a chat can have a snippet of its own." })
            yield* chatFork(sql, userId, chatId, null)
            if (yield* shownOutside(userId, ref.entity_id, chatId))
              return yield* new RefOperationRefused({
                refId,
                reason:
                  "A card's note or another chat's note shows it, so it stays in all chats. Unlink those notes first."
              })
          }
          const head = yield* lib.loadDoc(ref.head_revision_id)
          yield* steps
            .insertRevision({
              entityId: ref.entity_id,
              schemaVersion: 1,
              doc: steps.encode({ ...head, owner: { shared: global ? "global" : chatId! } }),
              parents: [ref.head_revision_id],
              origin: "user",
              originRef: null,
              message: global ? "Now in all chats" : "Now only in its chat"
            })
            .pipe(Effect.tap((revision) => steps.moveHead(ref.id, revision, null)))
          yield* steps.changed(ref.id)
        }
        return (yield* readSnippet(sql, userId, yield* steps.reload(ref.id), chatId))!
      }).pipe(transaction(sql, "SetSnippetScope"))
  } satisfies Pick<Parameters<typeof WriteOps.of>[0], "CreateSnippet" | "SetSnippetScope">
  return handlers
}
