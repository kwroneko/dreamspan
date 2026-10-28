// Synthetic plugin: a stage and its provenance descriptor use the same worker module scope.
import { Effect, Schema } from "effect"
import type { InstallAssemblyModule } from "../../src/assembler/modules.ts"
import type { PluginSource } from "../../src/assembler/types.ts"
import { need } from "../../src/assembler/pipeline.ts"

const Data = Schema.Struct({ revision: Schema.String, title: Schema.String })

export const installStage: InstallAssemblyModule = (assembler) =>
  assembler.stages.register({
    id: "synthetic/context",
    run: (assembly) =>
      Effect.sync(() => {
        const book = assembly.pieces.find((piece) => piece.source.kind === "lorebook")?.source
        if (book?.kind !== "lorebook") throw new Error("missing synthetic lorebook")
        const result = need(assembly, "result")
        assembly.pieces.push({
          id: "synthetic/context",
          source: {
            kind: "synthetic/scene",
            data: { revision: book.revision, title: "Scene reference" }
          } satisfies PluginSource,
          text: "Synthetic scene details",
          messages: [result.messages.length]
        })
        assembly.result = {
          ...result,
          messages: [...result.messages, { role: "system", content: "Synthetic scene details" }]
        }
        return assembly
      })
  })

export const install: InstallAssemblyModule = (assembler) =>
  Effect.gen(function* () {
    yield* installStage(assembler)
    yield* assembler.sourceDescriptors.register({
      id: "synthetic/scene",
      describe: (source, labels) => {
        if (source.kind !== "synthetic/scene") throw new Error("wrong descriptor")
        const data = Schema.decodeUnknownSync(Data)(source.data)
        return { label: data.title, slotId: null, ...labels.linkOf(data.revision) }
      }
    })
  })

export const override: InstallAssemblyModule = (assembler) =>
  assembler.sourceDescriptors.register({
    id: "assembler",
    describe: () => ({ label: "Plugin assembler title", slotId: null })
  })
export const disable: InstallAssemblyModule = (assembler) => assembler.sourceDescriptors.disable("assembler")
