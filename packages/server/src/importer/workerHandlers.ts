import { importStSettings } from "../formats/presetSettings.ts"
import { Effect } from "effect"
import * as Importers from "./importers.ts"
import * as Exporters from "./exporters.ts"
import { FormatOps, ownBuffer, type StParserSource } from "./ops.ts"
import * as StParse from "./stParse.ts"
import { prepareThumbnails, thumbnail } from "./thumbnail.ts"
import { countTokens } from "./tokenizer.ts"

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

/** Shared by the built-in worker and worker bootstraps that install plugin registrations. */
export const handlers = FormatOps.toLayer(
  Effect.gen(function* () {
    const registry = yield* Importers.Importers
    const exporters = yield* Exporters.Exporters
    return FormatOps.of({
      Thumbnail: thumbnail,
      PrepareThumbnails: prepareThumbnails,
      CountTokens: ({ encoding, texts }) => Effect.promise(() => countTokens(encoding, texts)),
      PreviewStSettings: ({ text, surface }) => Effect.sync(() => importStSettings(text, surface)),
      Parse: ({ bytes, fileName }) =>
        Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry)),
      ListExportFormats: () => Effect.sync(() => Exporters.listFormats(exporters)),
      Export: (input) => Effect.map(Exporters.exportFile(input, exporters), ownBuffer),
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
      ParseStLibraryFile: ({ bytes, fileName, expect, parser: source, textSwitches, authorNoteLore }) =>
        (source === null
          ? Effect.succeed(StParse.unreadLibraryFile(bytes))
          : Effect.flatMap(parser(source, "library-file"), (run) =>
              run(bytes, fileName, expect, textSwitches, authorNoteLore)
            )
        ).pipe(Effect.provideService(Importers.Importers, registry)),
      BuildStPersona: ({ bytes, fileName, persona, parser: source, authorNote }) =>
        source === null
          ? Effect.succeed(StParse.unreadPersona(bytes))
          : Effect.flatMap(parser(source, "persona"), (run) => run(bytes, fileName, persona, authorNote))
    })
  })
)
