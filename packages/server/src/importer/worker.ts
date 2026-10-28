import { importStSettings } from "../formats/presetSettings.ts"
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
      Effect.all([Importers.Importers, StParse.StParserRegistry]).pipe(
        Effect.map(([registry, parsers]) => {
          // A parser a plugin disabled leaves its file reported as unread.
          const parser = <K extends keyof StParse.StParsers>(id: K) => StParse.stParser(parsers, id)
          return FormatOps.of({
            Thumbnail: thumbnail,
            PreviewStSettings: ({ text, surface }) => Effect.sync(() => importStSettings(text, surface)),
            Parse: ({ bytes, fileName }) =>
              Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry)),
            Export: (input) => Effect.map(exportFile(input), ownBuffer),
            // --- ST data folder import
            ParseStChatPart: (input) =>
              parser("chat-part")?.(input) ?? Effect.succeed(StParse.unreadChatPart(input.bytes, input.carryAt)),
            ParseStSettings: ({ bytes }) =>
              parser("settings")?.(bytes) ?? Effect.succeed({ report: StParse.disabled("settings"), settings: null }),
            ParseStGroup: ({ bytes, fileName }) =>
              parser("group")?.(bytes, fileName) ?? Effect.succeed({ report: StParse.disabled("group"), group: null }),
            ParseStLibraryFile: ({ bytes, fileName, expect }) =>
              (
                parser("library-file")?.(bytes, fileName, expect) ?? Effect.succeed(StParse.unreadLibraryFile(bytes))
              ).pipe(Effect.provideService(Importers.Importers, registry)),
            BuildStPersona: ({ bytes, fileName, persona }) =>
              parser("persona")?.(bytes, fileName, persona) ?? Effect.succeed(StParse.unreadPersona(bytes))
          })
        })
      )
    )
  ),
  Layer.provide(StParse.layer),
  Layer.provide(Importers.layer),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
