// Client RPC handlers for the library (ARCHITECTURE.md §10). Storage enforces ownership:
// every read is the authenticated user's own.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { ServerError } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import { Reader } from "../db/Database.ts"

export const makeLibraryHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  return {
    ListLibrary: ({ kind }) =>
      Effect.flatMap(CurrentUser, (user) =>
        reader.ListLibrary({ userId: user.id, kind, tag: null, archived: false })
      ).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], (error) =>
          Effect.logError("ListLibrary failed", error).pipe(
            Effect.andThen(Effect.fail(new ServerError({ message: "ListLibrary failed" })))
          )
        )
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
