// Main-thread access to the database workers. ARCHITECTURE.md §3.1 and §3.6.
import { StateModules, stateModuleClient } from "./stateModules.ts"
import { AssemblyModules, moduleClient } from "../assembler/modules.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { type ResourceLimits, Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { Worker as Workers } from "effect/workers"
import { type BinLimits, defaultBinLimits } from "@rp/shared/bin.ts"
import { acquireInstanceLock, checkFilesystem, databaseFile } from "./connection.ts"
import { prepareDataDirectory } from "../dataDirectory.ts"
import { ReadOps, WriteOps, type WriteOpsChat, type WriteOpsLibrary } from "./ops.ts"
import type { OpsOf } from "./opsOf.ts"
import * as ReaderPool from "./readerPool.ts"
import { stampMatches } from "./workerStamp.ts"
import { ProviderDefinitions, providerDefinitionClient } from "../providers/definitions.ts"

// Typed through `OpsOf`, never `RpcClient.FromGroup` (opsOf.ts). The writer's halves are only a
// grouping in ops.ts; a new write operation goes in either.
type OpsClient<Group> = RpcClient.RpcClient<OpsOf<Group>, RpcClientError.RpcClientError>

interface WriterClient extends OpsClient<typeof WriteOpsChat>, OpsClient<typeof WriteOpsLibrary> {}

export class Writer extends Context.Service<Writer, WriterClient>()("rp/db/Writer") {}

export class Reader extends Context.Service<Reader, OpsClient<typeof ReadOps>>()("rp/db/Reader") {}

/** Tests can advance the writer's history clock without sleeping or writing SQLite on the main thread. */
export const DraftClock = Context.Reference<SharedArrayBuffer | null>("rp/db/DraftClock", { defaultValue: () => null })

interface DatabaseOptions {
  readonly dataDir: string
  readonly readers: number
  readonly allowNetworkFs: boolean
  /** source: the worker TypeScript (development and tests). bundle: the `npm run build` bundles. */
  readonly workers: "source" | "bundle"
  /** Where the bundles are; `packages/server/dist/workers` when omitted. */
  readonly bundleDir?: string
  /** Recycle bin capacities; defaults when omitted. */
  readonly binLimits?: BinLimits
}

class WorkerBundleMissing extends Schema.TaggedError<WorkerBundleMissing>()("WorkerBundleMissing", {
  path: Schema.String
}) {
  override get message() {
    return `Database worker bundle not found at ${this.path}. Run \`npm run build\`, or set DB_WORKERS=source.`
  }
}

class WorkerBundleStale extends Schema.TaggedError<WorkerBundleStale>()("WorkerBundleStale", {
  path: Schema.String
}) {
  override get message() {
    return `The database worker bundles in ${this.path} were built from other sources than this server's. Run \`npm run build\`.`
  }
}

const defaultBundleDir = fileURLToPath(new URL("../../dist/workers", import.meta.url))

/**
 * Where bundled workers are looked for when the options name no directory. The tests point
 * it at the bundles their run built (test/support/globalSetup.ts).
 */
export const WorkerBundleDir = Context.Reference<string>("rp/db/WorkerBundleDir", {
  defaultValue: () => defaultBundleDir
})

/** A bundled worker's entry point, `<name>.mjs` in `dir`. It must exist and match the sources. */
export const bundleEntry = (dir: string, name: string) =>
  Effect.gen(function* () {
    const path = join(dir, `${name}.mjs`)
    if (!existsSync(path)) return yield* new WorkerBundleMissing({ path })
    if (!stampMatches(dir)) return yield* new WorkerBundleStale({ path: dir })
    return pathToFileURL(path)
  })

/** Reads that browse, and can be slow at scale: they never hold the last free reader (readerPool.ts). */
const BACKGROUND_READS: ReadonlySet<string> = new Set(["ShellLibrary", "ShellCards", "ShellForks", "CacheWarmth"])

/**
 * Reads a reply waits on before its request goes out (chat/ContextGenerator.ts; the provider
 * layer's connection, model and pricing, and its cache gate): they go ahead of whatever else is
 * queued, as browsing reads the history in pages. All are small but the assembly.
 */
const REPLY_READS: ReadonlySet<string> = new Set([
  "GetSlot",
  "AssembleContext",
  "ResolveConnection",
  "GetModel",
  "GetCostSettings",
  "CachePrefixWarm"
])

/** The writer's and readers' entry points. */
const workerEntries = (options: DatabaseOptions) =>
  Effect.gen(function* () {
    if (options.workers === "source") {
      return {
        writer: new URL("./writer.ts", import.meta.url),
        reader: new URL("./reader.ts", import.meta.url),
        bundleDir: undefined
      }
    }
    const dir = options.bundleDir ?? (yield* WorkerBundleDir)
    return { writer: yield* bundleEntry(dir, "writer"), reader: yield* bundleEntry(dir, "reader"), bundleDir: dir }
  })

/**
 * Spawns worker threads. With bundles, every spawn checks the stamp again (about 3 ms),
 * so a crashed worker isn't replaced by code built after this server started.
 */
