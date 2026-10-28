import { stateModuleHandlers } from "./stateModules.ts"
import { makeHistoryWriteHandlers } from "./historyWrites.ts"
import { makeLcmQueueHandlers } from "./lcmQueue.ts"
import { makeLcmEnableWriteHandlers } from "./lcmEnableWrites.ts"
import { makeLcmUiWriteHandlers } from "./lcmUiWrites.ts"
import { makeLcmWriteHandlers } from "./lcmWrites.ts"
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
import { makeGenerationWriteHandlers } from "./generationWrites.ts"
import { makeLibraryWriteHandlers } from "./libraryWrites.ts"
import { makeProviderWriteHandlers } from "./providerWrites.ts"
import { makeWriteHandlers } from "./writes.ts"
import { makeStImportWriteHandlers } from "./stImportWrites.ts"

const {
  dbPath,
  binLimits = defaultBinLimits,
  draftClock = null
} = workerData as {
  readonly draftClock?: SharedArrayBuffer | null
  readonly dbPath: string
  readonly binLimits?: BinLimits
}

RpcServer.layer(WriteOps, { concurrency: 1 }).pipe(
  Layer.provide(
    WriteOps.toLayer(
      Effect.gen(function* () {
        // One bin (and draft store) for every handler group.
        const bin = makeBin(
          yield* SqlClient.SqlClient,
          binLimits,
          draftClock === null ? Date.now : () => Number(Atomics.load(new BigInt64Array(draftClock), 0))
        )
        const [graph, library, binOps, providers, accounts, chatSetup, generation] = yield* Effect.all([
          makeWriteHandlers(bin),
          makeLibraryWriteHandlers(bin),
          makeBinWriteHandlers(bin),
          makeProviderWriteHandlers,
          makeAccountWriteHandlers,
          makeChatSetupWriteHandlers(bin),
          makeGenerationWriteHandlers
        ])
        // --- ST data folder import (ARCHITECTURE.md §13)
        const stImport = yield* makeStImportWriteHandlers()
        return WriteOps.of(
          stateModuleHandlers({
            ...(yield* makeHistoryWriteHandlers),
            ...graph,
            ...library,
            ...binOps,
            ...providers,
            ...accounts,
            ...chatSetup,
            ...stImport,
            ...generation,
            ...(yield* makeLcmWriteHandlers(bin)),
            ...(yield* makeLcmQueueHandlers),
            ...(yield* makeLcmUiWriteHandlers),
            ...(yield* makeLcmEnableWriteHandlers(bin))
          })
        )
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
