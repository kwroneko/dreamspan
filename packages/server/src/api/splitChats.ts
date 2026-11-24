import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { CurrentUser } from "@dreamspan/shared/api.ts"
import { BinItem } from "@dreamspan/shared/bin.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"
import { notifyWorkshopDeletions } from "./bin.ts"
import type { SplitChatTitle } from "@dreamspan/shared/splitChat.ts"

export const makeSplitChatHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const generations = yield* Generations
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    DeleteChatGroup: (payload: { chatId: ChatId; forkId: ForkId; expectedForkIds: ReadonlyArray<ForkId> }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const view = yield* reader.GetSplitChats({ userId: id, chatId: payload.chatId, forkId: payload.forkId })
        const item = yield* writer.DeleteChatGroup({ userId: id, ...payload, title: view.group.title })
        yield* notifyWorkshopDeletions(id, item.workshops)
        yield* Effect.forEach(generations.runningIn(payload.chatId, payload.expectedForkIds), (versionId) =>
          Effect.ignore(generations.stop(id, versionId))
        )
        hub.publish(payload.chatId, { _tag: "Reload" })
        const chat = yield* reader.GetChat({ userId: id, chatId: payload.chatId })
        hub.publish(payload.chatId, { _tag: "Chat", chat })
        yield* warmth.refreshUser(id)
        const next = yield* reader
          .GetSplitChats({ userId: id, chatId: payload.chatId, forkId: view.parent?.forkId ?? chat.currentForkId })
          .pipe(
            Effect.catchTag("NotFound", () =>
              reader.GetSplitChats({ userId: id, chatId: payload.chatId, forkId: null })
            ),
            Effect.catchTag("NotFound", () => Effect.succeed(null))
          )
        return { item: new BinItem(item), next: next?.group ?? null }
      }).pipe(Effect.uninterruptible, internal("DeleteChatGroup")),
    GetSplitChats: (payload: { chatId: ChatId; forkId: ForkId | null }) =>
      Effect.flatMap(userId, (id) => reader.GetSplitChats({ userId: id, ...payload })).pipe(internal("GetSplitChats")),
    SetChatPicture: (payload: { chatId: ChatId; mediaId: string | null }) =>
      Effect.gen(function* () {
        const { chat, previous } = yield* writer.SetChatPicture({ ...payload, userId: yield* userId })
        // Other tabs' lists and headers read again.
        hub.publish(chat.id, { _tag: "Chat", chat })
        return { previous }
      }).pipe(internal("SetChatPicture")),
    SetSplitChat: (payload: { forkId: ForkId; split: boolean; title?: typeof SplitChatTitle.Type }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const chatId = yield* writer.SetSplitChat({ userId: id, ...payload })
        hub.publish(chatId, { _tag: "Reload" })
      }).pipe(Effect.uninterruptible, internal("SetSplitChat"))
  }
})
