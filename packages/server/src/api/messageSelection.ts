// Several messages at once (@rp/shared/messageSelectionApi.ts): a multi-delete and its Undo. What
// follows each is what follows DeleteMessage and RestoreBinItem (api/chats.ts, api/bin.ts): the
// chat's tabs read it again, generations under what went stop, the cache estimate is refreshed.
import { CurrentUser } from "@rp/shared/api.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { MessageSelectionApi } from "@rp/shared/messageSelectionApi.ts"
import { Effect } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeMessageSelectionHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const generations = yield* Generations
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)

  /** The chat's tabs read it again and hear its new row. */
  const reload = (user: UserId, chatId: ChatId) =>
    Effect.gen(function* () {
      hub.publish(chatId, { _tag: "Reload" })
      hub.publish(chatId, { _tag: "State" })
      const chat = yield* reader.GetChat({ userId: user, chatId }).pipe(Effect.option)
      if (chat._tag === "Some") hub.publish(chatId, { _tag: "Chat", chat: chat.value })
    })

  return {
    // Uninterruptible, as DeleteMessage is: a caller going away can't skip what follows.
    DeleteMessages: ({ forkId, slotIds }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const items = yield* writer.DeleteMessages({ userId: id, forkId, slotIds })
        const chatId = items[0]!.origin.chatId as ChatId
        hub.publish(chatId, { _tag: "Reload" })
        yield* warmth.refreshUser(id)
        // As afterDelete (api/chats.ts): generations whose versions went to the bin stop.
        const running = generations.runningIn(chatId)
        const live = new Set(
          running.length === 0 ? [] : yield* reader.LiveVersions({ userId: id, versionIds: running })
        )
        yield* Effect.forEach(running, (versionId) =>
          live.has(versionId) ? Effect.void : Effect.ignore(generations.stop(id, versionId))
        )
        const chat = yield* reader.GetChat({ userId: id, chatId }).pipe(Effect.option)
        if (chat._tag === "Some") hub.publish(chatId, { _tag: "Chat", chat: chat.value })
        return items
      }).pipe(Effect.uninterruptible, internal("DeleteMessages")),

    // As SetMessageHidden (api/chats.ts): an edit that starts nothing. The chat's tabs read it
    // again and the cache estimate is refreshed.
    SetMessagesHidden: ({ forkId, slotIds, hidden }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const result = yield* writer.SetSlotsHidden({ userId: id, forkId, slotIds, hidden })
        if (result.changed.length > 0) {
          yield* reload(id, result.chatId)
          yield* warmth.refreshUser(id)
        }
        return { changed: result.changed }
      }).pipe(Effect.uninterruptible, internal("SetMessagesHidden")),

    RestoreBinItems: ({ itemIds }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const items = yield* writer.RestoreBinItems({ userId: id, itemIds })
        const chats = new Set(
          items.flatMap((item) =>
            item.kind === "message" || item.kind === "version" ? [item.origin.chatId as ChatId] : []
          )
        )
        for (const chatId of chats) yield* reload(id, chatId)
        yield* warmth.refreshUser(id)
        return items
      }).pipe(Effect.uninterruptible, internal("RestoreBinItems"))
  } satisfies Parameters<typeof MessageSelectionApi.of>[0]
})
