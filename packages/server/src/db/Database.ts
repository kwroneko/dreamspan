// Main-thread access to the database. SQLite never runs on the main thread: one writer
// worker holds the only read-write connection, and a pool of reader workers hold
// read-only connections. See ARCHITECTURE.md "Database" for why this rules out
// SQLITE_BUSY and keeps queries from blocking the event loop.
import { mkdirSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
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
}

const workers = (entry: URL, dbPath: string) =>
  NodeWorker.layer(() => new Worker(entry, { workerData: { dbPath }, name: entry.pathname.split("/").pop() }))

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

  const WriterLive = Layer.effect(Writer, RpcClient.make(WriteOps)).pipe(
    Layer.provide(RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 })),
    Layer.provide(workers(new URL("./writer.ts", import.meta.url), dbPath))
  )

  // Readers open read-only connections, so the file must exist and be migrated first.
  const ReaderLive = Layer.unwrap(
    Effect.gen(function* () {
      const writer = yield* Writer
      yield* writer.Ready()
      return Layer.effect(Reader, RpcClient.make(ReadOps)).pipe(
        Layer.provide(RpcClient.layerProtocolWorker({ size: options.readers, concurrency: 1 })),
        Layer.provide(workers(new URL("./reader.ts", import.meta.url), dbPath))
      )
    })
  )

  return ReaderLive.pipe(Layer.provideMerge(WriterLive), Layer.provide(Guards))
}
