// The files host (spec/FILES-AND-ENVIRONMENT.md §5): registers the workshop's file tools and
// `bash` in the rollout tool catalog, and puts files back for Undo. Files live at FILES_DIR
// (default DATA_DIR/files), home folders for commands at DATA_DIR/env-home.
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import type { User } from "@rp/shared/domain.ts"
import type { RolloutEffect } from "@rp/shared/workshopApi.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { ExecutionRegistry } from "../execution.ts"
import { MediaHolds } from "../importer/MediaHolds.ts"
import { makeFileTools } from "../agent/tools/files.ts"
import { commandSandboxes } from "../sandbox/registry.ts"

export class WorkshopFiles extends Context.Service<
  WorkshopFiles,
  {
    readonly undoEffect: (actor: User, effect: RolloutEffect) => Effect.Effect<RolloutEffect, unknown>
    /** Why commands can't run on this server, for the capability row; null: they can. */
    readonly commandsUnavailable: () => Effect.Effect<string | null>
  }
>()("rp/files/WorkshopFiles") {
  static readonly layer = Layer.effect(
    WorkshopFiles,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const execution = yield* ExecutionRegistry
      const holds = yield* MediaHolds
      const files = makeFileTools({
        dataDir: config.dataDir,
        filesDir: config.filesDir || join(config.dataDir, "files"),
        homesDir: join(config.dataDir, "env-home"),
        reader: yield* Reader,
        writer: yield* Writer,
        registries: execution,
        sandboxes: commandSandboxes,
        ...(config.commandSandbox ? { sandboxId: config.commandSandbox } : {}),
        holding: holds.holding
      })
      for (const tool of files.tools) yield* execution.rolloutTools.register(tool)
      return { undoEffect: files.undoEffect, commandsUnavailable: files.commandsUnavailable }
    })
  )
}
