import { Effect } from "effect"
import { SqlClient } from "effect/sql"
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
      )
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
