// A test reader for the reader pool: each request blocks the thread like a real query.
import { DatabaseSync } from "node:sqlite"
import { threadId, workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { PoolOps } from "./poolOps.ts"

// From readerPool.test.ts: [0] is 1 once released, [1] counts Holds started, [2] is the
// thread holding. A held start blocks before the worker serves anything.
const { gate, heldStart } = (workerData ?? {}) as { readonly gate?: Int32Array; readonly heldStart?: boolean }
if (heldStart) Atomics.wait(gate!, 0, 0)

const count = new DatabaseSync(":memory:").prepare(
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) FROM c"
)

RpcServer.layer(PoolOps, { concurrency: 1 }).pipe(
  Layer.provide(
    PoolOps.toLayer({
      Count: ({ n }) =>
        Effect.sync(() => {
          count.get(n)
          return threadId
        }),
      Hold: () =>
        Effect.sync(() => {
          Atomics.store(gate!, 2, threadId)
          Atomics.add(gate!, 1, 1)
          Atomics.notify(gate!, 1)
          Atomics.wait(gate!, 0, 0)
        }),
      Crash: () => Effect.sync(() => process.exit(1))
    })
  ),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
