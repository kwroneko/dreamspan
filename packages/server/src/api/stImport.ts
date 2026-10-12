// Client RPC handlers for the ST data folder import (ARCHITECTURE.md §13). The files go
// over HTTP (importer/routes.ts); these start an import, read its report, and act on it.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { ServerError } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Writer } from "../db/Database.ts"
import { StImports } from "../importer/StImports.ts"

export const makeStImportHandlers = Effect.gen(function* () {
  const imports = yield* StImports
  const writer = yield* Writer
  const hub = yield* ChatHub
  return {
    StartStImport: ({ unsupported }) =>
      Effect.flatMap(CurrentUser, (user) => Effect.map(imports.start(user, unsupported), (importId) => ({ importId }))),
    GetStImportReport: ({ importId }) => Effect.flatMap(CurrentUser, (user) => imports.report(user, importId)),
    UnhideImportedRun: ({ chatId, throughSlotId }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const done = yield* writer.StImportUnhide({ userId: user.id, chatId, throughSlotId })
        imports.unhidden(user, chatId)
        // Open tabs read the chat again.
        hub.publish(chatId, { _tag: "Reload" })
        return done
      }).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], (error) =>
          Effect.logError("UnhideImportedRun failed", error).pipe(
            Effect.andThen(Effect.fail(new ServerError({ message: "UnhideImportedRun failed" })))
          )
        )
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
