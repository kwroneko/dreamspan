// Main-thread access to the database. SQLite never runs on the main thread: one writer
// worker holds the only read-write connection, and a pool of reader workers hold
// read-only connections. See ARCHITECTURE.md "Database" for why this rules out
// SQLITE_BUSY and keeps queries from blocking the event loop.
import { existsSync, mkdirSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { Context, Effect, Layer, Schema } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { type BinLimits, defaultBinLimits } from "@rp/shared/bin.ts"
import { acquireInstanceLock, checkFilesystem, databaseFile } from "./connection.ts"
import { ReadOps, WriteOps } from "./ops.ts"

export class Writer extends Context.Service<
  Writer,
  RpcClient.FromGroup<typeof WriteOps, RpcClientError.RpcClientError>
>()("rp/db/Writer") {}

export class Reader extends Context.Service<
  Reader,
  RpcClient.FromGroup<typeof ReadOps, RpcClientError.RpcClientError>
>()("rp/db/Reader") {}

export interface DatabaseOptions {
  readonly dataDir: string
  readonly readers: number
  readonly allowNetworkFs: boolean
  /**
   * source: run the worker TypeScript directly (development and tests).
   * bundle: run the single-file bundles from `npm run build` (production). Each worker
   * is its own V8 isolate, and a bundle uses about a quarter of the memory.
   */
  readonly workers: "source" | "bundle"
  /** Recycle bin capacities; defaults when omitted. */
  readonly binLimits?: BinLimits
}

export class WorkerBundleMissing extends Schema.TaggedError<WorkerBundleMissing>()("WorkerBundleMissing", {
  path: Schema.String
}) {
  override get message() {
    return `Database worker bundle not found at ${this.path}. Run \`npm run build\`, or set DB_WORKERS=source.`
  }
}

const workerEntry = (name: "writer" | "reader", mode: DatabaseOptions["workers"]) =>
  mode === "source"
    ? Effect.succeed(new URL(`./${name}.ts`, import.meta.url))
    : Effect.suspend(() => {
        const url = new URL(`../../dist/workers/${name}.mjs`, import.meta.url)
        return existsSync(url) ? Effect.succeed(url) : Effect.fail(new WorkerBundleMissing({ path: url.pathname }))
      })

const workers = (entry: URL, workerData: Record<string, unknown>) =>
  NodeWorker.layer(() => new Worker(entry, { workerData, name: entry.pathname.split("/").pop() }))

export const layer = (options: DatabaseOptions) => {
  const dbPath = databaseFile(options.dataDir)

  // Runs before any connection opens, and holds the instance lock for the layer's lifetime.
  const Guards = Layer.effectDiscard(
    Effect.gen(function* () {
      mkdirSync(options.dataDir, { recursive: true })
      yield* checkFilesystem(options.dataDir, options.allowNetworkFs)
      yield* acquireInstanceLock(options.dataDir)
    })
  )

  const WriterLive = Layer.unwrap(
    Effect.map(workerEntry("writer", options.workers), (entry) =>
      Layer.effect(Writer, RpcClient.make(WriteOps)).pipe(
        Layer.provide(RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 })),
        Layer.provide(workers(entry, { dbPath, binLimits: options.binLimits ?? defaultBinLimits }))
      )
    )
  )

  // Readers open read-only connections, so the file must exist and be migrated first.
  const ReaderLive = Layer.unwrap(
    Effect.gen(function* () {
      const writer = yield* Writer
      yield* writer.Ready()
      const entry = yield* workerEntry("reader", options.workers)
      return Layer.effect(Reader, RpcClient.make(ReadOps)).pipe(
        Layer.provide(RpcClient.layerProtocolWorker({ size: options.readers, concurrency: 1 })),
        Layer.provide(workers(entry, { dbPath }))
      )
    })
  )

  return ReaderLive.pipe(Layer.provideMerge(WriterLive), Layer.provide(Guards))
}
