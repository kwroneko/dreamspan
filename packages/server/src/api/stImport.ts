// Client RPC handlers for the ST data folder import (ARCHITECTURE.md §13). A folder named by
// its path is imported on the server as a job (StImportJobs); a browser's files go over
// HTTP (importer/routes.ts). These start an import, list and read the jobs, and act on a
// report.
import { type AppApi, type AuthenticatedStImportPlanApi, CurrentUser } from "@dreamspan/shared/api.ts"
import { Forbidden, ServerError } from "@dreamspan/shared/errors.ts"
import { homedir } from "node:os"
import { Effect, Option } from "effect"
import { AppConfig } from "../config.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import { StImportJobs } from "../importer/StImportJobs.ts"
import { StImportPlans, stFolderPlanFiles } from "../importer/StImportPlans.ts"
import { findStRoots } from "@dreamspan/shared/stFolder.ts"
import { StFolderUnreadable } from "@dreamspan/shared/stImportApi.ts"
import { StImports } from "../importer/StImports.ts"
import { visibleReport } from "../importer/stReport.ts"
import { listFolder, previewStFiles, scanStFolder } from "../importer/stFolderDisk.ts"

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
    StartStImport: ({ unsupported, source, files, bytes, plan }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.map(
          jobs.startUpload(
            user,
            unsupported,
            {
              source: source ?? "A folder sent from a browser",
              files: files ?? 0,
              bytes: bytes ?? 0
            },
            plan
          ),
          (importId) => ({ importId })
        )
      ),
    StartStPathImport: ({ path, prefix, plan }) =>
      Effect.flatMap(adminOnly, (user) =>
        Effect.map(jobs.startPath(user, path, prefix, plan), (importId) => ({ importId }))
      ),
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
    StImportPreview: ({ paths, folder }) =>
      Effect.gen(function* () {
        const user = folder === undefined ? yield* CurrentUser : yield* adminOnly
        const sources = yield* reader.StImportSources({ userId: user.id })
        const known = new Set([
          ...sources.library.map((entry) => entry.sourcePath),
          ...sources.chats.filter((record) => record.complete).map((record) => record.source)
        ])
        const found = paths.filter((path) => known.has(path))
        if (folder === undefined) return { known: found, skipped: [] }
        const hashes = new Set(
          sources.library.flatMap((entry) =>
            entry.sourceHash === null || entry.binned ? [] : [`${entry.kind}:${entry.sourceHash}`]
          )
        )
        const read = yield* previewStFiles(
          folder,
          paths.filter((path) => !known.has(path)),
          hashes
        )
        return { known: [...found, ...read.same], skipped: read.skipped }
      }).pipe(
        Effect.catchTag(["StorageError", "RpcClientError"], (error) =>
          Effect.logError("StImportPreview failed", error).pipe(
            Effect.andThen(Effect.fail(new ServerError({ message: "The folder's preview couldn't be read." })))
          )
        )
      ),
    GetStImportReport: ({ importId }) =>
      Effect.flatMap(CurrentUser, (user) =>
        Effect.map(imports.report(user, importId), (report) => visibleReport(report, jobs.running(user, importId)))
      ),
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

/** The re-import preview (StImportPlans): nothing is written. */
export const makeStImportPlanHandlers = Effect.gen(function* () {
  const plans = yield* StImportPlans
  return {
    StartStImportPlan: ({ folder, files }) =>
      Effect.gen(function* () {
        if (folder !== undefined) {
          const user = yield* adminOnly
          const scanned = yield* scanStFolder(folder.root)
          if (!findStRoots(scanned.files.map((file) => file.path)).some((root) => root.prefix === folder.prefix))
            return yield* new StFolderUnreadable({ message: "That ST user's folder isn't in this folder." })
          const { root, entries } = stFolderPlanFiles(scanned, folder.prefix)
          return yield* plans.start(user, { mode: "path", root }, entries)
        }
        const user = yield* CurrentUser
        return yield* plans.start(user, { mode: "upload" }, files ?? [])
      }).pipe(
        Effect.catch((error): Effect.Effect<never, Forbidden | StFolderUnreadable | ServerError> =>
          error instanceof Forbidden || error instanceof StFolderUnreadable
            ? Effect.fail(error)
            : Effect.logError("StartStImportPlan failed", error).pipe(
                Effect.andThen(Effect.fail(new ServerError({ message: "The folder couldn't be checked; try again." })))
              )
        )
      ),
    GetStImportPlan: ({ planId }) => Effect.flatMap(CurrentUser, (user) => plans.get(user, planId)),
    GetStImportPlanMessages: ({ planId, path, offset }) =>
      Effect.flatMap(CurrentUser, (user) => plans.messages(user, planId, path, offset)),
    CancelStImportPlan: ({ planId }) => Effect.flatMap(CurrentUser, (user) => plans.cancel(user, planId))
  } satisfies Parameters<typeof AuthenticatedStImportPlanApi.of>[0]
})
