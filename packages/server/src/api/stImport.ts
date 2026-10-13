// Client RPC handlers for the ST data folder import (ARCHITECTURE.md §13). The files go
// over HTTP (importer/routes.ts); these start an import, read its report, and act on it.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Forbidden, NotFound, ServerError } from "@rp/shared/errors.ts"
import { classifyStPath } from "@rp/shared/stFolder.ts"
import { StFolderUnreadable } from "@rp/shared/stImportApi.ts"
import { homedir } from "node:os"
import { Effect, Option } from "effect"
import { AppConfig } from "../config.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Writer } from "../db/Database.ts"
import { StImports } from "../importer/StImports.ts"
import { listFolder, readStFolderFile, scanStFolder } from "../importer/stFolderDisk.ts"

/** Reading a folder by its path is for admins: anyone else could read any user's files. */
const adminOnly = Effect.flatMap(CurrentUser, (user) =>
  user.role === "admin"
    ? Effect.succeed(user)
    : Effect.fail(new Forbidden({ message: "Only an admin can import a folder by its path." }))
)

export const makeStImportHandlers = Effect.gen(function* () {
  const imports = yield* StImports
  const writer = yield* Writer
  const hub = yield* ChatHub
  const config = yield* AppConfig
  const start = Option.getOrElse(config.importStartDir, homedir)
  return {
    StartStImport: ({ unsupported }) =>
      Effect.flatMap(CurrentUser, (user) => Effect.map(imports.start(user, unsupported), (importId) => ({ importId }))),
    ListFolder: ({ path }) => Effect.andThen(adminOnly, listFolder(path, start)),
    ScanStFolder: ({ path }) => Effect.andThen(adminOnly, scanStFolder(path)),
    ImportStFolderFile: ({ importId, root, path, size, modifiedMs, start, part, card, orphan }) =>
      Effect.gen(function* () {
        const user = yield* adminOnly
        const file = classifyStPath(path)
        if (file === null || file.kind === "unsupported")
          return yield* new StFolderUnreadable({ message: "That isn't a file the import reads." })
        if (!imports.exists(user, importId)) return yield* new NotFound({ entity: "import", id: importId })
        const chat = file.kind === "chat" || file.kind === "group_chat"
        const read = yield* readStFolderFile(root, path, { size, modifiedMs }, start, chat)
        const result = yield* imports.file(user, importId, path, read.bytes, { part, last: read.last, card, orphan })
        return { result, next: read.next, last: read.last }
      }).pipe(Effect.catchTag("StImportFailed", (error) => Effect.fail(new ServerError({ message: error.message })))),
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
