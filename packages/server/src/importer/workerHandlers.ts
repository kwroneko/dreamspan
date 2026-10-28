import { importStSettings } from "../formats/presetSettings.ts"
import { Effect } from "effect"
import * as Importers from "./importers.ts"
import * as Exporters from "./exporters.ts"
import { FormatOps, ownBuffer } from "./ops.ts"
import * as StParse from "./stParse.ts"
import { thumbnail } from "./thumbnail.ts"

/** Shared by the built-in worker and worker bootstraps that install plugin registrations. */
export const handlers = FormatOps.toLayer(
  Effect.gen(function* () {
    const registry = yield* Importers.Importers
    const exporters = yield* Exporters.Exporters
    return FormatOps.of({
      Thumbnail: thumbnail,
      PreviewStSettings: ({ text, surface }) => Effect.sync(() => importStSettings(text, surface)),
      Parse: ({ bytes, fileName }) =>
        Importers.parseFile(bytes, fileName).pipe(Effect.provideService(Importers.Importers, registry)),
      ListExportFormats: () => Effect.sync(() => Exporters.listFormats(exporters)),
      Export: (input) => Effect.map(Exporters.exportFile(input, exporters), ownBuffer),
      // --- ST data folder import
      ParseStChatPart: StParse.parseChatPart,
      ParseStSettings: ({ bytes }) => StParse.parseSettings(bytes),
      ParseStGroup: ({ bytes, fileName }) => StParse.parseGroup(bytes, fileName),
      ParseStLibraryFile: ({ bytes, fileName, expect }) =>
        StParse.parseLibraryFile(bytes, fileName, expect).pipe(Effect.provideService(Importers.Importers, registry)),
      BuildStPersona: ({ bytes, fileName, persona }) => StParse.buildPersona(bytes, fileName, persona)
    })
  })
)
