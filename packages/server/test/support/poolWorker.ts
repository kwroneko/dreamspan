// A test reader for the reader pool: each request blocks the thread like a real query.
import { DatabaseSync } from "node:sqlite"
import { parentPort, threadId, workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { PoolOps } from "./poolOps.ts"

// From readerPool.test.ts: [0] is 1 once released, [1] counts Holds started, [2] is the
// thread holding, [3] is 1 once a CrashOnce has crashed or a DefectOnce sent its defect. A
// held start blocks before the worker serves anything.
const { gate, heldStart } = (workerData ?? {}) as { readonly gate?: Int32Array; readonly heldStart?: boolean }
if (heldStart) Atomics.wait(gate!, 0, 0)

const count = new DatabaseSync(":memory:").prepare(
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) FROM c"
)

const hold = () => {
  Atomics.store(gate!, 2, threadId)
  Atomics.add(gate!, 1, 1)
  Atomics.notify(gate!, 1)
  Atomics.wait(gate!, 0, 0)
}

RpcServer.layer(PoolOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(
    PoolOps.toLayer({
      Count: ({ n }) =>
        Effect.sync(() => {
          count.get(n)
          return threadId
        }),
      Hold: () => Effect.sync(hold),
      ListForks: () => Effect.sync(hold),
      ShellMaterialize: () => Effect.sync(hold),
      GetDisplayPrefs: () => Effect.succeed(threadId),
      ListStImports: () => Effect.succeed(threadId),
      HoldThenCrash: () =>
        Effect.sync(() => {
          hold()
          process.exit(1)
        }),
      Crash: () => Effect.sync(() => process.exit(1)),
      CrashOnce: () =>
        Effect.sync(() => {
          if (Atomics.compareExchange(gate!, 3, 0, 1) === 0) process.exit(1)
          return threadId
        }),
      // As the RPC server frames its messages (NodeWorkerRunner).
      StrayExit: () =>
        Effect.sync(() => {
          parentPort!.postMessage([1, { _tag: "Exit", requestId: "stray", exit: { _tag: "Success", value: 0 } }])
          return threadId
        }),
      DefectOnce: () =>
        Effect.suspend(() => {
          if (Atomics.compareExchange(gate!, 3, 0, 1) !== 0) return Effect.succeed(threadId)
          parentPort!.postMessage([1, { _tag: "Defect", defect: "a protocol failure" }])
          return Effect.never
        })
    })
  ),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
