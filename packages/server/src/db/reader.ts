// Reader worker entry point. Each reader holds one read-only connection. Under WAL,
// readers never block the writer and the writer never blocks readers.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { makeAccountReadHandlers } from "./accounts.ts"
import { makeChatSetupReadHandlers } from "./chatSetupReads.ts"
import { makeAssemblyReadHandlers } from "./assemblyReads.ts"
import { readerConnection } from "./connection.ts"
import { makeEditorReadHandlers } from "./editorReads.ts"
import { makeImportReadHandlers } from "./importReads.ts"
import { ReadOps } from "./ops.ts"
import { makeProviderReadHandlers } from "./providerReads.ts"
import { makeReadHandlers } from "./reads.ts"
import { makeStImportReadHandlers } from "./stImportReads.ts"

const { dbPath } = workerData as { readonly dbPath: string }

// A handler's defect answers its own request, so the pool (readerPool.ts) takes a Defect
// message for the protocol failing.
RpcServer.layer(ReadOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(
    ReadOps.toLayer(
      Effect.map(
        Effect.all([
          makeReadHandlers,
          makeProviderReadHandlers,
          makeAccountReadHandlers,
          makeImportReadHandlers,
          makeChatSetupReadHandlers,
          // --- ST data folder import (ARCHITECTURE.md §13)
          makeStImportReadHandlers,
          makeEditorReadHandlers,
          makeAssemblyReadHandlers
        ]),
        ([core, providers, accounts, imports, chatSetup, stImport, editor, assembly]) =>
          ReadOps.of({
            ...core,
            ...providers,
            ...accounts,
            ...imports,
            ...chatSetup,
            ...stImport,
            ...editor,
            ...assembly
          })
      )
    )
  ),
  Layer.provide(readerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
