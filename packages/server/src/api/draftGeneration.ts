import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Effect, Stream } from "effect"
import { makeDraftGeneration } from "../chat/draftGeneration.ts"
import { Reader } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeDraftGenerationHandlers = Effect.gen(function* () {
  const writeForMe = yield* makeDraftGeneration
  const reader = yield* Reader
  return {
    WriteForMe: ({ target }) => Stream.unwrap(Effect.map(CurrentUser, (user) => writeForMe(user.id, target))),
    GetDraftRunContext: ({ rolloutId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.DraftRunContext({ userId: user.id, rolloutId })).pipe(
        internal("GetDraftRunContext")
      ),
    GetLastDraftRollout: ({ chatId, forkId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.LastDraftRollout({ userId: user.id, chatId, forkId })).pipe(
        internal("GetLastDraftRollout")
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