export const workerThreads = (
  entry: URL,
  workerData: Record<string, unknown>,
  bundleDir?: string,
  resourceLimits?: ResourceLimits,
  /** Told of each thread spawned, by worker id, e.g. to be able to stop it. */
  onThread?: (id: number, thread: Worker) => void
) =>
  NodeWorker.layer((id) => {
    if (bundleDir !== undefined && !stampMatches(bundleDir)) throw new WorkerBundleStale({ path: bundleDir })
    const thread = new Worker(entry, {
      workerData,
      name: entry.pathname.split("/").pop(),
      ...(resourceLimits ? { resourceLimits } : {})
    })
    onThread?.(id, thread)
    return thread
  })

/**
 * The writer's protocol over `threads`: Effect's worker pool with one worker, which
 * respawns it every second without logging. Stops are logged here: the first with its
 * cause, then failed restarts as a count (after 1, 2, 4, 8, … of them), then the recovery.
 */
export const writerProtocol = (threads: Layer.Layer<Workers.WorkerPlatform | Workers.Spawner>) => {
  const LoggedStops = Layer.effect(
    Workers.WorkerPlatform,
    Effect.map(Workers.WorkerPlatform, (platform) => {
      let stops = 0
      const stopped = (cause: Cause.Cause<unknown>) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        stops++
        const failedRestarts = stops - 1
        if (failedRestarts === 0) return Effect.logError("database writer stopped; restarting it every second", cause)
        return (failedRestarts & (failedRestarts - 1)) === 0
          ? Effect.logError(`database writer still down after ${failedRestarts} failed restarts`)
          : Effect.void
      }
      const started = Effect.suspend(() => {
        const failedRestarts = stops - 1
        stops = 0
        return failedRestarts < 0
          ? Effect.void
          : Effect.logInfo(`database writer is back after ${failedRestarts} failed restarts`)
      })
      return Workers.WorkerPlatform.of({
        spawn: <O, I>(id: number) =>
          Effect.map(platform.spawn<O, I>(id), (worker): Workers.Worker<O, I> => ({
            send: worker.send,
            run: (handler, options) =>
              worker
                .run(handler, { onSpawn: Effect.andThen(started, options?.onSpawn ?? Effect.void) })
                .pipe(Effect.tapCause(stopped))
          }))
      })
    })
  )
  return RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
    Layer.provide(LoggedStops.pipe(Layer.provideMerge(threads)))
  )
}

export const layer = (options: DatabaseOptions) => {
  const dbPath = databaseFile(options.dataDir)

  // Runs before any connection opens, and holds the instance lock for the layer's lifetime.
  const Guards = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* prepareDataDirectory(options.dataDir)
      yield* checkFilesystem(options.dataDir, options.allowNetworkFs)
      yield* acquireInstanceLock(options.dataDir)
    })
  )

  const Workers = Layer.unwrap(
    Effect.gen(function* () {
      const entries = yield* workerEntries(options)
      const draftClock = yield* DraftClock
      const modules = yield* AssemblyModules
      const stateModules = yield* StateModules
      const providers = yield* ProviderDefinitions
      const WriterLive = Layer.effect(
        Writer,
        // The union comes from `OpsOf`, not inferred against the group (TS2589 past ~400 operations).
        Effect.map(RpcClient.make<OpsOf<typeof WriteOps>>(WriteOps), (calls) =>
          providerDefinitionClient(stateModuleClient(calls, stateModules), providers)
        )
      ).pipe(
        Layer.provide(
          writerProtocol(
            workerThreads(
              entries.writer,
              { dbPath, binLimits: options.binLimits ?? defaultBinLimits, draftClock },
              entries.bundleDir
            )
          )
        )
      )
      // Readers open read-only connections, so the file must exist and be migrated first.
      const ReaderLive = Layer.unwrap(
        Effect.gen(function* () {
          const writer = yield* Writer
          yield* writer.Ready()
          return Layer.effect(
            Reader,
            Effect.map(ReaderPool.client(ReadOps), (calls) =>
              providerDefinitionClient(stateModuleClient(moduleClient(calls, modules), stateModules), providers)
            )
          ).pipe(
            // Reads are idempotent, so one whose reader crashed can run again.
            // Reads of what the user browses (the shell's lists, cache estimates) leave one reader
            // free whenever there are two, so a reply's reads never wait behind them.
            Layer.provide(
              ReaderPool.layer(options.readers, {
                retryCrashed: true,
                background: { tags: BACKGROUND_READS, max: Math.max(1, options.readers - 1) },
                first: REPLY_READS
              })
            ),
            Layer.provide(
              workerThreads(
                entries.reader,
                { dbPath, binLimits: options.binLimits ?? defaultBinLimits },
                entries.bundleDir
              )
            )
          )
        })
      )
      return ReaderLive.pipe(Layer.provideMerge(WriterLive))
    })
  )

  return Workers.pipe(
    Layer.provide(Guards),
    Layer.provideMerge(AssemblyModules.layer),
    Layer.provideMerge(StateModules.layer),
    Layer.provideMerge(ProviderDefinitions.layer)
  )
}
