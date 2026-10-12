// Writer worker entry point. Holds the only read-write connection to the database
// and serves WriteOps one at a time, each as one synchronous transaction.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { writerConnection } from "./connection.ts"
import { Migrations } from "./migrations.ts"
import { WriteOps } from "./ops.ts"
import { defaultBinLimits, type BinLimits } from "@rp/shared/bin.ts"
import { makeAccountWriteHandlers } from "./accounts.ts"
import { makeBin } from "./bin.ts"
import { makeBinWriteHandlers } from "./binWrites.ts"
import { makeChatSetupWriteHandlers } from "./chatSetupWrites.ts"
import { makeLibraryWriteHandlers } from "./libraryWrites.ts"
import { makeProviderWriteHandlers } from "./providerWrites.ts"
import { makeWriteHandlers } from "./writes.ts"
import { makeStImportWriteHandlers } from "./stImportWrites.ts"

const { dbPath, binLimits = defaultBinLimits } = workerData as {
  readonly dbPath: string
  readonly binLimits?: BinLimits
}

RpcServer.layer(WriteOps, { concurrency: 1 }).pipe(
  Layer.provide(
    WriteOps.toLayer(
      Effect.gen(function* () {
        // One bin (and draft store) for every handler group.
        const bin = makeBin(yield* SqlClient.SqlClient, binLimits)
        const [graph, library, binOps, providers, accounts, chatSetup] = yield* Effect.all([
          makeWriteHandlers(bin),
          makeLibraryWriteHandlers(bin),
          makeBinWriteHandlers(bin),
          makeProviderWriteHandlers,
          makeAccountWriteHandlers,
          makeChatSetupWriteHandlers(bin)
        ])
        // --- ST data folder import (ARCHITECTURE.md §13)
        const stImport = yield* makeStImportWriteHandlers
        return WriteOps.of({ ...graph, ...library, ...binOps, ...providers, ...accounts, ...chatSetup, ...stImport })
      })
    )
  ),
  Layer.provide(Migrations),
  Layer.provide(writerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
