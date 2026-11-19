// Several messages at once (@dreamspan/shared/messageSelectionApi.ts): a multi-delete and its Undo. What
// follows each is what follows DeleteMessage and RestoreBinItem (api/chats.ts, api/bin.ts): the
// chat's tabs read it again, generations under what went stop, the cache estimate is refreshed.
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { MessageSelectionApi } from "@dreamspan/shared/messageSelectionApi.ts"
import type { BinItem } from "@dreamspan/shared/bin.ts"
import { NotFound, type ServerError } from "@dreamspan/shared/errors.ts"
import { Cause, Effect } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Reader, Writer } from "../db/Database.ts"
import { WorkshopFiles } from "../files/WorkshopFiles.ts"
import { BinContentGone } from "../files/bin.ts"
import { internal, toServerError } from "./internal.ts"

export const makeMessageSelectionHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const generations = yield* Generations
  const warmth = yield* CacheWarmth
  const files = yield* WorkshopFiles
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
        // Files and folders are on disk: the files host moves each back (as RestoreBinItem does);
        // the rest are restored together by the writer. The answer keeps the order asked.
        const kinds = yield* Effect.forEach(itemIds, (itemId) =>
          reader.FileBinItem({ userId: id, itemId }).pipe(
            Effect.as(true),
            Effect.catchTag("NotFound", () => Effect.succeed(false))
          )
        )
        const fileIds = itemIds.filter((_, i) => kinds[i])
        const otherIds = itemIds.filter((_, i) => !kinds[i])
        const restoredFiles = new Map<string, BinItem>()
        for (const itemId of fileIds) {
          const restored = yield* files.bin.restore(id, itemId).pipe(
            Effect.map((done) => {
              files.changed(id, [done.path])
              return done.item
            }),
            // Gone from disk or from the bin meanwhile: skipped, as the writer skips such items.
            Effect.catch((error: unknown): Effect.Effect<null, ServerError> =>
              error instanceof NotFound || (Cause.isUnknownError(error) && error.cause instanceof BinContentGone)
                ? Effect.succeed(null)
                : toServerError("RestoreBinItems")(error)
            )
          )
          if (restored) restoredFiles.set(itemId, restored)
        }
        const others =
          otherIds.length === 0
            ? []
            : yield* writer
                .RestoreBinItems({ userId: id, itemIds: otherIds })
                .pipe(
                  Effect.catchTag("NotFound", (error) =>
                    restoredFiles.size > 0 ? Effect.succeed([]) : Effect.fail(error)
                  )
                )
        if (others.length === 0 && restoredFiles.size === 0)
          return yield* new NotFound({ entity: "bin item", id: itemIds[0] ?? "" })
        const byId = new Map([...others.map((item) => [item.id, item] as const), ...restoredFiles])
        const items = itemIds.flatMap((itemId) => {
          const item = byId.get(itemId)
          return item ? [item] : []
        })
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
