// Format worker bootstrap: every worker installs the same scoped built-ins and plugins.
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Layer } from "effect"
import { RpcServer } from "effect/rpc"
import * as Importers from "./importers.ts"
import * as Exporters from "./exporters.ts"
import { FormatOps } from "./ops.ts"
import { handlers } from "./workerHandlers.ts"

// A defect answers its request without killing the worker protocol.
RpcServer.layer(FormatOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(handlers),
  Layer.provide([Importers.layer, Exporters.layer]),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
