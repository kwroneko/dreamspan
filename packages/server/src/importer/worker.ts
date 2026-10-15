// Format worker entry point (ARCHITECTURE.md §11.3). The parsers are synchronous and take
// up to about a second on a hostile file, so they run here, one request at a time.
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import * as Importers from "./importers.ts"
import { exportFile } from "./exporters.ts"
import { FormatOps, ownBuffer } from "./ops.ts"
import * as StParse from "./stParse.ts"
import { thumbnail } from "./thumbnail.ts"

// A handler's defect answers its own request, so the pool (db/readerPool.ts) takes a Defect
// message for the protocol failing.
RpcServer.layer(FormatOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(
    FormatOps.toLayer(
      Effect.map(Importers.Importers, (registry) =>
        FormatOps.of({
          Thumbnail: thumbnail,
          Parse: ({ bytes, fileName }) =>
            Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry)),
          Export: (input) => Effect.map(exportFile(input), ownBuffer),
          // --- ST data folder import
          ParseStChatPart: StParse.parseChatPart,
          ParseStSettings: ({ bytes }) => StParse.parseSettings(bytes),
          ParseStGroup: ({ bytes, fileName }) => StParse.parseGroup(bytes, fileName),
          ParseStLibraryFile: ({ bytes, fileName, expect }) =>
            StParse.parseLibraryFile(bytes, fileName, expect).pipe(
              Effect.provideService(Importers.Importers, registry)
            ),
          BuildStPersona: ({ bytes, fileName, persona }) => StParse.buildPersona(bytes, fileName, persona)
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
