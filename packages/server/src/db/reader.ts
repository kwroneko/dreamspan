import { makeMergeReadHandlers } from "./merges.ts"
import { libraryMergePolicies, defaultLibraryMergePolicy } from "@rp/shared/forkMerge.ts"
import { stateModuleHandlers } from "./stateModules.ts"
import { moduleHandlers } from "../assembler/modules.ts"
import { providerDefinitionHandlers } from "../providers/definitions.ts"
import { makeHistoryReadHandlers } from "./historyReads.ts"
import { makeAssembler, WorkerAssembler } from "../assembler/assembler.ts"
import { makeLcmPlanningHandlers } from "./lcmPlanning.ts"
import { makeLcmReadHandlers } from "./lcmReads.ts"
import { makeLcmEnableReadHandlers } from "./lcmEnableReads.ts"
import { makeLcmUiReadHandlers } from "./lcmUiReads.ts"
// Reader worker entry point. Each reader holds one read-only connection. Under WAL,
// readers never block the writer and the writer never blocks readers.
import { workerData } from "node:worker_threads"
import { defaultBinLimits, type BinLimits } from "@rp/shared/bin.ts"
import { BinLimitDefaults } from "./binLimits.ts"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { makeAccountReadHandlers } from "./accounts.ts"
import { makeChatSetupReadHandlers } from "./chatSetupReads.ts"
import { makeAssemblyReadHandlers } from "./assemblyReads.ts"
import { readerConnection } from "./connection.ts"
import { makeEditorReadHandlers } from "./editorReads.ts"
import { makeImportReadHandlers } from "./importReads.ts"
import { makeInspectorReadHandlers } from "./inspectorReads.ts"
import { makeAgentReadHandlers } from "./agentReads.ts"
import { makeWorkshopGrantReadHandlers } from "./workshopGrants.ts"
import { makeWorkshopAttachReadHandlers } from "./workshopAttach.ts"
import { ReadOps } from "./ops.ts"
import { makeProviderReadHandlers } from "./providerReads.ts"
import { makeReadHandlers } from "./reads.ts"
import { makeStImportReadHandlers } from "./stImportReads.ts"

const { dbPath, binLimits } = workerData as { readonly dbPath: string; readonly binLimits?: BinLimits }

// A handler's defect answers its own request, so the pool (readerPool.ts) takes a Defect
// message for the protocol failing.
RpcServer.layer(ReadOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(
    ReadOps.toLayer(
      Effect.flatMap(
        libraryMergePolicies.register(defaultLibraryMergePolicy).pipe(Effect.andThen(makeAssembler)),
        (assembler) =>
          Effect.map(
            Effect.all([
              makeHistoryReadHandlers,
              makeReadHandlers.pipe(Effect.provideService(BinLimitDefaults, binLimits ?? defaultBinLimits)),
              makeProviderReadHandlers,
              makeAccountReadHandlers,
              makeImportReadHandlers,
              makeChatSetupReadHandlers,
              // --- ST data folder import (ARCHITECTURE.md §13)
              makeStImportReadHandlers,
              makeEditorReadHandlers,
              makeAssemblyReadHandlers,
              makeInspectorReadHandlers,
              makeLcmPlanningHandlers,
              makeLcmReadHandlers,
              makeLcmUiReadHandlers,
              makeLcmEnableReadHandlers,
              makeMergeReadHandlers,
              makeAgentReadHandlers,
              makeWorkshopGrantReadHandlers,
              makeWorkshopAttachReadHandlers
            ]),
            ([
              history,
              core,
              providers,
              accounts,
              imports,
              chatSetup,
              stImport,
              editor,
              assembly,
              inspector,
              planning,
              lcm,
              lcmUi,
              lcmEnable,
              merges,
              agent,
              grants,
              attached
            ]) =>
              ReadOps.of(
                stateModuleHandlers(
                  providerDefinitionHandlers(
                    moduleHandlers({
                      ...history,
                      ...core,
                      ...providers,
                      ...accounts,
                      ...imports,
                      ...chatSetup,
                      ...stImport,
                      ...editor,
                      ...assembly,
                      ...inspector,
                      ...planning,
                      ...lcm,
                      ...lcmUi,
                      ...lcmEnable,
                      ...merges,
                      ...agent,
                      ...grants,
                      ...attached
                    })
                  )
                )
              )
          ).pipe(Effect.provideService(WorkerAssembler, assembler))
      )
    )
  ),
  Layer.provide(readerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
