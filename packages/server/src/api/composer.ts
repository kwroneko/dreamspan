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
    // Only for a live chat of the caller's: a draft is never more than its chat.
    GetComposer: ({ chatId, tipSlotId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* reader.GetChat({ userId: id, chatId })
        return yield* reader.GetDraft({ userId: id, key: composerKey(chatId, tipSlotId) })
      }).pipe(internal("GetComposer")),

    SaveComposer: ({ chatId, tipSlotId, content, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.SaveDraft({
          userId: id,
          key: composerKey(chatId, tipSlotId),
          content,
          expectedRowVersion,
          baseRevision: null
        })
      ).pipe(
        Effect.catchTag("DraftTooLarge", ({ length, max }) => Effect.fail(new TextTooLong({ length, max }))),
        internal("SaveComposer")
      ),

    ComposerHistory: ({ chatId, tipSlotId, limit }) =>
      Effect.flatMap(userId, (id) =>
        reader.DraftHistory({ userId: id, key: composerKey(chatId, tipSlotId), limit })
      ).pipe(internal("ComposerHistory")),

    RestoreComposer: ({ chatId, tipSlotId, seq, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({ userId: id, key: composerKey(chatId, tipSlotId), seq, expectedRowVersion })
      ).pipe(internal("RestoreComposer"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
