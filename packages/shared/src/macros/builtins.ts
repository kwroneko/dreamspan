// The built-in macros: ST's set (public/scripts/macros/definitions/ at 06bde939), registered
// through the macro registry like a plugin's would be.
import { Effect, type Scope } from "effect"
import { characterMacros } from "./builtins/character.ts"
import { chatMacros } from "./builtins/chat.ts"
import { promptMacros } from "./builtins/prompts.ts"
import { utilityMacros } from "./builtins/utility.ts"
import { variableMacros } from "./builtins/variables.ts"
import { type MacroRegistry, type MacroSpec, registerMacro } from "./registry.ts"

const builtinMacros: ReadonlyArray<MacroSpec> = [
  ...utilityMacros,
  ...characterMacros,
  ...chatMacros,
  ...variableMacros,
  ...promptMacros
]

export const registerBuiltinMacros = (registry: MacroRegistry): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forEach(builtinMacros, (spec) => registerMacro(registry, spec), { discard: true })
