import { splitChatKey } from "./splitChats.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { setFavourite } from "./cardFavourites.ts"
import { storeSummaries } from "./forkSummaries.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"
import { cleanName } from "@rp/shared/chatName.ts"
import { EditRefused } from "@rp/shared/editorApi.ts"
import type { ChatId } from "@rp/shared/chat.ts"

export const makeShellWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetSplitChat: ({ userId, forkId, split, title }) =>
      Effect.gen(function* () {
        const [fork] = yield* sql<{
          id: string
          chat_id: ChatId
          name: string | null
          base_slot_id: string | null
        }>`SELECT f.id, f.chat_id, f.name, f.base_slot_id FROM forks f JOIN chats c ON c.id = f.chat_id
          WHERE f.id = ${forkId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
            AND f.deleted_at IS NULL AND f.parent_fork_id IS NOT NULL`
        if (!fork) return yield* new NotFound({ entity: "branch", id: forkId })
        if (title !== undefined) {
          const [marker] = yield* sql`SELECT 1 FROM user_settings
            WHERE user_id = ${userId} AND key = ${splitChatKey(forkId)} AND value_json = 'true'`
          if (fork.name !== title.expectedName || Boolean(marker) === split)
            return yield* new EditRefused({ message: "This branch changed since confirmation. No changes were made." })
          const name = cleanName(title.name) || null
          if (name !== fork.name) {
            yield* sql`UPDATE forks SET name = ${name}, name_user = 1, row_version = row_version + 1
              WHERE id = ${forkId}`
            yield* sql`UPDATE slots SET row_version = row_version + 1
              WHERE fork_id = ${forkId} AND parent_slot_id IS ${fork.base_slot_id}`
          }
        }
        if (split)
          yield* sql`INSERT INTO user_settings(user_id, key, value_json)
          VALUES (${userId}, ${splitChatKey(forkId)}, 'true') ON CONFLICT(user_id, key) DO NOTHING`
        else yield* sql`DELETE FROM user_settings WHERE user_id = ${userId} AND key = ${splitChatKey(forkId)}`
        return fork.chat_id
      }).pipe(transaction(sql, "SetSplitChat")),
    SetChatPin: ({ userId, chatId, pinned }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) {
          const [root] = yield* sql`SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
            JOIN user_settings m ON m.user_id = c.owner_user_id AND m.key = ${splitChatKey(chatId)} AND m.value_json = 'true'
            WHERE f.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
          if (!root) return yield* new NotFound({ entity: "chat", id: chatId })
          yield* sql`UPDATE forks SET pinned_at = ${pinned ? Date.now() : null}, row_version = row_version + 1 WHERE id = ${chatId}`
          return
        }
        if (pinned)
          yield* sql`INSERT INTO chat_pins (user_id, chat_id) VALUES (${userId}, ${chatId})
            ON CONFLICT(user_id, chat_id) DO NOTHING`
        else yield* sql`DELETE FROM chat_pins WHERE user_id = ${userId} AND chat_id = ${chatId}`
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
