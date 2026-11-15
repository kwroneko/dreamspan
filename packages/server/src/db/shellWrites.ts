import { putUserSetting } from "./settings.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { setFavourite } from "./cardFavourites.ts"
import { storeSummaries } from "./forkSummaries.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"
import { cleanName } from "@rp/shared/chatName.ts"
import { EditRefused } from "@rp/shared/editorApi.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { type ChatRow, toChat } from "./rows.ts"

/** What a browser shows as an image, as `/library/media` serves. */
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

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
          split_chat: number
        }>`SELECT f.id, f.chat_id, f.name, f.base_slot_id, f.split_chat FROM forks f JOIN chats c ON c.id = f.chat_id
          WHERE f.id = ${forkId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
            AND f.deleted_at IS NULL AND f.parent_fork_id IS NOT NULL`
        if (!fork) return yield* new NotFound({ entity: "branch", id: forkId })
        if (title !== undefined) {
          if (fork.name !== title.expectedName || Boolean(fork.split_chat) === split)
            return yield* new EditRefused({ message: "This branch changed since confirmation. No changes were made." })
          const name = cleanName(title.name) || null
          if (name !== fork.name) {
            yield* sql`UPDATE forks SET name = ${name}, name_user = 1, row_version = row_version + 1
              WHERE id = ${forkId}`
            yield* sql`UPDATE slots SET row_version = row_version + 1
              WHERE fork_id = ${forkId} AND parent_slot_id IS ${fork.base_slot_id}`
          }
        }
        yield* sql`UPDATE forks SET split_chat = ${split ? 1 : 0} WHERE id = ${forkId}`
        return fork.chat_id
      }).pipe(transaction(sql, "SetSplitChat")),
    SetChatPin: ({ userId, chatId, pinned }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) {
          const [root] = yield* sql`SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
            WHERE f.id = ${chatId} AND f.split_chat = 1 AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
          if (!root) return yield* new NotFound({ entity: "chat", id: chatId })
          yield* sql`UPDATE forks SET pinned_at = ${pinned ? Date.now() : null}, row_version = row_version + 1 WHERE id = ${chatId}`
          return
        }
        if (pinned)
          yield* sql`INSERT INTO chat_pins (user_id, chat_id) VALUES (${userId}, ${chatId})
            ON CONFLICT(user_id, chat_id) DO NOTHING`
        else yield* sql`DELETE FROM chat_pins WHERE user_id = ${userId} AND chat_id = ${chatId}`
      }).pipe(transaction(sql, "SetChatPin")),
    SetChatPicture: ({ userId, chatId, mediaId }) =>
      Effect.gen(function* () {
        if (mediaId !== null) {
          // Only an image the account already holds (an upload of theirs): never another account's file.
          const [held] = yield* sql<{ mime: string }>`SELECT m.mime FROM media_assets m
            JOIN media_refs r ON r.media_id = m.id AND r.owner_user_id = ${userId} WHERE m.id = ${mediaId}`
          if (!held || !PICTURE_TYPES.has(held.mime)) return yield* new NotFound({ entity: "media", id: mediaId })
        }
        const [chat] = yield* sql<{ id: string; cover_media_id: string | null }>`SELECT id, cover_media_id FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        let physical = chatId as string
        let previous = chat?.cover_media_id ?? null
        if (chat) yield* sql`UPDATE chats SET cover_media_id = ${mediaId} WHERE id = ${chatId}`
        else {
          // A chat split off from another is named by its first branch, and keeps its picture there.
          const [root] = yield* sql<{ chat_id: string; cover_media_id: string | null }>`
            SELECT f.chat_id, f.cover_media_id FROM forks f JOIN chats c ON c.id = f.chat_id
            WHERE f.id = ${chatId} AND f.split_chat = 1 AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
              AND f.deleted_at IS NULL`
          if (!root) return yield* new NotFound({ entity: "chat", id: chatId })
          physical = root.chat_id
          previous = root.cover_media_id
          yield* sql`UPDATE forks SET cover_media_id = ${mediaId}, row_version = row_version + 1 WHERE id = ${chatId}`
        }
        // Open tabs follow the chat's row version.
        const [row] =
          yield* sql<ChatRow>`UPDATE chats SET row_version = row_version + 1 WHERE id = ${physical} RETURNING *`
        return { chat: toChat(row!), previous }
      }).pipe(transaction(sql, "SetChatPicture")),
    SetHomePinsCollapsed: ({ userId, collapsed }) =>
      putUserSetting(sql, userId, "shell.pinsCollapsed", collapsed).pipe(
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
