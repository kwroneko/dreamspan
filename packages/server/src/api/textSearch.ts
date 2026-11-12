// Text search across chats (TextSearchApi): the reader does the work (db/messageSearch.ts).
import { CurrentUser } from "@rp/shared/api.ts"
import { MESSAGE_PAGE } from "@rp/shared/messageSearch.ts"
import type { TextSearchApi } from "@rp/shared/textSearchApi.ts"
import { Effect } from "effect"
import { Reader } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeTextSearchHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    SearchMessages: ({ text, cursor }) =>
      Effect.flatMap(userId, (id) => reader.SearchMessages({ userId: id, text, cursor, limit: MESSAGE_PAGE })).pipe(
        internal("SearchMessages")
      )
  } satisfies Parameters<typeof TextSearchApi.of>[0]
})
