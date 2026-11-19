// The files host (spec/FILES-AND-ENVIRONMENT.md §5): registers the workshop's file tools and
// `bash` in the rollout tool catalog, and puts files back for Undo. Files live at FILES_DIR
// (default DATA_DIR/files), home folders for commands at DATA_DIR/env-home. It also owns the
// Files quota and version retention (files/quota.ts), the commands' refused public addresses
// (sandbox/network.ts) and the sandbox's start (stale run folders, which cgroup limiter).
import { join } from "node:path"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import type { User, UserId } from "@dreamspan/shared/domain.ts"
import { FILES_TOP, foldersShowing } from "@dreamspan/shared/files.ts"
import { Notices } from "../chat/Notices.ts"
import type { RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ExecutionRegistry } from "../execution.ts"
import { MediaHolds } from "../importer/MediaHolds.ts"
import { FILE_TOOLS, makeFileTools } from "../agent/tools/files.ts"
import { makeAddressSet } from "../net/addressSet.ts"
import { parsePublicOrigins } from "../net/exposure.ts"
import { commandSandboxes } from "../sandbox/registry.ts"
import { setPublicAddresses } from "../sandbox/network.ts"
import { accountEnv, prepareAccount } from "./environment.ts"
import { folderAt, locateFolder } from "./workingFolder.ts"
import { BIN_FOLDER, makeFilesBin, type FilesBin } from "./bin.ts"
import { makeFilesQuota, parseByteSize, type FilesQuota } from "./quota.ts"

export class WorkshopFiles extends Context.Service<
  WorkshopFiles,
  {
    readonly undoEffect: (actor: User, effect: RolloutEffect) => Effect.Effect<RolloutEffect, unknown>
    /** Why commands can't run on this server, for the capability row; null: they can. */
    readonly commandsUnavailable: () => Effect.Effect<string | null>
    /** What the row adds where commands run with weaker limits; null: nothing. */
    readonly commandsNote: () => Effect.Effect<string | null>
    readonly quota: FilesQuota
    /** Files and folders deleted in the app, until restored or emptied (§1.3). */
    readonly bin: FilesBin
    /**
     * Tells the account's open file managers what changed (§8.1, live refresh): the paths
     * changed, added or removed (`/files/…`); `all` when a command's scan couldn't list them all.
     */
    readonly changed: (userId: string, paths: ReadonlyArray<string>, all?: boolean) => void
    /** A folder of the account's Files with its inode, for `workshop.folder` (§2.1); fails when it isn't one. */
    readonly folderAt: (userId: string, path: string) => Effect.Effect<{ path: string; inode: number | null }, unknown>
    /** Where a stored working folder is now (workingFolder.ts `locateFolder`); null when it's gone. */
    readonly locateFolder: (
      userId: string,
      stored: { readonly path: string; readonly inode: number | null }
    ) => Effect.Effect<string | null>
  }
