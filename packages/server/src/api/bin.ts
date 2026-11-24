// Recycle bin RPC handlers (@dreamspan/shared/binApi.ts). Every handler acts as the authenticated
// user; storage enforces ownership, so another user's items are NotFound. Restoring
// something inside a chat tells its open tabs to read it again.
import { type AppApi, CurrentUser } from "@dreamspan/shared/api.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { NotFound, type ServerError } from "@dreamspan/shared/errors.ts"
import { Cause, Effect } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { DeletedChatItem } from "../db/ops.ts"
import { WorkshopFiles } from "../files/WorkshopFiles.ts"
import { BinContentGone } from "../files/bin.ts"
import { internal, toServerError } from "./internal.ts"

/** Finish live sessions affected by the writer's workshop companion deletions. */
export const notifyWorkshopDeletions = (userId: UserId, workshops: DeletedChatItem["workshops"]) =>
  Effect.gen(function* () {
    const generations = yield* Generations
    const hub = yield* ChatHub
    const reader = yield* Reader
    for (const { chatId, forkIds } of workshops) {
      yield* Effect.forEach(generations.runningIn(chatId, forkIds ?? undefined), (versionId) =>
        Effect.ignore(generations.stop(userId, versionId))
      )
      if (forkIds === null) hub.close(chatId, { _tag: "Deleted" }, userId)
      else {
        hub.publish(chatId, { _tag: "Reload" })
        const chat = yield* reader.GetChat({ userId, chatId }).pipe(Effect.option)
        if (chat._tag === "Some") hub.publish(chatId, { _tag: "Chat", chat: chat.value })
      }
    }
  })

export const makeBinHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const warmth = yield* CacheWarmth
  const files = yield* WorkshopFiles

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const afterPurge = (id: UserId, chatIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const chatId of chatIds) {
        const chat = yield* reader.GetChat({ userId: id, chatId: chatId as ChatId }).pipe(Effect.option)
        if (chat._tag === "Some") {
          hub.publish(chatId as ChatId, { _tag: "Reload" })
          hub.publish(chatId as ChatId, { _tag: "State" })
          hub.publish(chatId as ChatId, { _tag: "Chat", chat: chat.value })
        } else hub.close(chatId as ChatId, { _tag: "Deleted" }, id)
      }
      yield* warmth.refreshUser(id)
    })

  /**
   * Attachment copies (files/routes.ts `attach`) that no message names once the purge is done
   * go, and the Files usage is measured again when any did, so the room shows as free.
   */
  const dropAttachmentCopies = (id: UserId) =>
    writer.PruneFileVersions({ userId: id, before: 0, limit: 1 }).pipe(
      Effect.flatMap((done) => (done.attachments > 0 ? Effect.asVoid(files.quota.measure(id)) : Effect.void)),
      Effect.catchCause((cause) => Effect.logWarning("dropping unused attachment copies failed", cause))
    )

  const handlers = {
    GetBinLimits: () =>
      Effect.flatMap(userId, (id) => reader.GetBinLimits({ userId: id })).pipe(internal("GetBinLimits")),
    ChangeBinLimit: (change) =>
      Effect.flatMap(userId, (id) => writer.ChangeBinLimit({ userId: id, ...change })).pipe(internal("ChangeBinLimit")),
    ListBin: ({ limit, before }) =>
      Effect.flatMap(userId, (id) => reader.ListBin({ userId: id, limit, before })).pipe(internal("ListBin")),

    BinItemForks: ({ itemIds }) =>
      Effect.flatMap(userId, (id) => reader.BinItemForks({ userId: id, itemIds })).pipe(internal("BinItemForks")),
    BinItemBranches: ({ itemIds }) =>
      Effect.flatMap(userId, (id) => reader.BinItemBranches({ userId: id, itemIds })).pipe(internal("BinItemBranches")),

    // Uninterruptible, so a caller going away can't skip telling the chat's tabs.
    RestoreBinItem: ({ itemId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // A file or folder is on disk: the files host moves it back and forgets the row.
        const file = yield* reader.FileBinItem({ userId: id, itemId }).pipe(Effect.option)
        if (file._tag === "Some")
          return yield* files.bin.restore(id, itemId).pipe(
            Effect.map((restored) => {
              files.changed(id, [restored.path])
              return restored.item
            }),
            // Its content gone from disk (the row went with it), or the row already gone: not found.
            Effect.catch((error: unknown): Effect.Effect<never, NotFound | ServerError> =>
              error instanceof NotFound || (Cause.isUnknownError(error) && error.cause instanceof BinContentGone)
                ? Effect.fail(new NotFound({ entity: "bin item", id: itemId }))
                : toServerError("RestoreBinItem")(error)
            )
          )
        const item = yield* writer.RestoreBinItem({ userId: id, itemId })
        if (item.kind === "message" || item.kind === "branch" || item.kind === "threads" || item.kind === "version") {
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

    PurgeBinItem: ({ itemId, expectedForkIds }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const chatIds = yield* files.bin.serial(
          id,
          writer.PurgeBinItem({
            userId: id,
            itemId,
            ...(expectedForkIds ? { expectedForkIds } : {})
          })
        )
        yield* afterPurge(id, chatIds)
        // A file's content goes from disk once its row has, and attachment copies no message names any more.
        yield* files.bin.sweep(id)
        yield* dropAttachmentCopies(id)
      }).pipe(Effect.uninterruptible, internal("PurgeBinItem")),

    EmptyBin: ({ itemIds, expectedForkIds }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const result = yield* files.bin.serial(
          id,
          writer.EmptyBin({ userId: id, itemIds, ...(expectedForkIds ? { expectedForkIds } : {}) })
        )
        yield* afterPurge(id, result.chatIds)
        yield* files.bin.sweep(id)
        yield* dropAttachmentCopies(id)
        return { purged: result.purged }
      }).pipe(Effect.uninterruptible, internal("EmptyBin")),

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
