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
  Rpc.make("CountTo", { payload: { n: Schema.Int }, success: Schema.Int, error: StorageError }),
  /** Blocks the reader's thread, as a query that runs until `release` would. */
  Rpc.make("Hold")
) {}

/**
 * A client for `size` diagnostic readers on the (already migrated) database in `dataDir`.
 * `holding` waits until a reader is blocked in a Hold, and `release` ends every Hold. The
 * scope releases them too, so a failed test leaves no thread blocked.
 */
export const diagnosticReaders = (dataDir: string, size: number) =>
  Effect.gen(function* () {
    // [0]: released when 1; [1]: Holds started.
    const gate = new Int32Array(new SharedArrayBuffer(8))
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size, concurrency: 1 }).pipe(
        Layer.provide(
          NodeWorker.layer(
            () =>
              new Worker(new URL("./diagnosticReader.ts", import.meta.url), {
                workerData: { dbPath: databaseFile(dataDir), gate }
              })
          )
        )
      )
    )
    const release = Effect.sync(() => {
      Atomics.store(gate, 0, 1)
      Atomics.notify(gate, 0)
    })
    yield* Effect.addFinalizer(() => release)
    const holding = Effect.promise(async () => {
      while (Atomics.load(gate, 1) === 0) await Atomics.waitAsync(gate, 1, 0).value
    })
    const reader = yield* RpcClient.make(DiagnosticOps).pipe(Effect.provide(protocol))
    return { reader, holding, release }
  })
