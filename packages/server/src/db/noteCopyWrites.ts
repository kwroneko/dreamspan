// "Also change it in …" (spec/THREADS.md §5.2, §16.1; TH3): a chat's own note as one branch has
// it at its latest message, bound in another branch of the chat at that one's latest message,
// as the user's explicit act. Nothing spreads by itself (DESIGN §4 [D] 2026-11-01): this is the
// one way a note's text goes from a thread to another. One writer transaction.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { EditRefused } from "@rp/shared/editorApi.ts"
import type { RevisionId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { makeLibraryQueries } from "./library.ts"
import { replacementConflict } from "./noteReplacementWrites.ts"
import { noteHere } from "./noteAt.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeNoteCopyWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lib = makeLibraryQueries(sql)
    const graph = makeGraphWrites(sql, bin.drafts)
    const handlers = {
      CopyNoteToBranch: ({ userId, chatId, noteRefId, fromForkId, toForkId }) =>
        Effect.gen(function* () {
          const ref = yield* lib.ownedRef(userId, noteRefId)
          const [target] = yield* sql<{ id: string }>`SELECT id FROM forks
            WHERE id = ${toForkId} AND chat_id = ${chatId} AND deleted_at IS NULL`
          if (!target || toForkId === fromForkId) return yield* new NotFound({ entity: "fork", id: toForkId })
          // noteHere checks the chat is the user's and the note is the chat's own.
          const here = yield* noteHere(sql, lib, userId, ref, { chatId, forkId: fromForkId, slotId: null })
          const there = yield* noteHere(sql, lib, userId, ref, { chatId, forkId: toForkId, slotId: null })
          const [same] = yield* sql<{ same: number }>`SELECT a.doc_hash = b.doc_hash AS same
            FROM entity_revisions a JOIN entity_revisions b ON b.id = ${there.ref.head_revision_id}
            WHERE a.id = ${here.ref.head_revision_id}`
          if (same?.same === 1) return false
          const conflict = yield* replacementConflict(
            sql,
            userId,
            ref.entity_id,
            here.doc,
            { chatId, forkId: toForkId, slotId: null },
            there.doc
          )
          if (conflict) return yield* new EditRefused({ message: conflict })
          // Keep the target's saved line in History. The copied revision is recorded as the
          // second parent; rebinding directly to it would hide the target's previous saves.
          // The source is an already validated revision of this same owned note.
          const revision = uuidv7()
          yield* sql`INSERT INTO entity_revisions
            (id, entity_id, parents, doc_json, doc_hash, schema_version, origin, origin_ref, message, search_text, created_at)
            SELECT ${revision}, entity_id, ${JSON.stringify([there.ref.head_revision_id, here.ref.head_revision_id])},
              doc_json, doc_hash, schema_version, 'user', NULL, 'Copied from another thread', search_text, ${Date.now()}
            FROM entity_revisions WHERE id = ${here.ref.head_revision_id} AND entity_id = ${ref.entity_id}`
          yield* graph.insertStateEvent(
            userId,
            chatId,
            there.tip as SlotId | null,
            null,
            null,
            {
              key: "note.binding",
              value: { note: ref.entity_id as EntityId, revision: revision as RevisionId }
            },
            toForkId
          )
          return true
        }).pipe(transaction(sql, "CopyNoteToBranch"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
    return handlers
  })
