import { importStSettings } from "../formats/presetSettings.ts"
// Format worker entry point (ARCHITECTURE.md §11.3). The parsers are synchronous and take
// up to about a second on a hostile file, so they run here, one request at a time.
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import * as Importers from "./importers.ts"
import { exportFile } from "./exporters.ts"
import { FormatOps, ownBuffer, type StParserSource } from "./ops.ts"
import * as StParse from "./stParse.ts"
import { thumbnail } from "./thumbnail.ts"

/** Resolve trusted code references inside the worker, including the bundled built-in module. */
const parser = <K extends keyof StParse.StParsers>(
  source: StParserSource,
  id: K
): Effect.Effect<StParse.StParsers[K]> =>
  Effect.map(
    source.module === "rp:st-parsers"
      ? Effect.succeed<Record<string, unknown>>({ ...StParse.builtinParsers })
      : Effect.promise(() => import(source.module) as Promise<Record<string, unknown>>),
    (exports) => {
      const run = exports[source.exportName]
      if (typeof run !== "function")
        throw new Error(`ST parser ${id}: ${source.module} has no function ${source.exportName}`)
      return run as StParse.StParsers[K]
    }
  )

// A handler's defect answers its own request, so the pool (db/readerPool.ts) takes a Defect
// message for the protocol failing.
RpcServer.layer(FormatOps, { concurrency: 1, disableFatalDefects: true }).pipe(
  Layer.provide(
    FormatOps.toLayer(
      Effect.map(Importers.Importers, (registry) =>
        FormatOps.of({
          Thumbnail: thumbnail,
          PreviewStSettings: ({ text, surface }) => Effect.sync(() => importStSettings(text, surface)),
          Parse: ({ bytes, fileName }) =>
            Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry)),
          Export: (input) => Effect.map(exportFile(input), ownBuffer),
          // --- ST data folder import. Each job carries the registration selected by the server.
          ParseStChatPart: ({ parser: source, ...input }) =>
            source === null
              ? Effect.succeed(StParse.unreadChatPart(input.bytes, input.carryAt))
              : Effect.flatMap(parser(source, "chat-part"), (run) => run(input)),
          ParseStSettings: ({ bytes, parser: source }) =>
            source === null
              ? Effect.succeed({ report: StParse.disabled("settings"), settings: null })
              : Effect.flatMap(parser(source, "settings"), (run) => run(bytes)),
          ParseStGroup: ({ bytes, fileName, parser: source }) =>
            source === null
              ? Effect.succeed({ report: StParse.disabled("group"), group: null })
              : Effect.flatMap(parser(source, "group"), (run) => run(bytes, fileName)),
          ParseStLibraryFile: ({ bytes, fileName, expect, parser: source }) =>
            (source === null
              ? Effect.succeed(StParse.unreadLibraryFile(bytes))
              : Effect.flatMap(parser(source, "library-file"), (run) => run(bytes, fileName, expect))
            ).pipe(Effect.provideService(Importers.Importers, registry)),
          BuildStPersona: ({ bytes, fileName, persona, parser: source }) =>
            source === null
              ? Effect.succeed(StParse.unreadPersona(bytes))
              : Effect.flatMap(parser(source, "persona"), (run) => run(bytes, fileName, persona))
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
