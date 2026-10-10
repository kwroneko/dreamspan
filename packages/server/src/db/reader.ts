// Reader worker entry point. Each reader holds one read-only connection. Under WAL,
// readers never block the writer and the writer never blocks readers.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { readerConnection } from "./connection.ts"
import { ReadOps } from "./ops.ts"
import { makeReadHandlers } from "./reads.ts"

const { dbPath } = workerData as { readonly dbPath: string }

RpcServer.layer(ReadOps, { concurrency: 1 }).pipe(
  Layer.provide(ReadOps.toLayer(makeReadHandlers)),
  Layer.provide(readerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
