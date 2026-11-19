import { expect, it } from "vitest"
import { Effect, Scope, Exit } from "effect"
import { PluginFault } from "@dreamspan/shared/pluginFault.ts"
import { registerBuiltinMacros } from "@dreamspan/shared/macros/builtins.ts"
import { makeMacroRegistry, type MacroEntry } from "@dreamspan/shared/macros/registry.ts"
import { expand } from "@dreamspan/shared/macros/expand.ts"
import type { MacroContext } from "@dreamspan/shared/macros/context.ts"
import { adaptMacroV1 } from "../src/plugins/macroAdapter.ts"
import { builtinCopies } from "../src/plugins/builtins.ts"

const context: MacroContext = {
  names: { user: "Aster", char: "Mira" },
  now: 1791727509123,
  timeZone: "UTC",
  card: {
    description: "{{char}} is brave",
    personality: "curious",
    systemPrompt: "Main for {{char}}",
    firstMessage: "Hello {{user}}",
    alternateGreetings: ["Hi"]
  },
  messages: [{ text: "Only preceding text", fromUser: true, sentAt: 1791727409123 }],
  variables: { local: { x: "2" }, global: { y: "3" } },
  original: "Original",
  summary: "Synthetic summary",
  speaker: "Mira",
  direction: "Brief",
  pickSeed: "synthetic",
  model: "synthetic",
  input: "Input",
  outlets: { key: "Lore" },
  maxContextTokens: 8192,
  maxResponseTokens: 1024
}
const run = (
  registry: ReturnType<typeof makeMacroRegistry>,
  text: string,
  extra: Partial<Parameters<typeof expand>[0]> = {}
) => expand({ text, context, registry, origin: { kind: "preset" }, purpose: "assembly", random: () => 0.25, ...extra })
const setup = () =>
  Effect.gen(function* () {
    const registry = makeMacroRegistry()
    yield* registerBuiltinMacros(registry)
    return registry
  })

it("every shipped macro and alias has a copy adapter; synthetic corpus preserves output, effects and frozen draws", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const original = yield* setup(),
          copied = makeMacroRegistry()
        for (const entry of original.list()) {
          expect(
            builtinCopies.some(
              (p) =>
                p.registry === "macros" &&
                (p.id === entry.id || ("aliases" in p && p.aliases.includes(entry.id as never)))
            )
          ).toBe(true)
          yield* copied.register(
            adaptMacroV1(
              entry,
              () => true,
              () => {
                throw new PluginFault("corpus-" + entry.id)
              }
            )
          )
        }
        const corpus = [
          ...original.list().map(
            (m) =>
              `{{${m.name}${
                m.minArgs
                  ? "::" +
                    (m.args ?? [])
                      .slice(0, m.minArgs)
                      .map((arg) =>
                        arg.integer
                          ? "2"
                          : arg.name === "left" || arg.name === "right"
                            ? "2026-10-11"
                            : arg.name === "formula"
                              ? "3d6"
                              : arg.name === "format"
                                ? "YYYY-MM-DD"
                                : "x"
                      )
                      .join("::")
                  : ""
              }}}`
          ),
          "{{if::{{getvar::x}}}}yes {{char}}{{else}}no{{/if}}",
          "{{setvar::x::4}}{{addvar::x::2}}{{getvar::x}} {{getglobalvar::y}}",
          "{{description}} {{charPrompt}}",
          "{{random::red::blue}} {{pick::red::blue}} {{roll::3d6+2}} {{datetimeformat::YYYY-MM-DD}}",
          "{{setvarkey::arr::0::ok}}{{getvarkey::arr::0}}",
          "{{reverse::a😀bc}} {{space::3}}{{newline::2}}"
        ]
        for (const text of corpus) {
          expect(run(copied, text), text).toEqual(run(original, text))
          const first = run(original, text)
          if (first._tag === "Expanded")
            expect(run(copied, text, { frozen: first.frozen }), text).toEqual(
              run(original, text, { frozen: first.frozen })
            )
        }
      })
    )
  ))

