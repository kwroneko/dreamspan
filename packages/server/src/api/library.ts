// Client RPC handlers for the library (ARCHITECTURE.md §11). Storage enforces ownership:
// every read is the authenticated user's own.
import { type AppApi, CurrentUser } from "@dreamspan/shared/api.ts"
import { ServerError } from "@dreamspan/shared/errors.ts"
import { Effect } from "effect"
import { OperationCall } from "../agent/operations.ts"
import { Formats } from "../importer/Formats.ts"
import { Reader } from "../db/Database.ts"

export const makeLibraryHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const formats = yield* Formats
  return {
    ListExportFormats: () =>
      formats.listExports.pipe(Effect.mapError(() => new ServerError({ message: "ListExportFormats failed" }))),
    ListLibrary: ({ kind, archived, withFilterData }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const call = yield* OperationCall
        return yield* reader.ListLibrary({
          userId: user.id,
          kind,
          tag: null,
          archived: archived ?? false,
          ...(withFilterData ? { withFilterData } : {}),
          ...(call && kind === "note" ? { globalSharedOnly: true } : {})
        })
      }).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], (error) =>
          Effect.logError("ListLibrary failed", error).pipe(
            Effect.andThen(Effect.fail(new ServerError({ message: "ListLibrary failed" })))
          )
        )
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
