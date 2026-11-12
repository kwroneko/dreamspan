// "Also change it in …" (spec/THREADS.md §5.2, §16.1; TH3): a chat's own note as one branch has
// it at its latest message, bound in another branch of the chat at that one's latest message,
// as the user's explicit act. Nothing spreads by itself (DESIGN §4 [D] 2026-11-01): this is the
// one way a note's text goes from a thread to another. One writer transaction.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import type { RevisionId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { makeLibraryQueries } from "./library.ts"
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
          // The same text there already: nothing to write.
          if (here.ref.head_revision_id === there.ref.head_revision_id) return false
          yield* graph.insertStateEvent(
            userId,
            chatId,
            there.tip as SlotId | null,
            null,
            null,
            {
              key: "note.binding",
              value: { note: ref.entity_id as EntityId, revision: here.ref.head_revision_id as RevisionId }
            },
            toForkId
          )
          return true
        }).pipe(transaction(sql, "CopyNoteToBranch"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
    return handlers
  })