it("the macro contract has no future/branch/note/settings queries or credential fields, and retained calls revoke", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        let enabled = true
        let retained: (() => string) | undefined
        const base = registry.get("char")!
        const attacker = adaptMacroV1(
          {
            ...base,
            handler: (call) => {
              expect(Object.keys(call).sort()).toEqual(
                [
                  "args",
                  "charge",
                  "contentHash",
                  "context",
                  "expandTemplate",
                  "flags",
                  "isScoped",
                  "list",
                  "lookup",
                  "macrosIn",
                  "markVolatile",
                  "name",
                  "offset",
                  "once",
                  "random",
                  "resolve",
                  "variables"
                ].sort()
              )
              expect(call.context.messages?.map((m) => m.text)).toEqual(["Only preceding text"])
              expect(call.context).not.toHaveProperty("settings")
              expect(call.context).not.toHaveProperty("credentials")
              expect(call.context.card).not.toHaveProperty("ownTurnNotes")
              expect(call.context.messages?.[0]).not.toHaveProperty("otherBranch")
              expect(call.lookup("char")).not.toHaveProperty("handler")
              retained = () => call.resolve("{{char}}")
              return "safe"
            }
          },
          () => enabled,
          () => {
            throw new PluginFault("attack")
          }
        )
        yield* registry.register(attacker)
        expect(
          run(registry, "{{char}}", {
            context: {
              ...context,
              settings: { apiKey: "synthetic" },
              credentials: "synthetic",
              card: { ...context.card, ownTurnNotes: "hidden" },
              messages: [{ ...context.messages![0]!, otherBranch: "hidden" }]
            } as unknown as MacroContext
          })
        ).toMatchObject({ text: "safe" })
        enabled = false
        expect(() => retained!()).toThrow("disabled")
      })
    )
  ))

it("undeclared ambient randomness invalidates cache reuse even for frozen values", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        const entry = registry.get("char")!
        yield* registry.register(
          adaptMacroV1(
            { ...entry, handler: () => String(Math.random()) },
            () => true,
            () => {
              throw new PluginFault("random")
            }
          )
        )
        let reads = 0
        run(registry, "{{char}}", { onVolatileRead: () => reads++ })
        run(registry, "{{char}}", { onVolatileRead: () => reads++ })
        expect(reads).toBe(2)
        const random = registry.get("random")!
        yield* registry.register(
          adaptMacroV1(
            random,
            () => true,
            () => {
              throw new PluginFault("random")
            }
          )
        )
        const first = run(registry, "{{random::a::b}}")
        if (first._tag !== "Expanded") throw new Error("expansion failed")
        reads = 0
        run(registry, "{{random::a::b}}", { frozen: first.frozen, onVolatileRead: () => reads++ })
        expect(reads).toBeGreaterThan(0)
      })
    )
  ))

it("projects nested macro context before reading fields outside the contract", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        const unexpected = () => {
          throw new Error("A private host field was read")
        }
        const names = { ...context.names }
        const card = { ...context.card }
        const message = { ...context.messages![0]! }
        for (const [target, key] of [
          [names, "settings"],
          [card, "ownTurnNotes"],
          [message, "otherBranch"]
        ] as const)
          Object.defineProperty(target, key, { enumerable: true, get: unexpected })
        yield* registry.register(
          adaptMacroV1(
            { ...registry.get("char")!, handler: (call) => call.context.names.char },
            () => true,
            () => {
              throw new PluginFault("private-field")
            }
          )
        )
        expect(run(registry, "{{char}}", { context: { ...context, names, card, messages: [message] } })).toMatchObject({
          text: "Mira"
        })
      })
    )
  ))

it("cached message projections stay detached and refresh changed fields, additions and deletions", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        const message: { text: string; fromUser: boolean; sentAt?: number } = { text: "first", fromUser: true }
        const seen: Array<MacroContext> = []
        yield* registry.register(
          adaptMacroV1(
            {
              ...registry.get("char")!,
              handler: (call) => {
                seen.push(call.context)
                expect(Object.isFrozen(call.context.messages![0])).toBe(true)
                return call.context.messages![0]!.text
              }
            },
            () => true,
            () => {
              throw new PluginFault("cache")
            }
          )
        )
        const read = () => run(registry, "{{char}}", { context: { ...context, messages: [message] } })
        expect(read()).toMatchObject({ text: "first" })
        message.text = "second"
        message.sentAt = 2
        expect(read()).toMatchObject({ text: "second" })
        expect(seen[0]!.messages![0]).toEqual({ text: "first", fromUser: true })
        expect(seen[1]!.messages![0]).toHaveProperty("sentAt", 2)
        delete message.sentAt
        read()
        expect(seen[2]!.messages![0]).not.toHaveProperty("sentAt")
        expect(seen[1]!.messages![0]).toHaveProperty("sentAt", 2)
      })
    )
  ))

