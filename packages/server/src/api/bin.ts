// Recycle bin RPC handlers (@rp/shared/binApi.ts). Every handler acts as the authenticated
// user; storage enforces ownership, so another user's items are NotFound. Restoring
// something inside a chat tells its open tabs to read it again.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeBinHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const warmth = yield* CacheWarmth

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const handlers = {
    ListBin: ({ limit, before }) =>
      Effect.flatMap(userId, (id) => reader.ListBin({ userId: id, limit, before })).pipe(internal("ListBin")),

    // Uninterruptible, so a caller going away can't skip telling the chat's tabs.
    RestoreBinItem: ({ itemId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.RestoreBinItem({ userId: id, itemId })
        if (item.kind === "message" || item.kind === "branch" || item.kind === "version") {
          const chatId = item.origin.chatId as ChatId
          // Messages and their state are back, and the leaf may have moved back down.
          hub.publish(chatId, { _tag: "Reload" })
          hub.publish(chatId, { _tag: "State" })
          const chat = yield* reader.GetChat({ userId: id, chatId }).pipe(Effect.option)
          if (chat._tag === "Some") hub.publish(chatId, { _tag: "Chat", chat: chat.value })
        }
        yield* warmth.refreshUser(id)
        return item
      }).pipe(Effect.uninterruptible, internal("RestoreBinItem")),

    PurgeBinItem: ({ itemId }) =>
      Effect.flatMap(userId, (id) =>
        writer.PurgeBinItem({ userId: id, itemId }).pipe(Effect.tap(() => warmth.refreshUser(id)))
      ).pipe(internal("PurgeBinItem")),

    EmptyBin: ({ itemIds }) =>
      Effect.flatMap(userId, (id) =>
        writer.EmptyBin({ userId: id, itemIds }).pipe(Effect.tap(() => warmth.refreshUser(id)))
      ).pipe(internal("EmptyBin")),

    ListRecoveredTexts: ({ limit, before }) =>
      Effect.flatMap(userId, (id) => reader.ListRecoveredTexts({ userId: id, source: null, limit, before })).pipe(
        internal("ListRecoveredTexts")
      ),

    GetRecoveredText: ({ id: textId }) =>
      Effect.flatMap(userId, (id) => reader.GetRecoveredText({ userId: id, id: textId })).pipe(
        internal("GetRecoveredText")
      ),

    DeleteRecoveredText: ({ id: textId }) =>
      Effect.flatMap(userId, (id) => writer.DeleteRecoveredText({ userId: id, id: textId })).pipe(
        internal("DeleteRecoveredText")
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
