// Synthetic plugin bootstrap installed independently in every pool worker and respawn.
import { readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { threadId } from "node:worker_threads"
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
    yield* Scope.provide(scope)(registry.disable("card-png"))
    yield* Scope.provide(scope)(
      registry.register({
        id: "card-v2-json",
        kind: "card",
        label: "Worker plugin",
        mime: "text/plain",
        extension: "txt",
        media: "none",
        write: (input) =>
          Effect.gen(function* () {
            const { directory, action } = JSON.parse(input.docJson) as { directory: string; action: string }
            yield* Effect.promise(() => writeFile(join(directory, String(threadId)), "arrived"))
            // Neither request can finish until both workers run it. No startup/timing race.
            while ((yield* Effect.promise(() => readdir(directory))).length < 2) yield* Effect.sleep(5)
            if (action === "crash") process.exit(1)
            if (action === "close") yield* Scope.close(scope, Exit.void)
            return new TextEncoder().encode(String(threadId))
          })
      })
    )
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
