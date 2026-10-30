import type { InstallAssemblyModule } from "../../src/assembler/modules.ts"
import { Effect } from "effect"

export const fixed: InstallAssemblyModule = (assembler) =>
  Effect.asVoid(
    assembler.imageTokens.register({
      id: "synthetic/image-tokens",
      appliesTo: () => true,
      estimate: () => ({ tokens: 42 })
    })
  )
