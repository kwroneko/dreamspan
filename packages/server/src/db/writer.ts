// Writer worker entry point. Holds the only read-write connection to the database
// and serves WriteOps one at a time, each as one synchronous transaction.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { writerConnection } from "./connection.ts"
import { Migrations } from "./migrations.ts"
import { WriteOps } from "./ops.ts"
import { makeWriteHandlers } from "./writes.ts"

const { dbPath } = workerData as { readonly dbPath: string }

RpcServer.layer(WriteOps, { concurrency: 1 }).pipe(
  Layer.provide(WriteOps.toLayer(makeWriteHandlers)),
  Layer.provide(Migrations),
  Layer.provide(writerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
