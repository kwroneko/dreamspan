import { Effect, Scope } from "effect"
import { registerBuiltinMacros } from "../../src/macros/builtins.ts"
import { expand, type Expanded, type ExpandRequest } from "../../src/macros/expand.ts"
import { makeMacroRegistry, type MacroRegistry, type MacroSpec, registerMacro } from "../../src/macros/registry.ts"

const withScope = (register: (registry: MacroRegistry) => Effect.Effect<void, never, Scope.Scope>) => {
  const registry = makeMacroRegistry()
  Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(register(registry))))
  return registry
}

/** A registry with these macros registered for the rest of the test run. */
export const registryWith = (specs: ReadonlyArray<MacroSpec>): MacroRegistry =>
  withScope((registry) => Effect.forEach(specs, (spec) => registerMacro(registry, spec), { discard: true }))

export const builtinRegistry = (): MacroRegistry => withScope(registerBuiltinMacros)

/** A seeded PRNG (mulberry32), for reproducible draws and generated inputs. */
export const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** expand(), for tests that expect it to succeed: the result without its tag. */
export const expanded = (request: ExpandRequest): Omit<Expanded, "_tag"> => {
  const result = expand(request)
  if (result._tag !== "Expanded") throw new Error(`Limit exceeded: ${result.limit}`)
  const { _tag, ...rest } = result
  return rest
}
