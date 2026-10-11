// A test reader for the reader pool: each request blocks the thread like a real query.
import { DatabaseSync } from "node:sqlite"
import { threadId } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { PoolOps } from "./poolOps.ts"

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
      Crash: () => Effect.sync(() => process.exit(1))
    })
  ),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
