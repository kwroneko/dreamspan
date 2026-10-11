// The built-in macros: ST's set (public/scripts/macros/definitions/ at 06bde939), registered
// through the macro registry like a plugin's would be. Left out, so they stay as written:
// the instruct, system-prompt and context-template macros (text completion, out of scope
// per DESIGN §1.2).
import { Effect, type Scope } from "effect"
import { characterMacros } from "./builtins/character.ts"
import { chatMacros } from "./builtins/chat.ts"
import { utilityMacros } from "./builtins/utility.ts"
import { variableMacros } from "./builtins/variables.ts"
import { type MacroRegistry, type MacroSpec, registerMacro } from "./registry.ts"

const builtinMacros: ReadonlyArray<MacroSpec> = [...utilityMacros, ...characterMacros, ...chatMacros, ...variableMacros]

export const registerBuiltinMacros = (registry: MacroRegistry): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forEach(builtinMacros, (spec) => registerMacro(registry, spec), { discard: true })
