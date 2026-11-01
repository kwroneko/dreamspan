import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { setFavourite } from "./cardFavourites.ts"
import { storeSummaries } from "./forkSummaries.ts"
import { forkAt } from "./forkState.ts"
import { onPath } from "./forks.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeShellWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetChatPin: ({ userId, chatId, leaf, pinned, forkId }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const fork = forkId ?? (yield* forkAt(sql, chatId, leaf))
        const [record] = yield* sql<{ tip_slot_id: string | null }>`SELECT tip_slot_id FROM forks
          WHERE id = ${fork} AND chat_id = ${chatId} AND deleted_at IS NULL`
        if (!record || (leaf !== null && !(yield* onPath(sql, chatId, record.tip_slot_id, leaf))))
          return yield* new NotFound({ entity: "fork", id: fork ?? "" })
        yield* sql`UPDATE forks SET pinned_at = ${pinned ? Date.now() : null}, row_version = row_version + 1
          WHERE id = ${fork} AND (pinned_at IS NOT NULL) <> ${pinned ? 1 : 0}`
      }).pipe(transaction(sql, "SetChatPin")),
    SetHomePinsCollapsed: ({ userId, collapsed }) =>
      sql`INSERT INTO shell_preferences(user_id, pins_collapsed) VALUES (${userId}, ${collapsed ? 1 : 0}) ON CONFLICT(user_id) DO UPDATE SET pins_collapsed = excluded.pins_collapsed`.pipe(
        Effect.asVoid,
        transaction(sql, "SetHomePinsCollapsed")
      ),
    // Favourites are the user's (db/cardFavourites.ts), of a live card of theirs.
    SetCardFavourite: ({ userId, entityId, favourite }) =>
      Effect.gen(function* () {
        const [card] = yield* sql`SELECT id FROM entities WHERE id = ${entityId} AND owner_user_id = ${userId}
          AND kind = 'card' AND deleted_at IS NULL AND purged_at IS NULL`
        if (!card) return yield* new NotFound({ entity: "card", id: entityId })
        yield* setFavourite(sql, userId, entityId, favourite)
      }).pipe(transaction(sql, "SetCardFavourite")),
    // What a ShellLibrary read computed (db/forkSummaries.ts), each chat's only if no write moved its stamps since.
    StoreForkSummaries: ({ userId, chats }) =>
      storeSummaries(sql, userId, chats).pipe(transaction(sql, "StoreForkSummaries"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
