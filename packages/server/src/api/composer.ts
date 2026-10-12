// The composer's drafts (@rp/shared/composerApi.ts): one per branch tip of a chat, on the
// draft store every text field shares (ARCHITECTURE §3.10). A closing page sends its unsaved
// text to POST /library/drafts with the editors' (importer/routes.ts).
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { TextTooLong } from "@rp/shared/composerApi.ts"
import { composerKey } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeComposerHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const handlers = {
    // Only for a live chat of the caller's: a draft is never more than its chat. A composer
    // already there is read in a reader; only a new one, or a copy, takes the writer.
    OpenComposer: ({ chatId, tipSlotId, copyFrom }) =>
      Effect.gen(function* () {
        const id = yield* userId
        if (copyFrom === undefined) {
          yield* reader.GetChat({ userId: id, chatId })
          const there = yield* reader.GetDraft({ userId: id, key: composerKey(chatId, tipSlotId) })
          if (there !== null) return there
        }
        return yield* writer.OpenComposer({ userId: id, chatId, tipSlotId, copyFrom: copyFrom ?? null })
      }).pipe(internal("OpenComposer")),

    SaveComposer: (payload) =>
      Effect.flatMap(userId, (id) => writer.SaveComposer({ userId: id, ...payload, next: payload.next ?? false })).pipe(
        Effect.catchTag("DraftTooLarge", ({ length, max }) => Effect.fail(new TextTooLong({ length, max }))),
        internal("SaveComposer")
      ),

    ComposerHistory: ({ chatId, draftId, limit }) =>
      Effect.flatMap(userId, (id) => reader.ComposerHistory({ userId: id, chatId, draftId, limit })).pipe(
        internal("ComposerHistory")
      ),

    RestoreComposer: ({ chatId, draftId, seq, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreComposer({ userId: id, chatId, draftId, seq, expectedRowVersion })
      ).pipe(internal("RestoreComposer"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
