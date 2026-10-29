// The composer's drafts (@rp/shared/composerApi.ts): one per fork of a chat, on the
// draft store every text field shares (ARCHITECTURE §3.10). A closing page sends its unsaved
// text to POST /library/drafts with the editors' (importer/routes.ts).
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { TextTooLong } from "@rp/shared/composerApi.ts"
import { composerKey } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeComposerHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const handlers = {
    // Only for a live chat of the caller's: a draft is never more than its chat. A composer
    // already there is read in a reader; only a new one, or a copy, takes the writer.
    OpenComposer: ({ chatId, forkId, copyFrom }) =>
      Effect.gen(function* () {
        const id = yield* userId
        if (copyFrom === undefined) {
          const chat = yield* reader.GetChat({ userId: id, chatId })
          const there = yield* reader.GetDraft({ userId: id, key: composerKey(chatId, forkId ?? chat.currentForkId) })
          if (there !== null) return there
        }
        return yield* writer.OpenComposer({ userId: id, chatId, forkId, copyFrom: copyFrom ?? null })
      }).pipe(internal("OpenComposer")),

    SaveComposer: (payload) =>
      Effect.flatMap(userId, (id) => writer.SaveComposer({ userId: id, ...payload })).pipe(
        Effect.catchTag("DraftTooLarge", ({ length, max }) => Effect.fail(new TextTooLong({ length, max }))),
        internal("SaveComposer")
      ),

    ComposerHistory: ({ chatId, draftId, limit }) =>
      Effect.flatMap(userId, (id) => reader.ComposerHistory({ userId: id, chatId, draftId, limit })).pipe(
        internal("ComposerHistory")
      ),

    RestoreComposer: (payload) =>
      Effect.flatMap(userId, (id) => writer.RestoreComposer({ userId: id, ...payload })).pipe(
        internal("RestoreComposer")
      ),

    GetComposerImages: (payload) =>
      Effect.flatMap(userId, (id) => reader.GetComposerImages({ userId: id, ...payload })).pipe(
        internal("GetComposerImages")
      ),
    SetComposerImage: (payload) =>
      Effect.flatMap(userId, (id) => writer.SetComposerImage({ userId: id, ...payload })).pipe(
        internal("SetComposerImage")
      ),
    GetComposerChoice: ({ chatId, draftId }) =>
      Effect.flatMap(userId, (id) => reader.GetComposerChoice({ userId: id, chatId, draftId })).pipe(
        internal("GetComposerChoice")
      ),

    // Every tab of the chat shows the composer's speaker as it is now (ST-GRIPES D8).
    SetComposerChoice: (payload) =>
      Effect.flatMap(userId, (id) => writer.SetComposerChoice({ userId: id, ...payload })).pipe(
        Effect.tap((choice) => Effect.sync(() => hub.publish(payload.chatId, { _tag: "ComposerChoice", choice }))),
        internal("SetComposerChoice")
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
