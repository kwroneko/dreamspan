import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeShellWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetChatPin: ({ userId, chatId, leaf, pinned }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        // The stable fork id is its first divergent slot, not its moving tip.
        let fork = ""
        if (leaf !== null) {
          const [slot] =
            yield* sql`SELECT id FROM slots WHERE id = ${leaf} AND chat_id = ${chatId} AND deleted_at IS NULL`
          if (!slot) return yield* new NotFound({ entity: "slot", id: leaf })
          const path = yield* sql<{ id: string }>`WITH RECURSIVE path AS (
          SELECT * FROM slots WHERE id = ${leaf}
          UNION ALL SELECT s.* FROM slots s JOIN path p ON s.id = p.parent_slot_id
        ) SELECT p.id FROM path p WHERE EXISTS (
          SELECT 1 FROM slots s WHERE s.chat_id = ${chatId} AND s.parent_slot_id IS p.parent_slot_id
          AND s.id < p.id
        ) ORDER BY p.depth DESC LIMIT 1`
          fork = path[0]?.id ?? ""
        }
        if (pinned)
          yield* sql`INSERT OR IGNORE INTO chat_pins(user_id, chat_id, fork_id) VALUES (${userId}, ${chatId}, ${fork})`
        else yield* sql`DELETE FROM chat_pins WHERE user_id = ${userId} AND chat_id = ${chatId} AND fork_id = ${fork}`
      }).pipe(transaction(sql, "SetChatPin")),
    SetHomePinsCollapsed: ({ userId, collapsed }) =>
      sql`INSERT INTO shell_preferences(user_id, pins_collapsed) VALUES (${userId}, ${collapsed ? 1 : 0}) ON CONFLICT(user_id) DO UPDATE SET pins_collapsed = excluded.pins_collapsed`.pipe(
        Effect.asVoid,
        transaction(sql, "SetHomePinsCollapsed")
      )
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
