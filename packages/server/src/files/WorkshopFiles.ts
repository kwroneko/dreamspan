// The files host (spec/FILES-AND-ENVIRONMENT.md §5): registers the workshop's file tools and
// `bash` in the rollout tool catalog, and puts files back for Undo. Files live at FILES_DIR
// (default DATA_DIR/files), home folders for commands at DATA_DIR/env-home. It also owns the
// Files quota and version retention (files/quota.ts), the commands' refused public addresses
// (sandbox/network.ts) and the sandbox's start (stale run folders, which cgroup limiter).
import { join } from "node:path"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import type { User } from "@rp/shared/domain.ts"
import type { RolloutEffect } from "@rp/shared/workshopApi.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ExecutionRegistry } from "../execution.ts"
import { MediaHolds } from "../importer/MediaHolds.ts"
import { makeFileTools } from "../agent/tools/files.ts"
import { makeAddressSet } from "../net/addressSet.ts"
import { parsePublicOrigins } from "../net/exposure.ts"
import { commandSandboxes } from "../sandbox/registry.ts"
import { setPublicAddresses } from "../sandbox/network.ts"
import { accountEnv } from "./environment.ts"
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
  }
>()("rp/files/WorkshopFiles") {
  static readonly layer = Layer.effect(
    WorkshopFiles,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const execution = yield* ExecutionRegistry
      const holds = yield* MediaHolds
      const reader = yield* Reader
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
          return { filesRoot: env.filesRoot, home: env.home }
        }
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
        quota
      })
      for (const tool of files.tools) yield* execution.rolloutTools.register(tool)

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
        quota
      }
    })
  )
}
