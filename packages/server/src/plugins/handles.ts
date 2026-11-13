import { Effect, Predicate, Scope, Schema, Context } from "effect"
import type { PluginManifest } from "@rp/shared/plugins.ts"
export interface RegistrationRegistry {
  readonly get: (id: string) => { readonly id: string } | undefined
  readonly list: () => ReadonlyArray<{ readonly id: string }>
  readonly register: (entry: never) => Effect.Effect<void, unknown, Scope.Scope>
  readonly disable: (id: string) => Effect.Effect<void, unknown, Scope.Scope>
}

const hidden = new Set([
  "reader",
  "writer",
  "cache",
  "env",
  "apiKey",
  "headers",
  "password",
  "passwordHash",
  "session",
  "token",
  "secret",
  "config",
  "key",
  "keyEnc",
  "headersEnc"
])
/** Fresh data for each callback. No database clients or credential-bearing transport fields. */
export const pluginArguments = (value: unknown, seen = new WeakMap<object, unknown>()): unknown => {
  if (!Predicate.isObject(value)) return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const result: Array<unknown> = []
    seen.set(value, result)
    for (const item of value) result.push(pluginArguments(item, seen))
    return Object.freeze(result)
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  seen.set(value, result)
  for (const [key, item] of Object.entries(value))
    if (!hidden.has(key) && typeof item !== "function") result[key] = pluginArguments(item, seen)
  return Object.freeze(result)
}
/** Copy registration data; functions retain closures, but never receive the kernel's live context. */
const registrationCopy = (value: unknown, fail: () => void): unknown => {
  if (Schema.isSchema(value)) return value
  if (typeof value === "function")
    return (...args: Array<unknown>) => {
      try {
        const result: unknown = value(...args.map((arg) => pluginArguments(arg)))
        if (Effect.isEffect(result))
          return Effect.scoped(
            Effect.gen(function* () {
              const scope = yield* Effect.scope
              return yield* Effect.setContext(
                result as Effect.Effect<unknown, unknown, Scope.Scope>,
                Context.make(Scope.Scope, scope)
              )
            })
          ).pipe(
            Effect.timeout("5 seconds"),
            Effect.catchCause(() =>
              Effect.sync(() => {
                fail()
                throw new Error("Plugin handler failed")
              })
            )
          )
        if (result instanceof Promise)
          return new Promise((resolve, reject) => {
            const failed = () => {
              try {
                fail()
              } catch {
                /* Keep the marker below. */
              }
              reject(new Error("Plugin handler failed"))
            }
            const timeout = setTimeout(failed, 5000)
            result.then(
              (value) => {
                clearTimeout(timeout)
                resolve(value)
              },
              () => {
                clearTimeout(timeout)
                failed()
              }
            )
          })
        return result
      } catch {
        fail()
        throw new Error("Plugin handler failed")
      }
    }
  if (Array.isArray(value)) return Object.freeze(value.map((item) => registrationCopy(item, fail)))
  if (!Predicate.isObject(value)) return value
  // Effect schemas carry executable implementation and symbols; validated by the core registry.
  if ("ast" in value || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, registrationCopy(item, fail)]))
  )
}
export const declaredHandles = (
  manifest: PluginManifest,
  side: "server" | "worker",
  registries: Readonly<Record<string, RegistrationRegistry>>,
  scope: Scope.Scope,
  claims: Map<string, string>,
  fail: () => void
): Readonly<Record<string, unknown>> => {
  const handles: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const surface of manifest.surfaces) {
    if (!surface.startsWith(side + ":")) continue
    const name = surface.slice(side.length + 1)
    const registry = registries[name]
    if (!registry) continue
    const claim = (id: string, install: Effect.Effect<void, unknown, Scope.Scope>) =>
      Scope.provide(
        Effect.gen(function* () {
          if (!id || id.length > 150 || (claims.has(`${name}:${id}`) && claims.get(`${name}:${id}`) !== manifest.id))
            throw new Error("Another plugin owns this registration")
          if (
            registry.get(id) &&
            claims.get(`${name}:${id}`) !== manifest.id &&
            !manifest.replaces.includes(`${name}:${id}`)
          )
            throw new Error("Replacement was not declared")
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              claims.set(`${name}:${id}`, manifest.id)
            }),
            () =>
              Effect.sync(() => {
                claims.delete(`${name}:${id}`)
              })
          )
          yield* install
        }),
        scope
      )
    handles[name] = Object.freeze({
      register: (entry: { readonly id: string }) =>
        Effect.suspend(() => claim(entry.id, registry.register(registrationCopy(entry, fail) as never))),
      disable: (id: string) =>
        Effect.suspend(() => {
          if (!manifest.replaces.includes(`${name}:${id}`)) throw new Error("Replacement was not declared")
          return claim(id, registry.disable(id))
        }),
      get: (id: string) => (registry.get(id) ? Object.freeze({ id }) : undefined),
      list: () => Object.freeze(registry.list().map(({ id }) => Object.freeze({ id })))
    })
  }
  return Object.freeze(handles)
}
