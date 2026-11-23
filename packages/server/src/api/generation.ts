import { Formats } from "../importer/Formats.ts"
// Client RPC handlers for the user's generation defaults (ARCHITECTURE §15). Storage checks
// that the model and the preset are the user's own: anything else is NotFound.
import { type AppApi, CurrentUser } from "@dreamspan/shared/api.ts"
import { ServerError } from "@dreamspan/shared/errors.ts"
import { Effect } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { TextTokens } from "../providers/TextTokens.ts"

const serverError = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`, error).pipe(
    Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
  )

export const makeGenerationHandlers = Effect.gen(function* () {
  const formats = yield* Formats
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const tokens = yield* TextTokens
  return {
    PreviewStSettings: ({ text, surface }) =>
      formats
        .previewStSettings(text, surface)
        .pipe(Effect.catchTag("FormatWorkerFailed", serverError("PreviewStSettings"))),
    CountTokens: ({ texts, model }) => Effect.flatMap(CurrentUser, (user) => tokens.count(user.id, texts, model)),
    GetTokenCounting: () =>
      Effect.flatMap(CurrentUser, (user) => reader.GetTokenCounting({ userId: user.id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], serverError("GetTokenCounting"))
      ),
    SetTokenCounting: ({ connectionId, via }) =>
      Effect.flatMap(CurrentUser, (user) =>
        // Open chats' image estimates are made again: a provider chosen now counts their images.
        writer
          .SetTokenCounting({ userId: user.id, connectionId, via })
          .pipe(Effect.tap(() => warmth.refreshUser(user.id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], serverError("SetTokenCounting"))),
    GetGenerationDefaults: () =>
      Effect.flatMap(CurrentUser, (user) => reader.GetGenerationDefaults({ userId: user.id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], serverError("GetGenerationDefaults"))
      ),
    SetGenerationDefaults: ({ defaults }) =>
      Effect.flatMap(CurrentUser, (user) =>
        writer
          .SetGenerationDefaults({ userId: user.id, defaults })
          .pipe(Effect.tap(() => warmth.refreshUser(user.id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], serverError("SetGenerationDefaults"))),
    ChangeGenerationDefaults: ({ change }) =>
      Effect.flatMap(CurrentUser, (user) =>
        writer
          .ChangeGenerationDefaults({ userId: user.id, change })
          .pipe(Effect.tap(() => warmth.refreshUser(user.id, true)))
      ).pipe(Effect.catchTag(["StorageError", "RpcClientError"], serverError("ChangeGenerationDefaults")))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
