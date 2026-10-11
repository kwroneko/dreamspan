import { Effect, Scope } from "effect"
import { makeMacroRegistry, type MacroRegistry, type MacroSpec, registerMacro } from "../../src/macros/registry.ts"

/** A registry with these macros registered for the rest of the test run. */
export const registryWith = (specs: ReadonlyArray<MacroSpec>): MacroRegistry => {
  const registry = makeMacroRegistry()
  Effect.runSync(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      for (const spec of specs) yield* Scope.provide(scope)(registerMacro(registry, spec))
    })
  )
  return registry
}
