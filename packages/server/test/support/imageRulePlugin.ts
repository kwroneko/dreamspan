// Synthetic plugin: an image rule of its own, a stage that sends only the first image of each message.
import { Effect } from "effect"
import type { InstallAssemblyModule } from "../../src/assembler/modules.ts"
import { need } from "../../src/assembler/pipeline.ts"

export const install: InstallAssemblyModule = (assembler) =>
  assembler.stages.register({
    id: "synthetic/first-image",
    run: (assembly) =>
      Effect.sync(() => {
        const result = need(assembly, "result")
        assembly.result = {
          ...result,
          messages: result.messages.map((m) =>
            m.images && m.images.length > 1 ? { ...m, images: m.images.slice(0, 1) } : m
          )
        }
        return assembly
      })
  })

/** A stage that adds an image of its own to the last message: the media named by this module URL's `media`. */
export const portrait: InstallAssemblyModule = (assembler) =>
  assembler.stages.register({
    id: "synthetic/portrait",
    run: (assembly) =>
      Effect.sync(() => {
        const mediaId = new URL(import.meta.url).searchParams.get("media")!
        const result = need(assembly, "result")
        const last = result.messages.length - 1
        assembly.result = {
          ...result,
          messages: result.messages.map((m, i) =>
            i === last ? { ...m, images: [...(m.images ?? []), { mediaId }] } : m
          )
        }
        return assembly
      })
  })
