// Read handlers for chat setup, speakers and the send queue (DESIGN §2.1, §2.2). They run
// in the reader workers; every one touches only the acting user's rows.
import { CardForChat } from "@rp/shared/chatSetupApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { loadCards } from "./cards.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { chatQueue } from "./queueRows.ts"
import { query } from "./tx.ts"

export const makeChatSetupReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ListCards: ({ userId }) =>
      loadCards(sql, userId, null).pipe(
        Effect.map((cards) => cards.map(({ card }) => card)),
        query("ListCards")
      ),

    CastCards: ({ userId, entityIds }) =>
      loadCards(sql, userId, entityIds).pipe(
        Effect.map((cards) => cards.map(({ card }) => card)),
        query("CastCards")
      ),

    GetCardForChat: ({ userId, entityId }) =>
      Effect.gen(function* () {
        const [found] = yield* loadCards(sql, userId, [entityId])
        if (found === undefined || found.card.inBin) return yield* new NotFound({ entity: "card", id: entityId })
        const { card, greetings, description, personality, scenario } = found
        return new CardForChat({ card, greetings, description, personality, scenario })
      }).pipe(query("GetCardForChat")),

    ListQueued: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat?.n !== 1) return yield* new NotFound({ entity: "chat", id: chatId })
        return yield* chatQueue(sql, chatId)
      }).pipe(query("ListQueued"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
