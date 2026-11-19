import { makePluginWriteHandlers } from "./pluginData.ts"
import { makeFileVersionWriteHandlers } from "./fileVersions.ts"
import { makeFileShareWriteHandlers } from "./fileShares.ts"
import { makeWorkingFolderWriteHandlers } from "./workingFolders.ts"
import { makeWorkshopEffectHandlers } from "./workshopEffects.ts"
import { makeWorkshopGrantWriteHandlers } from "./workshopGrants.ts"
import { makePersonaLockWriteHandlers } from "./personaLocks.ts"
import { installStorageKindValidation } from "./storageKinds.ts"
import { makeStImportPrefix, stImportPrefixHandlers } from "./stImportPrefix.ts"
import { stateModuleHandlers } from "./stateModules.ts"
import { providerDefinitionHandlers } from "../providers/definitions.ts"
import { makeHistoryWriteHandlers } from "./historyWrites.ts"
import { makeInsertWriteHandlers } from "./insertWrites.ts"
import { makeMoveWriteHandlers } from "./moveWrites.ts"
import { makeMergeWriteHandlers } from "./merges.ts"
import { makeThreadWriteHandlers } from "./threadWrites.ts"
import { makeNoteCopyWriteHandlers } from "./noteCopyWrites.ts"
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
import { DatabaseStartup as StartupReport, Migrations } from "./migrations.ts"
import { BrokenReferences, DatabaseStartup } from "@dreamspan/shared/databaseStartup.ts"
import { WriteOps } from "./ops.ts"
import { type OpsOf, serveOps } from "./opsOf.ts"
import { defaultBinLimits, type BinLimits } from "@dreamspan/shared/bin.ts"
import { makeAccountWriteHandlers } from "./accounts.ts"
import { makeBin } from "./bin.ts"
import { makeBinWriteHandlers } from "./binWrites.ts"
import { makeChatSetupWriteHandlers } from "./chatSetupWrites.ts"
import { makeGenerationWriteHandlers } from "./generationWrites.ts"
import { makeRolloutWriteHandlers } from "./rolloutWrites.ts"
import { makeSubagentWriteHandlers } from "./subagents.ts"
import { makeSubagentSettingWriteHandlers } from "./subagentSettings.ts"
import { makeSubagentResumeHandlers } from "./subagentResume.ts"
import { makeDecisionWriteHandlers } from "./decisions.ts"
import { makeLibraryWriteHandlers } from "./libraryWrites.ts"
import { makeAdoptWriteHandlers } from "./cardOrigins.ts"
import { makeProviderWriteHandlers } from "./providerWrites.ts"
import { makeMcpWriteHandlers } from "./mcpWrites.ts"
import { makeWriteHandlers } from "./writes.ts"
import { makeStImportWriteHandlers } from "./stImportWrites.ts"
import { makeStImportJobWriteHandlers } from "./stImportJobWrites.ts"
import { trackSummaryTouches } from "./summaryValidity.ts"
import { attributed, trackAutoRuns } from "./autoGuard.ts"

const {
  dbPath,
  binLimits = defaultBinLimits,
  draftClock = null
} = workerData as {
  readonly draftClock?: SharedArrayBuffer | null
  readonly dbPath: string
  readonly binLimits?: BinLimits
}

const handlers = Layer.unwrap(
  Effect.gen(function* () {
    // After the migrations, which make the tables it watches.
    yield* installStorageKindValidation
    yield* trackSummaryTouches(yield* SqlClient.SqlClient)
    yield* trackAutoRuns(yield* SqlClient.SqlClient)
    // One bin (and draft store) for every handler group.
    const bin = makeBin(
      yield* SqlClient.SqlClient,
      binLimits,
      draftClock === null ? Date.now : () => Number(Atomics.load(new BigInt64Array(draftClock), 0))
    )
    const [graph, library, binOps, providers, accounts, chatSetup, generation] = yield* Effect.all([
      makeWriteHandlers(bin),
      makeLibraryWriteHandlers(bin),
      makeBinWriteHandlers(bin, binLimits),
      makeProviderWriteHandlers,
      makeAccountWriteHandlers,
      makeChatSetupWriteHandlers(bin),
      makeGenerationWriteHandlers
    ])
    // --- ST data folder import (ARCHITECTURE.md §13)
    const prefix = makeStImportPrefix()
    const stImport = yield* makeStImportWriteHandlers(prefix)
    const adoption = yield* makeAdoptWriteHandlers(
      library.ImportFile,
      chatSetup.StartChat,
      library.CommitEditorDrafts,
      bin.drafts
    )
    const startup = yield* StartupReport
    const startupReport = new DatabaseStartup({
      broken: startup.broken.map((row) => new BrokenReferences(row)),
      applied: startup.applied
    })
    const served = WriteOps.of(
      providerDefinitionHandlers(
        stateModuleHandlers(
          stImportPrefixHandlers(
            {
              GetDatabaseStartup: () => Effect.succeed(startupReport),
              ...(yield* makeHistoryWriteHandlers),
              ...(yield* makeInsertWriteHandlers(bin)),
              ...(yield* makeMoveWriteHandlers(bin)),
              ...(yield* makeMergeWriteHandlers(bin)),
              // --- Parallel threads (spec/THREADS.md §5)
              ...(yield* makeThreadWriteHandlers(bin)),
              ...(yield* makeNoteCopyWriteHandlers(bin)),

              ...graph,
              ...library,
              ...binOps,
              ...providers,
              // --- MCP servers (spec/MCP.md §12)
              ...(yield* makeMcpWriteHandlers),
              ...accounts,
              ...chatSetup,
              ...(yield* makeWorkshopEffectHandlers(
                {
                  ...library,
                  ...chatSetup,
                  ...graph,
                  ...binOps,
                  ...generation,
                  ...(yield* makeHistoryWriteHandlers),
                  // A card added from a card source by the workshop (cardextools1).
                  AdoptRemoteCard: adoption.AdoptRemoteCard
                },
                bin
              )),
              ...(yield* makeWorkshopGrantWriteHandlers),
              ...(yield* makePersonaLockWriteHandlers),
              ...(yield* makePluginWriteHandlers),
              ...(yield* makeFileVersionWriteHandlers),
              ...(yield* makeFileShareWriteHandlers),
              ...(yield* makeWorkingFolderWriteHandlers),
              ...stImport,
              ...(yield* makeStImportJobWriteHandlers),
              ...generation,
              ...(yield* makeLcmWriteHandlers(bin)),
              ...(yield* makeLcmQueueHandlers),
              ...(yield* makeLcmUiWriteHandlers),
              ...(yield* makeLcmEnableWriteHandlers(bin)),
              ...(yield* makeRolloutWriteHandlers(graph.AddSelectedVersion)),
              // --- Subagents (spec/SUBAGENTS.md §11)
              ...(yield* makeSubagentWriteHandlers),
              ...(yield* makeSubagentSettingWriteHandlers),
              ...(yield* makeSubagentResumeHandlers),
              ...adoption,
              ...(yield* makeDecisionWriteHandlers(bin))
            },
            prefix
          )
        )
      )
    )
    // Each says who is writing, for the Auto runs its writes reach (db/autoGuard.ts).
    const tracked = attributed(served)
    return serveOps(WriteOps, Effect.succeed(tracked))
  })
)

RpcServer.layer<OpsOf<typeof WriteOps>>(WriteOps, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(Migrations),
  Layer.provide(writerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
