// Client RPC handlers for the user's generation defaults (ARCHITECTURE §15). Storage checks
// that the model and the preset are the user's own: anything else is NotFound.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { ServerError } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"

const serverError = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`, error).pipe(
    Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
  )

export const makeGenerationHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  return {
    GetGenerationDefaults: () =>
      Effect.flatMap(CurrentUser, (user) => reader.GetGenerationDefaults({ userId: user.id })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], serverError("GetGenerationDefaults"))
      ),
    SetGenerationDefaults: ({ defaults }) =>
      Effect.flatMap(CurrentUser, (user) => writer.SetGenerationDefaults({ userId: user.id, defaults })).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], serverError("SetGenerationDefaults"))
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