it.each([
  () => {
    throw new Error("synthetic")
  },
  () => {
    while (true) {
      /* deadline */
    }
  }
])("throwing or looping macro fails promptly for suspension; closing scope restores original", (handler) =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        const original = registry.get("char")!
        const scope = yield* Scope.make()
        let faults = 0
        yield* Scope.provide(
          registry.register(
            adaptMacroV1(
              { ...original, handler } as MacroEntry,
              () => true,
              () => {
                faults++
                throw new PluginFault("broken")
              }
            )
          ),
          scope
        )
        expect(() => run(registry, "{{char}}")).toThrow()
        expect(faults).toBe(1)
        yield* Scope.close(scope, Exit.void)
        expect(registry.get("char")).toBe(original)
        expect(run(registry, "{{char}}")).toMatchObject({ text: "Mira" })
      })
    )
  )
)

it("nested resolution attributes a fault to the failing plugin", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        const faults: string[] = []
        for (const id of ["char", "user"]) {
          const entry = registry.get(id)!
          yield* registry.register(
            adaptMacroV1(
              {
                ...entry,
                handler: (call) => {
                  if (id === "user") throw new Error("broken")
                  return call.resolve("{{user}}")
                }
              },
              () => true,
              () => {
                faults.push(id)
                throw new PluginFault(id)
              }
            )
          )
        }
        expect(() => run(registry, "{{char}}")).toThrow("rp-plugin-fault:user")
        expect(faults).toEqual(["user"])
      })
    )
  ))

it.each([
  { handler: () => "x".repeat(2_000_000) },
  { handler: () => 42 },
  { work: () => Number.NaN },
  { work: () => -1 },
  { volatile: true, accepts: () => "yes" },
  {
    handler: (call: Parameters<MacroEntry["handler"]>[0]) => {
      call.charge(Number.NaN)
      return "bad"
    }
  }
])("invalid plugin text and budget results fail for suspension (%j)", (change) =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        let faults = 0
        yield* registry.register({ ...registry.get("char")!, volatile: true })
        const first = run(registry, "{{char}}")
        if (first._tag !== "Expanded") throw new Error("expansion failed")
        yield* registry.register(
          adaptMacroV1(
            { ...registry.get("char")!, ...change } as MacroEntry,
            () => true,
            () => {
              faults++
              throw new PluginFault("invalid-result")
            }
          )
        )
        expect(() => run(registry, "{{char}}", { frozen: "accepts" in change ? first.frozen : {} })).toThrow(
          "rp-plugin-fault:invalid-result"
        )
        expect(faults).toBe(1)
      })
    )
  )
)

it("reused VM calls preserve nested resolvers, stable macro effects and changing contexts", () =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup()
        let calls = 0
        const base = registry.get("char")!
        yield* registry.register(
          adaptMacroV1(
            {
              ...base,
              // Volatile false does not imply purity: identical arguments can still write
              // variables, consume once(), or resolve a different causal expansion.
              volatile: false,
              handler: (call) => {
                calls++
                call.variables.local.add("visits", 1)
                return call.resolve("{{reverse::cba}}") + ":" + call.context.names.char + ":" + call.once("seen")
              }
            },
            () => true,
            () => {
              throw new PluginFault("reuse")
            }
          )
        )
        expect(
          run(registry, "{{char}} {{char}}", {
            context: { ...context, variables: { local: { visits: 0 }, global: {} } }
          })
        ).toMatchObject({
          text: "abc:Mira:true abc:Mira:false",
          variables: { local: { visits: 2 } }
        })
        expect(
          run(registry, "{{char}}", { context: { ...context, names: { user: "Aster", char: "Wren" } } })
        ).toMatchObject({ text: "abc:Wren:true" })
        expect(calls).toBe(3)
      })
    )
  ))
