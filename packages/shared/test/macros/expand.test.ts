import { describe, expect, it } from "vitest"
import type { MacroContext } from "../../src/macros/context.ts"
import { expand, type ExpandRequest, type TextOrigin } from "../../src/macros/expand.ts"
import { builtinRegistry, seeded } from "./support.ts"

const registry = builtinRegistry()
/** 2026-10-11 14:05:09 UTC. */
const NOW = 1791727509123

const context: MacroContext = {
  names: { user: "Alice", char: "Mira" },
  now: NOW,
  timeZone: "UTC",
  card: { description: "{{char}} rolls {{roll::1d100}}." }
}

const request = (text: string, origin: TextOrigin, overrides: Partial<ExpandRequest> = {}): ExpandRequest => ({
  text,
  origin,
  registry,
  context,
  random: seeded(1),
  ...overrides
})

const PRESET: TextOrigin = { kind: "preset" }

describe("expansion depends on where the text came from", () => {
  const text = "Hi {{user}}, I'm {{char}}. <USER>"
  it.each<readonly [TextOrigin, string]>([
    [{ kind: "card" }, "Hi Alice, I'm Mira. Alice"],
    [{ kind: "preset" }, "Hi Alice, I'm Mira. Alice"],
    [{ kind: "user", macroMode: "verbatim" }, text],
    [{ kind: "user", macroMode: "template" }, "Hi Alice, I'm Mira. Alice"],
    [{ kind: "model", displayRule: false }, text],
    [{ kind: "model", displayRule: true }, "Hi Alice, I'm Mira. Alice"]
  ])("%j", (origin, output) => {
    expect(expand(request(text, origin)).text).toBe(output)
  })

  it("leaves verbatim text exactly as it is, escapes included", () => {
    const raw = "\\{\\{x\\}\\} {{trim}} {{random::a::b}}"
    expect(expand(request(raw, { kind: "model", displayRule: false }))).toEqual({
      text: raw,
      frozen: {},
      effects: [],
      variables: { local: {}, global: {} }
    })
  })
})

it("resolves card text against the context at its position, until it's sent", () => {
  const greeting = "Welcome, {{user}}."
  expect(expand(request(greeting, { kind: "card" })).text).toBe("Welcome, Alice.")
  const later = { ...context, names: { ...context.names, user: "Bob" } }
  expect(expand(request(greeting, { kind: "card" }, { context: later })).text).toBe("Welcome, Bob.")
})

describe("freezing", () => {
  it("returns the values it drew, and reuses them for an identical re-expansion", () => {
    const text = "{{random::a::b::c::d}} {{roll::1d1000}} {{pick::x::y::z}} {{time}} {{datetimeformat::ss.SSS}}"
    const first = expand(request(text, PRESET, { random: seeded(1) }))
    expect(Object.keys(first.frozen)).toHaveLength(5)
    const fresh = expand(request(text, PRESET, { random: seeded(2), context: { ...context, now: NOW + 61_234 } }))
    expect(fresh.text).not.toBe(first.text)
    const again = expand(
      request(text, PRESET, { random: seeded(2), context: { ...context, now: NOW + 61_234 }, frozen: first.frozen })
    )
    expect(again).toEqual(first)
  })

  it("draws again where the arguments changed", () => {
    const first = expand(request("{{random::{{user}}::x}}", PRESET, { random: () => 0 }))
    expect(first.text).toBe("Alice")
    const renamed = { ...context, names: { ...context.names, user: "Bob" } }
    const again = expand(
      request("{{random::{{user}}::x}}", PRESET, { context: renamed, frozen: first.frozen, random: () => 0 })
    )
    expect(again.text).toBe("Bob")
  })

  it("keeps repeated draws at one site apart", () => {
    const text = "{{if {{random::0::1}}}}{{random::0::1}}{{else}}{{random::0::1}}{{/if}}"
    const first = expand(request(text, PRESET, { random: seeded(7) }))
    expect(Object.keys(first.frozen)).toHaveLength(2)
    expect(expand(request(text, PRESET, { random: seeded(8), frozen: first.frozen }))).toEqual(first)
  })

  it("freezes draws inside card fields under the field's name", () => {
    const first = expand(request("{{description}}", PRESET, { random: seeded(3) }))
    expect(Object.keys(first.frozen)).toEqual([expect.stringMatching(/^card\.description@/)])
    expect(expand(request("{{description}}", PRESET, { random: seeded(4), frozen: first.frozen }))).toEqual(first)
  })

  it("draws again for stored entries that aren't strings, and never reads inherited ones", () => {
    const [key] = Object.keys(expand(request("{{random::a::b}}", PRESET)).frozen)
    const frozen = JSON.parse(`{"__proto__": {"polluted": "yes"}, ${JSON.stringify(key)}: 5}`) as Record<string, string>
    const result = expand(request("{{random::a::b}}", PRESET, { frozen, random: () => 0 }))
    expect(result).toMatchObject({ text: "a", frozen: { [key!]: "a" } })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const inherited = Object.create({ [key!]: "b" }) as Record<string, string>
    expect(expand(request("{{random::a::b}}", PRESET, { frozen: inherited, random: () => 0 })).text).toBe("a")
  })
})

describe("properties", () => {
  const PIECES = [
    "{{random::a::b::c}}",
    "{{roll 1d20}}",
    "{{pick::x::y}}",
    "{{time}}",
    "{{isodate}} ",
    "{{user}}",
    " text ",
    "{{if {{random::0::1}}}}A{{random::p::q}}{{else}}B{{roll::d6}}{{/if}}",
    "{{datetimeformat::ss.SSS}}",
    "{{description}}",
    "{{random a,b}}",
    "{{reverse}}{{random::xy::zw}}{{/reverse}}"
  ]

  it("re-expanding with the frozen values gives the same text, whatever the new draws", () => {
    const pick = seeded(42)
    for (let i = 0; i < 300; i++) {
      const text = Array.from(
        { length: 1 + Math.floor(pick() * 8) },
        () => PIECES[Math.floor(pick() * PIECES.length)]
      ).join("")
      const first = expand(request(text, PRESET, { random: seeded(i) }))
      const later = { ...context, now: NOW + Math.floor(pick() * 1e9) }
      const again = expand(request(text, PRESET, { random: seeded(i + 1000), context: later, frozen: first.frozen }))
      expect(again, text).toEqual(first)
    }
  })

  it("leaves text without macros unchanged", () => {
    const pick = seeded(9)
    const alphabet = "ab {}:|.$#!/\n\t-é"
    for (let i = 0; i < 1000; i++) {
      const text = Array.from(
        { length: Math.floor(pick() * 40) },
        () => alphabet[Math.floor(pick() * alphabet.length)]
      ).join("")
      if (text.includes("{{")) continue
      expect(expand(request(text, PRESET)).text).toBe(text)
    }
  })
})
