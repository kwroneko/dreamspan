// Format worker entry point (ARCHITECTURE.md §11.3). The parsers are synchronous and take
// up to about a second on a hostile file, so they run here, one request at a time.
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import * as Importers from "./importers.ts"
import { exportFile } from "./exporters.ts"
import { FormatOps, ownBuffer } from "./ops.ts"

RpcServer.layer(FormatOps, { concurrency: 1 }).pipe(
  Layer.provide(
    FormatOps.toLayer(
      Effect.map(Importers.Importers, (registry) =>
        FormatOps.of({
          Parse: ({ bytes, fileName }) =>
            Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry)),
          Export: (input) => Effect.map(exportFile(input), ownBuffer)
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
