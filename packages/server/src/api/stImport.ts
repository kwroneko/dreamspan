// Client RPC handlers for the ST data folder import (ARCHITECTURE.md §13). A folder named by
// its path is imported on the server as a job (StImportJobs); a browser's files go over
// HTTP (importer/routes.ts). These start an import, list and read the jobs, and act on a
// report.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Forbidden, ServerError } from "@rp/shared/errors.ts"
import { homedir } from "node:os"
import { Effect, Option } from "effect"
import { AppConfig } from "../config.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import { StImportJobs } from "../importer/StImportJobs.ts"
import { StImports } from "../importer/StImports.ts"
import { listFolder, scanStFolder } from "../importer/stFolderDisk.ts"

/** Reading a folder by its path is for admins: anyone else could read any user's files. */
const adminOnly = Effect.flatMap(CurrentUser, (user) =>
  user.role === "admin"
    ? Effect.succeed(user)
    : Effect.fail(new Forbidden({ message: "Only an admin can import a folder by its path." }))
)

export const makeStImportHandlers = Effect.gen(function* () {
  const imports = yield* StImports
  const jobs = yield* StImportJobs
  const writer = yield* Writer
  const reader = yield* Reader
  const hub = yield* ChatHub
  const config = yield* AppConfig
  const start = Option.getOrElse(config.importStartDir, homedir)
  return {
    StartStImport: ({ unsupported, source, files, bytes }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.map(
          jobs.startUpload(user, unsupported, {
            source: source ?? "A folder sent from a browser",
            files: files ?? 0,
            bytes: bytes ?? 0
          }),
          (importId) => ({ importId })
        )
      ),
    StartStPathImport: ({ path, prefix }) =>
      Effect.flatMap(adminOnly, (user) => Effect.map(jobs.startPath(user, path, prefix), (importId) => ({ importId }))),
    FinishStImport: ({ importId, notSent }) =>
      Effect.flatMap(CurrentUser, (user) => jobs.finishUpload(user, importId, notSent)),
    ListStImports: () => Effect.flatMap(CurrentUser, (user) => jobs.list(user)),
    GetStImport: ({ importId }) => Effect.flatMap(CurrentUser, (user) => jobs.get(user, importId)),
    SeenStImport: ({ importId }) => Effect.flatMap(CurrentUser, (user) => jobs.seen(user, importId)),
    CancelStImport: ({ importId }) => Effect.flatMap(CurrentUser, (user) => jobs.cancel(user, importId)),
    ClearStImports: ({ importId }) =>
      Effect.flatMap(CurrentUser, (user) => Effect.map(jobs.clear(user, importId), (cleared) => ({ cleared }))),
    LinkStImportChat: ({ importId, path, card }) =>
      Effect.flatMap(adminOnly, (user) => jobs.link(user, importId, path, card)),
    ListFolder: ({ path }) => Effect.andThen(adminOnly, listFolder(path, start)),
    ScanStFolder: ({ path }) => Effect.andThen(adminOnly, scanStFolder(path)),
    // The user's own records only: no file is read, so it isn't for admins alone.
    StImportPreview: ({ paths }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const sources = yield* reader.StImportSources({ userId: user.id })
        const known = new Set([
          ...sources.library.map((entry) => entry.sourcePath),
          ...sources.chats.filter((record) => record.complete).map((record) => record.source)
        ])
        return { known: paths.filter((path) => known.has(path)) }
      }).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], (error) =>
          Effect.logError("StImportPreview failed", error).pipe(
            Effect.andThen(Effect.fail(new ServerError({ message: "The folder's preview couldn't be read." })))
          )
        )
      ),
    GetStImportReport: ({ importId }) => Effect.flatMap(CurrentUser, (user) => imports.report(user, importId)),
    UnhideImportedRun: ({ chatId, throughSlotId, importId }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const done = yield* writer.StImportUnhide({ userId: user.id, chatId, throughSlotId })
        if (importId === undefined) imports.unhidden(user, chatId)
        else yield* jobs.unhidden(user, importId, chatId)
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
