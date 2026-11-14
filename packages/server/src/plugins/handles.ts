import { notesContextV1, notesReadContextV1 } from "../agent/tools/notes.ts"
import { historyContextV1 } from "../agent/tools/history.ts"
import { adaptMacroV1 } from "./macroAdapter.ts"
import type { MacroEntry } from "@rp/shared/macros/registry.ts"
import { Effect, Predicate, Scope, Schema, Context, Fiber } from "effect"
import type { PluginManifest } from "@rp/shared/plugins.ts"
import { builtinReplacement } from "@rp/shared/builtinParts.ts"
import { presenceContext } from "../agent/tools/presenceAdapter.ts"
import type { ToolContext } from "../agent/tools.ts"
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
  if (typeof value === "function") return undefined
  if (typeof value !== "object" || value === null) return value
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
const returnedCopy = (
  value: unknown,
  fail: () => void,
  scope: Scope.Scope,
  enabled: () => boolean,
  seen = new WeakMap<object, unknown>()
): unknown => {
  if (typeof value === "function") return registrationCopy(value, fail, scope, enabled)
  if (typeof value !== "object" || value === null || Schema.isSchema(value)) return value
  if (seen.has(value)) return seen.get(value)
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Plugin result must contain plain data")
  const result: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : (Object.create(null) as Record<string, unknown>)
  seen.set(value, result)
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(result, key, {
      value: returnedCopy(item, fail, scope, enabled, seen),
      enumerable: true,
      writable: true,
      configurable: true
    })
  return result
}
/** Copy registration data; functions retain closures, but never receive the kernel's live context. */
const registrationCopy = (
  value: unknown,
  fail: () => void,
  scope: Scope.Scope,
  enabled: () => boolean,
  argumentsOf: (args: Array<unknown>) => Array<unknown> = (args) => args.map((arg) => pluginArguments(arg))
): unknown => {
  if (Schema.isSchema(value)) return value
  if (typeof value === "function")
    return (...args: Array<unknown>) => {
      if (!enabled()) throw new Error("Plugin is disabled")
      try {
        const result: unknown = value(...argumentsOf(args))
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
            Effect.map((value) => returnedCopy(value, fail, scope, enabled)),
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
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
                if (!enabled()) {
                  reject(new Error("Plugin is disabled"))
                  return
                }
                try {
                  resolve(returnedCopy(value, fail, scope, enabled))
                } catch {
                  failed()
                }
              },
              () => {
                clearTimeout(timeout)
                failed()
              }
            )
          })
        return returnedCopy(result, fail, scope, enabled)
      } catch {
        fail()
        throw new Error("Plugin handler failed")
      }
    }
  if (Array.isArray(value)) return Object.freeze(value.map((item) => registrationCopy(item, fail, scope, enabled)))
  if (!Predicate.isObject(value)) return value
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error("Plugin descriptors must contain plain data or schemas")
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, registrationCopy(item, fail, scope, enabled)]))
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
  let enabled = true
  Effect.runSync(
    Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        enabled = false
      })
    )
  )
  const handles: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const surface of manifest.surfaces) {
    if (!surface.startsWith(side + ":")) continue
    const name = surface.slice(side.length + 1)
    const registry = registries[name]
    if (!registry) continue
    const claim = (id: string, install: Effect.Effect<void, unknown, Scope.Scope>) =>
      Scope.provide(
        Effect.gen(function* () {
          if (!enabled) throw new Error("Plugin is disabled")
          if (!id || id.length > 150 || (claims.has(`${name}:${id}`) && claims.get(`${name}:${id}`) !== manifest.id))
            throw new Error("Another plugin owns this registration")
          if (
            registry.get(id) &&
            claims.get(`${name}:${id}`) !== manifest.id &&
            !manifest.replaces.includes(`${name}:${id}`)
          )
            throw new Error("Replacement was not declared")
          if (
            (registry.get(id) || manifest.replaces.includes(`${name}:${id}`)) &&
            claims.get(`${name}:${id}`) !== manifest.id &&
            builtinReplacement(`${name}:${id}`)?.side !== side
          )
            throw new Error("This built-in still needs a copy adapter")
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
        Effect.suspend(() => {
          if (name === "providerKinds" && "secretsOf" in entry)
            throw new Error("Credential callbacks are not available in API v1")
          const descriptor = registrationCopy(entry, fail, scope, () => enabled)
          const macro = entry as MacroEntry
          let copied =
            name === "macros" && side === "worker" && typeof macro.handler === "function"
              ? adaptMacroV1(
                  {
                    ...(descriptor as MacroEntry),
                    handler: macro.handler,
                    ...(macro.accepts ? { accepts: macro.accepts } : {}),
                    ...(macro.work ? { work: macro.work } : {}),
                    replacement: { plugin: manifest.id, name: manifest.name }
                  },
                  () => enabled,
                  fail
                )
              : descriptor
          if (name === "rolloutTools" && entry.id === "set_presence" && manifest.surfaces.includes("server:presence")) {
            // The editable policy cannot reclassify state writes or introduce authorization hooks.
            const fields = new Set([
              "source",
              "id",
              "label",
              "explanation",
              "effect",
              "description",
              "parameters",
              "summarize",
              "execute"
            ])
            if (
              (entry as { effect?: unknown }).effect !== "chat_state" ||
              Object.keys(entry).some((key) => !fields.has(key))
            )
              throw new Error("Presence copies must keep the original effect and approval rules")
            const execute = (entry as { execute?: unknown }).execute
            if (typeof execute !== "function") throw new Error("Presence handler required")
            copied = {
              ...(copied as object),
              label: `${(entry as { readonly id: string; readonly label: string }).label} · ${manifest.name} (plugin)`,
              execute: registrationCopy(
                execute,
                fail,
                scope,
                () => enabled,
                (args) => [presenceContext(args[0] as ToolContext, () => enabled), pluginArguments(args[1])]
              )
            }
          }
          if (
            name === "rolloutTools" &&
            ["search_chat", "read_messages", "expand_summary", "search_summaries"].includes(entry.id)
          ) {
            const fields = new Set([
              "source",
              "id",
              "label",
              "explanation",
              "effect",
              "description",
              "parameters",
              "summarize",
              "execute"
            ])
            if (
              !manifest.surfaces.includes("server:history") ||
              (entry as { effect?: unknown }).effect !== "read" ||
              Object.keys(entry).some((k) => !fields.has(k))
            )
              throw new Error("History copies must keep the original effect, snapshots and approval rules")
            const execute = (entry as { execute?: unknown }).execute
            if (typeof execute !== "function") throw new Error("History handler required")
            const original = registry.get(entry.id) as import("../agent/tools.ts").RolloutTool | undefined
            copied = {
              ...(copied as object),
              ...(original?.snapshot ? { snapshot: original.snapshot } : {}),
              label: `${(entry as { id: string; label: string }).label} · ${manifest.name} (plugin)`,
              execute: registrationCopy(
                execute,
                fail,
                scope,
                () => enabled,
                (args) => [historyContextV1(args[0] as ToolContext, () => enabled), pluginArguments(args[1])]
              )
            }
          }
          if (name === "rolloutTools" && ["list_notes", "switch_note"].includes(entry.id)) {
            const fields = new Set([
              "source",
              "id",
              "label",
              "explanation",
              "effect",
              "description",
              "parameters",
              "summarize",
              "execute"
            ])
            if (
              !manifest.surfaces.includes("server:notes") ||
              (entry as { effect?: unknown }).effect !== (entry.id === "list_notes" ? "read" : "chat_state") ||
              Object.keys(entry).some((k) => !fields.has(k))
            )
              throw new Error("Note copies must keep the original effect and approval rules")
            const execute = (entry as { execute?: unknown }).execute
            if (typeof execute !== "function") throw new Error("Note handler required")
            copied = {
              ...(copied as object),
              label: `${(entry as { id: string; label: string }).label} · ${manifest.name} (plugin)`,
              execute: registrationCopy(
                execute,
                fail,
                scope,
                () => enabled,
                (args) => [
                  (entry.id === "list_notes" ? notesReadContextV1 : notesContextV1)(
                    args[0] as ToolContext,
                    () => enabled
                  ),
                  pluginArguments(args[1])
                ]
              )
            }
          }
          if (
            name === "rolloutTools" &&
            (["list_notes", "switch_note"].includes(entry.id) ||
              entry.id === "set_presence" ||
              ["search_chat", "read_messages", "expand_summary", "search_summaries"].includes(entry.id))
          ) {
            const tool = copied as { execute: (...args: unknown[]) => Effect.Effect<unknown, unknown> }
            const execute = tool.execute
            copied = {
              ...(copied as object),
              execute: (...args: unknown[]) =>
                Effect.map(execute(...args), (output) => {
                  if (
                    typeof output !== "object" ||
                    output === null ||
                    !("text" in output) ||
                    typeof output.text !== "string" ||
                    Object.keys(output).some((k) => k !== "text" && k !== "isError")
                  ) {
                    fail()
                    throw new Error("Story tools cannot supply receipts or effects")
                  }
                  return output
                })
            }
          }
          if (name === "rolloutTools" && entry.id === "set_presence" && !manifest.surfaces.includes("server:presence"))
            throw new Error("Presence copies must declare presence access")
          return claim(entry.id, registry.register(copied as never))
        }),
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
