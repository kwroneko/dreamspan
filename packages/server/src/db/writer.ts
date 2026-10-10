// Writer worker entry point. Holds the only read-write connection to the database
// and serves WriteOps one at a time, each as one synchronous transaction.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { writerConnection } from "./connection.ts"
import { Migrations } from "./migrations.ts"
import { WriteOps } from "./ops.ts"
import { defaultBinLimits, type BinLimits } from "@rp/shared/bin.ts"
import { makeBinWriteHandlers } from "./binWrites.ts"
import { makeLibraryWriteHandlers } from "./libraryWrites.ts"
import { makeWriteHandlers } from "./writes.ts"

const { dbPath, binLimits = defaultBinLimits } = workerData as {
  readonly dbPath: string
  readonly binLimits?: BinLimits
}

RpcServer.layer(WriteOps, { concurrency: 1 }).pipe(
  Layer.provide(
    WriteOps.toLayer(
      Effect.map(
        Effect.all([
          makeWriteHandlers(binLimits),
          makeLibraryWriteHandlers(binLimits),
          makeBinWriteHandlers(binLimits)
        ]),
        ([graph, library, bin]) => WriteOps.of({ ...graph, ...library, ...bin })
      )
    )
  ),
  Layer.provide(Migrations),
  Layer.provide(writerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
