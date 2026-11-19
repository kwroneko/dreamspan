import { Predicate } from "effect"
import { isMacroLimit } from "@dreamspan/shared/macros/expand.ts"
// API v1's cooperative call boundary. VM timeout bounds synchronous callbacks, not trust.
import { createContext, Script } from "node:vm"
import type { MacroCall, MacroEntry, MacroVariablesV1 } from "@dreamspan/shared/macros/registry.ts"
import type { ChatMessage } from "@dreamspan/shared/macros/context.ts"

const invoke = new Script("invoke()", { filename: "plugin-macro" })
// Bound plugin-produced text before it can enter assembly or a frozen draw.
const MAX_MACRO_TEXT = 262_144
const workSize = (size: number) => {
  if (!Number.isFinite(size) || size < 0) throw new Error("Invalid macro work")
  return size
}
const copy = <A>(value: A): A => {
  if (Array.isArray(value)) return Object.freeze(value.map(copy)) as A
  if (value !== null && typeof value === "object")
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]))) as A
  return value
}
const selected = (value: object, keys: ReadonlyArray<string>) =>
  Object.freeze(
    Object.fromEntries(
      keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, copy((value as Record<string, unknown>)[k])])
    )
  )
const MESSAGE_FIELDS = ["text", "fromUser", "system", "sentAt", "versions", "selectedVersion"] as const
// Each entry owns its cache. Compare all allowed fields so host edits never reuse stale data.
const messageProjection = () => {
  const rows = new WeakMap<ChatMessage, Readonly<Record<string, unknown>>>()
  return (message: ChatMessage) => {
    const previous = rows.get(message)
    if (
      previous &&
      MESSAGE_FIELDS.every((key) => {
        const own = Object.hasOwn(message, key)
        return own === Object.hasOwn(previous, key) && (!own || message[key] === previous[key])
      })
    )
      return previous
    const row = selected(message, MESSAGE_FIELDS)
    rows.set(message, row)
    return row
  }
}
/** Explicit fields, never spread a future assembler context into a stable plugin contract. */
const macroCallV1 = (
  call: MacroCall,
  enabled: () => boolean,
  message: ReturnType<typeof messageProjection>
): MacroCall => {
  const live = () => {
    if (!enabled()) throw new Error("Plugin is disabled")
  }
  const method =
    <A extends unknown[], B>(fn: (...args: A) => B) =>
    (...args: A): B => {
      live()
      return fn(...args)
    }
  const variables = (scope: MacroVariablesV1) =>
    Object.freeze({
      get: method((name: string) => copy(scope.get(name))),
      has: method((name: string) => scope.has(name)),
      set: method((name: string, value: string | number) => scope.set(name, value)),
      add: method((name: string, value: string | number) => scope.add(name, value)),
      delete: method((name: string) => scope.delete(name)),
      getAt: method((name: string, key: string) => copy(scope.getAt(name, key))),
      setAt: method((name: string, key: string, value: string) => scope.setAt(name, key, value))
    })
  const context: Record<string, unknown> = {}
  for (const key of [
    "variables",
    "collapseNewlines",
    "firstIncludedMessageId",
    "firstDisplayedMessageId",
    "now",
    "timeZone",
    "model",
    "input",
    "original",
    "speaker",
    "direction",
    "summary",
    "outlets",
    "maxContextTokens",
    "maxResponseTokens",
    "lastGenerationType",
    "isMobile",
    "pickSeed"
  ] as const)
    if (call.context[key] !== undefined) context[key] = copy(call.context[key])
  context.names = selected(call.context.names, ["user", "char", "group", "groupNotMuted", "notChar"])
  if (call.context.card)
    context.card = selected(call.context.card, [
      "description",
      "personality",
      "scenario",
      "persona",
      "mesExamples",
      "systemPrompt",
      "postHistoryInstructions",
      "depthPrompt",
      "creatorNotes",
      "version",
      "firstMessage",
      "alternateGreetings",
      "joinedVolatile",
      "joined"
    ])
  if (call.context.messages) context.messages = Object.freeze(call.context.messages.map(message))
  return Object.freeze({
    name: call.name,
    args: copy(call.args),
    list: copy(call.list),
    flags: call.flags,
    isScoped: call.isScoped,
    offset: call.offset,
    contentHash: call.contentHash,
    context: Object.freeze(context) as unknown as MacroCall["context"],
    resolve: method(call.resolve),
    expandTemplate: method(call.expandTemplate),
    lookup: method((name: string) => {
      const entry = call.lookup(name)
      return entry && Object.freeze({ id: entry.id, name: entry.name, minArgs: entry.minArgs, maxArgs: entry.maxArgs })
    }),
    macrosIn: method((text: string) => copy(call.macrosIn(text))),
    random: method(call.random),
    once: method(call.once),
    charge: method((size: number) => call.charge(workSize(size))),
    markVolatile: method(call.markVolatile),
    variables: Object.freeze({ local: variables(call.variables.local), global: variables(call.variables.global) })
  })
}
export const adaptMacroV1 = (entry: MacroEntry, enabled: () => boolean, fail: () => void): MacroEntry => {
  const saved = copy(entry)
  const message = messageProjection()
  // The VM only invokes a host closure. Reuse its empty realm rather than creating one
  // for every call; retain the deadline for projection, callbacks and result validation.
  // Nested resolver calls restore the enclosing invocation even when they fail.
  let pending: (() => unknown) | undefined
  const realm = createContext({ invoke: () => pending!() })
  const wrap =
    <A>(fn: (call: MacroCall, ...args: string[]) => A) =>
    (call: MacroCall, ...args: string[]): A => {
      if (!enabled()) throw new Error("Plugin is disabled")
      const previous = pending
      try {
        pending = () => fn(macroCallV1(call, enabled, message), ...args)
        return invoke.runInContext(realm, { timeout: 100 }) as A
      } catch (error) {
        if (isMacroLimit(error) || Predicate.isTagged(error, "PluginFault")) throw error
        fail()
        throw new Error("Plugin macro failed")
      } finally {
        pending = previous
      }
    }
  return Object.freeze({
    ...saved,
    cacheVolatile: true,
    handler: wrap((call) => {
      const text = saved.handler(call)
      if (typeof text !== "string" || text.length > MAX_MACRO_TEXT) throw new Error("Invalid macro text")
      return text
    }),
    accepts: wrap((call, value) => {
      if (value!.length > MAX_MACRO_TEXT) throw new Error("Invalid frozen macro text")
      const accepted = saved.accepts ? saved.accepts(call, value!) : true
      if (typeof accepted !== "boolean") throw new Error("Invalid macro acceptance")
      return accepted
    }),
    ...(saved.work ? { work: wrap((call) => workSize(saved.work!(call))) } : {})
  })
}
