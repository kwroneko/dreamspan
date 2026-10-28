// Trusted server code only. These references never come from chat or library content.
// A reader receives a snapshot with each request, so scopes and worker respawns agree.
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { RpcClient } from "effect/rpc"
import type { Headers } from "effect/http"
import { makeRegistry, type Registry } from "../registry.ts"
import type { Assembler } from "./assembler.ts"

const ModuleSource = Schema.Struct({ id: Schema.String, module: Schema.String, exportName: Schema.String })
type ModuleSource = typeof ModuleSource.Type
const Sources = Schema.Array(ModuleSource)
const HEADER = "rp-assembly-modules"

/** A module export with this signature registers parts through the assembler's registries. */
export type InstallAssemblyModule = (assembler: Assembler) => Effect.Effect<void, never, Scope.Scope>

/** Absolute module URLs; use a new URL when the module's code changes (ESM caches it). */
export class AssemblyModules extends Context.Service<AssemblyModules, Registry<ModuleSource>>()(
  "rp/assembler/AssemblyModules"
) {
  static readonly layer = Layer.sync(AssemblyModules, () => makeRegistry<ModuleSource>())
}

const CurrentModules = Context.Reference<ReadonlyArray<ModuleSource>>("rp/assembler/CurrentModules", {
  defaultValue: () => []
})

export const withAssemblyModules = <A, E, R>(assembler: Assembler, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const modules = yield* CurrentModules
      for (const source of modules) {
        const exports = yield* Effect.promise(() => import(source.module) as Promise<Record<string, unknown>>)
        const install = exports[source.exportName]
        if (typeof install !== "function")
          throw new Error(`Assembly module ${source.id}: missing export ${source.exportName}`)
        yield* (install as InstallAssemblyModule)(assembler)
      }
      return yield* effect
    })
  )

/** Add the server registry's current snapshot at execution, overriding inherited headers. */
export const moduleClient = <A extends object>(calls: A, modules: Registry<ModuleSource>): A => {
  type Call = (...args: Array<unknown>) => Effect.Effect<unknown, unknown>
  return Object.fromEntries(
    Object.entries(calls).map(([tag, call]) => [
      tag,
      (...args: Array<unknown>) =>
        Effect.suspend(() =>
          RpcClient.withHeaders((call as Call)(...args), { [HEADER]: JSON.stringify(modules.list()) })
        )
    ])
  ) as A
}

/** Apply only the worker RPC's trusted header to each handler; no process-global mutation. */
export const moduleHandlers = <A extends object>(handlers: A): A => {
  type Call = (input: unknown, options: { readonly headers: Headers.Headers }) => Effect.Effect<unknown, unknown>
  return Object.fromEntries(
    Object.entries(handlers).map(([tag, call]) => [
      tag,
      (input: unknown, options: { readonly headers: Headers.Headers }) =>
        Effect.suspend(() => {
          const encoded = options.headers[HEADER]
          const sources = encoded === undefined ? [] : Schema.decodeUnknownSync(Sources)(JSON.parse(encoded))
          return Effect.provideService((call as Call)(input, options), CurrentModules, sources)
        })
    ])
  ) as A
}
