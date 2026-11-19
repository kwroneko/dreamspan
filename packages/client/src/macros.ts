import { registerBuiltinMacros } from "@dreamspan/shared/macros/builtins.ts"
import { makeMacroRegistry } from "@dreamspan/shared/macros/registry.ts"
import { Effect, Scope } from "effect"

/** Shared by display and editor highlighting; plugin overrides use the same registry. */
export const macroRegistry = makeMacroRegistry()
Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(registerBuiltinMacros(macroRegistry))))
