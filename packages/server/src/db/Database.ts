// Main-thread access to the database workers. ARCHITECTURE.md §3.1 and §3.6.
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { Context, Effect, Layer, Schema } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { type BinLimits, defaultBinLimits } from "@rp/shared/bin.ts"
import { acquireInstanceLock, checkFilesystem, databaseFile } from "./connection.ts"
import { ReadOps, WriteOps } from "./ops.ts"
import * as ReaderPool from "./readerPool.ts"
import { stampMatches } from "./workerStamp.ts"

export class Writer extends Context.Service<
  Writer,
  RpcClient.FromGroup<typeof WriteOps, RpcClientError.RpcClientError>
>()("rp/db/Writer") {}

export class Reader extends Context.Service<
  Reader,
  RpcClient.FromGroup<typeof ReadOps, RpcClientError.RpcClientError>
>()("rp/db/Reader") {}

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

/** The writer's and readers' entry points. Bundles must exist and match the sources. */
const workerEntries = (options: DatabaseOptions) =>
  Effect.gen(function* () {
    if (options.workers === "source") {
      return { writer: new URL("./writer.ts", import.meta.url), reader: new URL("./reader.ts", import.meta.url) }
    }
    const dir = options.bundleDir ?? defaultBundleDir
    const [writer, reader] = [join(dir, "writer.mjs"), join(dir, "reader.mjs")]
    for (const path of [writer, reader]) {
      if (!existsSync(path)) return yield* new WorkerBundleMissing({ path })
    }
    if (!stampMatches(dir)) return yield* new WorkerBundleStale({ path: dir })
    return { writer: pathToFileURL(writer), reader: pathToFileURL(reader) }
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

  const Workers = Layer.unwrap(
    Effect.map(workerEntries(options), (entries) => {
      const WriterLive = Layer.effect(Writer, RpcClient.make(WriteOps)).pipe(
        Layer.provide(RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 })),
        Layer.provide(workers(entries.writer, { dbPath, binLimits: options.binLimits ?? defaultBinLimits }))
      )
      // Readers open read-only connections, so the file must exist and be migrated first.
      const ReaderLive = Layer.unwrap(
        Effect.gen(function* () {
          const writer = yield* Writer
          yield* writer.Ready()
          return Layer.effect(Reader, RpcClient.make(ReadOps)).pipe(
            Layer.provide(ReaderPool.layer(options.readers)),
            Layer.provide(workers(entries.reader, { dbPath }))
          )
        })
      )
      return ReaderLive.pipe(Layer.provideMerge(WriterLive))
    })
  )

  return Workers.pipe(Layer.provide(Guards))
}