>()("rp/files/WorkshopFiles") {
  static readonly layer = Layer.effect(
    WorkshopFiles,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const execution = yield* ExecutionRegistry
      const holds = yield* MediaHolds
      const reader = yield* Reader
      const notices = yield* Notices
      const writer = yield* Writer
      const defaultBytes = parseByteSize(config.filesQuota)
      if (defaultBytes === null)
        return yield* Effect.die(
          new Error(`FILES_QUOTA must be bytes or a size such as 10G, not “${config.filesQuota}”.`)
        )
      const dirs = {
        filesDir: config.filesDir || join(config.dataDir, "files"),
        homesDir: join(config.dataDir, "env-home")
      }
      const quota = makeFilesQuota({
        reader,
        writer,
        defaultBytes,
        folders: (userId) => {
          const env = accountEnv(dirs, userId)
          return { filesRoot: env.filesRoot, home: env.home, bin: join(dirs.filesDir, BIN_FOLDER, userId) }
        }
      })
      /** A stored folder found again (workingFolder.ts), through the app's own moves too. */
      const locate = (userId: string, stored: { readonly path: string; readonly inode: number | null }) =>
        Effect.gen(function* () {
          const { moves } = yield* reader
            .WorkshopFolderMemory({ userId: userId as UserId, cardId: null })
            .pipe(Effect.orElseSucceed(() => ({ moves: [] })))
          return yield* Effect.promise(() =>
            locateFolder(accountEnv(dirs, userId).filesRoot, stored, moves).catch(() => null)
          )
        })
      const changed = (userId: string, paths: ReadonlyArray<string>, all = false) => {
        const folders = new Set<string>()
        for (const path of paths) for (const folder of foldersShowing(path)) folders.add(folder)
        if (folders.size > 0 || all)
          notices.publish(userId as UserId, { _tag: "FilesChanged", folders: [...folders], all })
      }
      const bin = makeFilesBin({
        filesDir: dirs.filesDir,
        rootOf: (userId) => accountEnv(dirs, userId).filesRoot,
        reader,
        writer,
        quota
      })
      const files = makeFileTools({
        dataDir: config.dataDir,
        ...dirs,
        reader,
        writer,
        registries: execution,
        sandboxes: commandSandboxes,
        ...(config.commandSandbox ? { sandboxId: config.commandSandbox } : {}),
        holding: holds.holding,
        quota,
        onChanged: changed
      })
      for (const tool of files.tools) yield* execution.rolloutTools.register(tool)
      yield* execution.subagentWorkspaces.register(files.workspaces)
      // The turn's tail says where commands start (§2.1), when the turn offers the file tools.
      yield* execution.turnNotes.register({
        id: "files.workingFolder",
        line: ({ userId, state, offered }) =>
          Effect.gen(function* () {
            if (!offered.some((id) => (FILE_TOOLS as ReadonlyArray<string>).includes(id))) return null
            const stored = state.workshopFolder
            if (!stored) return `Working folder: ${FILES_TOP}`
            const now = yield* locate(userId, stored)
            return now
              ? `Working folder: ${now}`
              : `Working folder: ${FILES_TOP} (${stored.path} wasn't found, so commands start at the top of the files)`
          })
      })

      // Commands may not reach the server's own public addresses: those named, and those its
      // public origins' hosts resolve to (behind NAT neither is on an interface).
      const { publicOrigins } = parsePublicOrigins(config.publicOrigins)
      const own = yield* makeAddressSet("PUBLIC_ADDRESSES", [
        ...config.publicAddresses,
        ...publicOrigins.origins.map((origin) => new URL(origin).hostname.replace(/^\[|\]$/g, ""))
      ])
      if (own.invalid.length) yield* Effect.logWarning(`PUBLIC_ADDRESSES: ignored ${own.invalid.join(", ")}`)
      const before = setPublicAddresses(own.has)
      yield* Effect.addFinalizer(() => Effect.sync(() => setPublicAddresses(before)))

      // The sandbox's start: run folders a killed server left, and which limits commands get.
      for (const sandbox of commandSandboxes.list())
        if (sandbox.start && sandbox.platforms.includes(process.platform))
          yield* Effect.promise(() => sandbox.start!().catch(() => [] as ReadonlyArray<string>)).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, (line) => Effect.logInfo(`${sandbox.id}: ${line}`))),
            Effect.forkScoped
          )

      // Retention every hour, from startup; usage of accounts in use every 10 minutes.
      yield* quota.sweepVersions.pipe(
        Effect.tap((removed) =>
          removed > 0 ? Effect.logInfo(`removed ${removed} file versions past retention`) : Effect.void
        ),
        Effect.catchCause((cause) => Effect.logWarning("file version retention failed", cause)),
        Effect.repeat(Schedule.spaced(Duration.millis(quota.intervals.retentionMs))),
        Effect.forkScoped
      )
      // The content of bin items that went (emptied, purged, or evicted past the bin's limits).
      yield* bin.sweep().pipe(
        Effect.tap((bytes) =>
          bytes > 0 ? Effect.logInfo(`removed ${bytes} bytes of files gone from the bin`) : Effect.void
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(quota.intervals.retentionMs))),
        Effect.forkScoped
      )
      yield* quota.remeasureActive.pipe(
        Effect.catchCause((cause) => Effect.logWarning("measuring Files usage failed", cause)),
        Effect.delay(Duration.millis(quota.intervals.measureMs)),
        Effect.forever,
        Effect.forkScoped
      )
      return {
        undoEffect: files.undoEffect,
        commandsUnavailable: files.commandsUnavailable,
        commandsNote: files.commandsNote,
        quota,
        bin,
        changed,
        folderAt: (userId, path) =>
          Effect.tryPromise(async () => {
            const env = accountEnv(dirs, userId)
            await prepareAccount(env)
            return folderAt(env.filesRoot, path)
          }),
        locateFolder: locate
      }
    })
  )
}
