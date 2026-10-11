// A format worker that dies on a file named "crash", as one would on a file that runs it
// out of memory, and parses anything else like the real one.
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import * as Importers from "../../src/importer/importers.ts"
import { FormatOps } from "../../src/importer/ops.ts"

RpcServer.layer(FormatOps, { concurrency: 1 }).pipe(
  Layer.provide(
    FormatOps.toLayer(
      Effect.map(Importers.Importers, (registry) =>
        FormatOps.of({
          Parse: ({ bytes, fileName }) =>
            fileName === "crash"
              ? Effect.sync(() => process.exit(1))
              : Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry))
        })
      )
    )
  ),
  Layer.provide(Importers.layer),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
