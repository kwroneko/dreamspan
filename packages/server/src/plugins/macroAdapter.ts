import { Predicate } from "effect"
import { isMacroLimit } from "@rp/shared/macros/expand.ts"
// API v1's cooperative call boundary. VM timeout bounds synchronous callbacks, not trust.
import { Script } from "node:vm"
import type { MacroCall, MacroEntry, MacroVariablesV1 } from "@rp/shared/macros/registry.ts"

const invoke = new Script("invoke()", { filename: "plugin-macro" })
const copy = <A>(value: A): A => {
  if (Array.isArray(value)) return Object.freeze(value.map(copy)) as A
  if (value !== null && typeof value === "object")
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]))) as A
  return value
}
/** Explicit fields, never spread a future assembler context into a stable plugin contract. */
const macroCallV1 = (call: MacroCall, enabled: () => boolean): MacroCall => {
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
    "names",
    "variables",
    "card",
    "collapseNewlines",
    "messages",
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
  const selected = (value: object, keys: ReadonlyArray<string>) =>
    Object.freeze(
      Object.fromEntries(
        keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, copy((value as Record<string, unknown>)[k])])
      )
    )
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
  if (call.context.messages)
    context.messages = Object.freeze(
      call.context.messages.map((m) =>
        selected(m, ["text", "fromUser", "system", "sentAt", "versions", "selectedVersion"])
      )
    )
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
    charge: method(call.charge),
    markVolatile: method(call.markVolatile),
    variables: Object.freeze({ local: variables(call.variables.local), global: variables(call.variables.global) })
  })
}
export const adaptMacroV1 = (entry: MacroEntry, enabled: () => boolean, fail: () => void): MacroEntry => {
  const saved = copy(entry)
  const wrap =
    <A>(fn: (call: MacroCall, ...args: string[]) => A) =>
    (call: MacroCall, ...args: string[]): A => {
      if (!enabled()) throw new Error("Plugin is disabled")
      try {
        return invoke.runInNewContext({ invoke: () => fn(macroCallV1(call, enabled), ...args) }, { timeout: 100 }) as A
      } catch (error) {
        if (isMacroLimit(error) || Predicate.isTagged(error, "PluginFault")) throw error
        fail()
        throw new Error("Plugin macro failed")
      }
    }
  return Object.freeze({
    ...saved,
    cacheVolatile: true,
    handler: wrap((call) => {
      const text = saved.handler(call)
      if (typeof text !== "string") throw new Error("Macro text required")
      return text
    }),
    ...(saved.accepts ? { accepts: wrap(saved.accepts) } : {}),
    ...(saved.work ? { work: wrap(saved.work) } : {})
  })
}
