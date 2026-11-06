import { storageKinds } from "./storageKinds.ts"
// Trusted code references only: never accept these from chat/library content or public RPC.
// Each worker request carries the active module stack, so scope exit and respawns agree.
import { Context, Effect, Layer, Schema, Scope, Exit } from "effect"
import { RpcClient } from "effect/rpc"
import type { Headers } from "effect/http"
import { stateKeys, type StateKeyRegistrationError } from "@rp/shared/state.ts"

const ModuleSource = Schema.Struct({ id: Schema.String, module: Schema.String, exportName: Schema.String })
type ModuleSource = typeof ModuleSource.Type
const Sources = Schema.Array(ModuleSource)
const Snapshot = Schema.Struct({ modules: Sources, schemaModule: Schema.String })
const HEADER = "rp-state-modules"

/** Passing the registry also works when the worker bundles its own copy of shared/state. */
export type InstallStateModule = (
  keys: typeof stateKeys,
  kinds: typeof storageKinds
) => Effect.Effect<void, StateKeyRegistrationError, Scope.Scope>

const install = Effect.fnUntraced(function* (source: ModuleSource, validate: typeof Schema.is = Schema.is) {
  const exports = yield* Effect.promise(() => import(source.module) as Promise<Record<string, unknown>>)
  const entry = exports[source.exportName]
  if (typeof entry !== "function") throw new Error(`State module ${source.id}: missing export ${source.exportName}`)
  yield* (entry as InstallStateModule)(
    {
      ...stateKeys,
      register: (key) => stateKeys.register(key, validate(key.value as Schema.Schema<unknown>))
    },
    storageKinds
  )
})

export class StateModules extends Context.Service<
  StateModules,
  {
    readonly register: (source: ModuleSource) => Effect.Effect<void, StateKeyRegistrationError, Scope.Scope>
    readonly list: () => ReadonlyArray<ModuleSource>
  }
>()("rp/db/StateModules") {
  static readonly layer = Layer.sync(StateModules, () => {
    // Preserve the entire registration stack, including overrides of the same module id.
    // This matches the server even when an override changes which keys it installs.
    const active: Array<{ readonly source: ModuleSource }> = []
    return StateModules.of({
      register: (source) =>
        Effect.gen(function* () {
          // A failed install rolls back any partial registrations immediately.
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))
          yield* Scope.provide(install(source), scope).pipe(
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
          )
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const registration = { source }
              active.push(registration)
              return registration
            }),
            (registration) =>
              Effect.sync(() => {
                active.splice(active.indexOf(registration), 1)
              })
          )
        }),
      list: () => active.map(({ source }) => source)
    })
  })
}

/** Snapshot at execution, overwriting inherited headers on the private worker transport. */
export const stateModuleClient = <A extends object>(calls: A, modules: StateModules["Service"]): A => {
  type Call = (...args: Array<unknown>) => Effect.Effect<unknown, unknown>
  return Object.fromEntries(
    Object.entries(calls).map(([tag, call]) => [
      tag,
      (...args: Array<unknown>) =>
        Effect.suspend(() =>
          RpcClient.withHeaders((call as Call)(...args), {
            [HEADER]: JSON.stringify({ modules: modules.list(), schemaModule: import.meta.resolve("effect/Schema") })
          })
        )
    ])
  ) as A
}

/** Import/install outside the handler's synchronous database transaction. Workers run one handler at a time. */
export const stateModuleHandlers = <A extends object>(handlers: A): A => {
  type Call = (input: unknown, options: { readonly headers: Headers.Headers }) => Effect.Effect<unknown, unknown>
  return Object.fromEntries(
    Object.entries(handlers).map(([tag, call]) => [
      tag,
      (input: unknown, options: { readonly headers: Headers.Headers }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const encoded = options.headers[HEADER]
            if (encoded !== undefined) {
              const snapshot = Schema.decodeUnknownSync(Snapshot)(JSON.parse(encoded))
              if (snapshot.modules.length > 0) {
                // Dynamic plugins import the installed Effect package. Use its interpreter for
                // their schemas, even when this worker bundles another copy of Effect.
                const native = yield* Effect.promise(() => import(snapshot.schemaModule) as Promise<typeof Schema>)
                for (const source of snapshot.modules) yield* install(source, native.is)
              }
            }
            return yield* (call as Call)(input, options)
          })
        )
    ])
  ) as A
}
