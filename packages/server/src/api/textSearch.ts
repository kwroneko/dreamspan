// Text search across many things at once (TextSearchApi): message text in all of the user's
// chats (db/messageSearch.ts), and search and replace across the library, which the reader plans
// and the writer stores (db/libraryReplace.ts, db/libraryReplaceWrites.ts).
import { CurrentUser } from "@rp/shared/api.ts"
import { LIBRARY_EDITS_LISTED, libraryEditTitle } from "@rp/shared/libraryReplace.ts"
import { MESSAGE_PAGE } from "@rp/shared/messageSearch.ts"
import type { TextSearchApi } from "@rp/shared/textSearchApi.ts"
import { Effect } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeTextSearchHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    SearchMessages: ({ text, cursor }) =>
      Effect.flatMap(userId, (id) => reader.SearchMessages({ userId: id, text, cursor, limit: MESSAGE_PAGE })).pipe(
        internal("SearchMessages")
      ),
    PreviewLibraryReplace: ({ search }) =>
      Effect.flatMap(userId, (id) => reader.PreviewLibraryReplace({ userId: id, search })).pipe(
        internal("PreviewLibraryReplace")
      ),
    ApplyLibraryReplace: ({ search, choices }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const plan = yield* reader.PlanLibraryReplace({ userId: id, search, choices })
        const result = yield* writer.ApplyLibraryReplace({
          userId: id,
          title: libraryEditTitle(search),
          entries: plan.entries,
          skipped: plan.skipped
        })
        // What chats send may have changed: their cache estimates are worked out again.
        if (result.entries > 0) yield* warmth.refreshUser(id)
        return result
      }).pipe(internal("ApplyLibraryReplace")),
    ListLibraryEdits: () =>
      Effect.flatMap(userId, (id) => reader.ListLibraryEdits({ userId: id, limit: LIBRARY_EDITS_LISTED })).pipe(
        internal("ListLibraryEdits")
      ),
    UndoLibraryEdit: ({ editId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const result = yield* writer.UndoLibraryEdit({ userId: id, editId })
        if (result.undone > 0) yield* warmth.refreshUser(id)
        return result
      }).pipe(internal("UndoLibraryEdit"))
  } satisfies Parameters<typeof TextSearchApi.of>[0]
})
