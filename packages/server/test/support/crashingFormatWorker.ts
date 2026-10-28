// A format worker that dies on a file named "crash" and on every export, as one would on a
// file that runs it out of memory, never returns from a file named "loop", as a parser bug
// could, and parses anything else like the real one.
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import * as Importers from "../../src/importer/importers.ts"
import { FormatOps } from "../../src/importer/ops.ts"

RpcServer.layer(FormatOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(
    FormatOps.toLayer(
      Effect.map(Importers.Importers, (registry) =>
        FormatOps.of({
          PreviewStSettings: () => Effect.die("not used by this test"),
          Thumbnail: () => Effect.die("not used by this test"),
          Parse: ({ bytes, fileName }) =>
            fileName === "crash"
              ? Effect.sync(() => process.exit(1))
              : fileName === "loop"
                ? Effect.sync(() => {
                    for (;;);
                  })
                : Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry)),
          ListExportFormats: () => Effect.succeed([]),
          Export: () => Effect.sync(() => process.exit(1)),
          ParseStChatPart: () => Effect.sync(() => process.exit(1)),
          ParseStSettings: () => Effect.sync(() => process.exit(1)),
          ParseStGroup: () => Effect.sync(() => process.exit(1)),
          ParseStLibraryFile: () => Effect.sync(() => process.exit(1)),
          BuildStPersona: () => Effect.sync(() => process.exit(1))
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
