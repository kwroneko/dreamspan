// A synthetic plugin installed in a worker bootstrap, through the production registry.
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Exit, Layer, Scope } from "effect"
import { RpcServer } from "effect/rpc"
import * as Exporters from "../../src/importer/exporters.ts"
import * as Importers from "../../src/importer/importers.ts"
import { FormatOps } from "../../src/importer/ops.ts"
import { handlers } from "../../src/importer/workerHandlers.ts"

const plugin = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* Exporters.Exporters
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const metadata = {
      kind: "card",
      label: "Synthetic text",
      mime: "text/plain",
      extension: "txt",
      media: "none"
    } as const
    yield* Scope.provide(scope)(
      registry.register({
        ...metadata,
        id: "synthetic-text",
        write: () => Effect.succeed(new TextEncoder().encode("synthetic alternative"))
      })
    )
    yield* Scope.provide(scope)(
      registry.register({
        ...metadata,
        id: "card-v2-json",
        label: "Scoped override",
        write: () =>
          Scope.close(scope, Exit.void).pipe(Effect.as(new TextEncoder().encode("overridden, then scope closed")))
      })
    )
    yield* Scope.provide(scope)(registry.disable("card-png"))
  })
)

RpcServer.layer(FormatOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(handlers),
  Layer.provide(plugin),
  Layer.provide([Exporters.layer, Importers.layer]),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
