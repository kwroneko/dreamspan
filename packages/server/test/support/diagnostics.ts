// A test-only reader pool serving a CPU-bound query, to show that a slow query in a
// reader worker doesn't block the main thread. It opens the same read-only connection
// as the production readers (diagnosticReader.ts is the worker entry).
import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { Rpc, RpcClient, RpcGroup } from "effect/rpc"
import { databaseFile } from "../../src/db/connection.ts"
import { StorageError } from "../../src/db/ops.ts"

export class DiagnosticOps extends RpcGroup.make(
  /** A CPU-bound query of `n` steps that touches no table. */
  Rpc.make("CountTo", { payload: { n: Schema.Int }, success: Schema.Int, error: StorageError })
) {}

/** A client for `size` diagnostic readers on the (already migrated) database in `dataDir`. */
export const diagnosticReaders = (dataDir: string, size: number) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size, concurrency: 1 }).pipe(
        Layer.provide(
          NodeWorker.layer(
            () =>
              new Worker(new URL("./diagnosticReader.ts", import.meta.url), {
                workerData: { dbPath: databaseFile(dataDir) }
              })
          )
        )
      )
    )
    return yield* RpcClient.make(DiagnosticOps).pipe(Effect.provide(protocol))
  })
