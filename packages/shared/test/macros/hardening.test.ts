// Imported card text is untrusted: macro bombs must hit a limit, and no input may make the
// scanner superlinear. Each test here was checked against its bug: with the check disabled
// (or ST's regex restored) it fails or times out.
// @ts-expect-error: the shared package has no Node types; its tests run under Node.
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "../../src/macros/context.ts"
import { expand, type ExpandRequest } from "../../src/macros/expand.ts"
import { builtinRegistry, expanded } from "./support.ts"

const registry = builtinRegistry()

const request = (text: string, overrides: Partial<ExpandRequest> = {}): ExpandRequest => ({
  text,
  origin: { kind: "card" },
  registry,
  context: { names: { user: "User", char: "Character" }, now: 0, timeZone: "UTC" },
  random: () => 0.5,
  ...overrides
})

const limit = (text: string, overrides: Partial<ExpandRequest> = {}) => {
  const result = expand(request(text, overrides))
  return result._tag === "LimitExceeded" ? result.limit : "expanded"
}

const nested = (open: string, close: string, n: number) => open.repeat(n) + "x" + close.repeat(n)

describe("nesting depth", () => {
  it("bounds macros nested in arguments", () => {
    expect(expanded(request(nested("{{reverse::", "}}", 30))).text).toBe("x")
    expect(limit(nested("{{reverse::", "}}", 40))).toBe("depth")
  })

  it("bounds scoped blocks nested in each other", () => {
    expect(expanded(request(nested("{{if 1}}", "{{/if}}", 15))).text).toBe("x")
    expect(limit(nested("{{if 1}}", "{{/if}}", 40))).toBe("depth")
  })

  it("stops deep nesting before it can overflow the stack", () => {
    expect(limit("{{a::".repeat(200_000))).toBe("depth")
  })

  it("can be changed", () => {
    expect(limit(nested("{{reverse::", "}}", 5), { limits: { maxDepth: 4 } })).toBe("depth")
  })
})

describe("expansion count", () => {
  it("bounds how many macros one expansion evaluates", () => {
    expect(expanded(request("{{noop}}".repeat(10_000))).text).toBe("")
    expect(limit("{{noop}}".repeat(10_001))).toBe("expansions")
    expect(limit("{{user}}".repeat(100), { limits: { maxExpansions: 99 } })).toBe("expansions")
  })
})

describe("work and output size", () => {
  it("counts what macros produce", () => {
    const variables = { local: { a: "y".repeat(1_000_000) } }
    const context = { ...request("").context, variables }
    expect(expanded(request("{{getvar::a}}", { context })).text).toHaveLength(1_000_000)
    expect(limit("{{getvar::a}}".repeat(5), { context })).toBe("work")
  })

  it("counts pairing blocks at each level, since each level pairs its content again", () => {
    const start = performance.now()
    expect(limit(nested("{{trim}}", "{{/trim}}", 100_000))).toBe("work")
    expect(performance.now() - start).toBeLessThan(1500)
  })

  it("counts text parsed", () => {
    expect(limit("x".repeat(4_000_001))).toBe("work")
  })

  it("stops a value that doubles", () => {
    const bomb = "{{setvar::a::xxxxxxxxxx}}" + "{{setvar::a::{{getvar::a}}{{getvar::a}}}}".repeat(40)
    expect(limit(bomb)).toBe("work")
  })

  it("checks repeats and dice before building them", () => {
    expect(limit("{{space::100000000}}")).toBe("work")
    expect(limit("{{newline::99999999999}}")).toBe("work")
    expect(limit("{{roll::100000000d6}}")).toBe("work")
    expect(expanded(request("{{space::5}}{{roll::1000d6}}")).text).toMatch(/^ {5}\d+$/)
    // "L" becomes ten characters: counted before formatting, not after.
    expect(limit(`{{datetimeformat::${"L".repeat(300_000)}}}`)).toBe("work")
    expect(expanded(request("{{datetimeformat::YYYY-MM-DD x}}")).text).toBe("1970-01-01 0")
  })

  it("counts what's written to variables", () => {
    const big = "y".repeat(900_000)
    expect(limit(`{{setvar::a}}${big}{{/setvar}}` + "{{addvar::a::x}}".repeat(10))).toBe("work")
  })

  it("leaves room for large legitimate text", () => {
    const description = "word ".repeat(100_000)
    const result = expanded(
      request("{{description}}\n{{description}}", { context: { ...request("").context, card: { description } } })
    )
    expect(result.text).toHaveLength(2 * description.trim().length + 1)
  })
})

it("keeps a variable operation that fails as written instead of throwing", () => {
  const deep = "[".repeat(200_000) + "]".repeat(200_000)
  const context = { ...request("").context, variables: { local: { x: deep } } }
  const text = "{{incvar::x}}{{.x++}}{{.x += 1}}"
  expect(expanded(request(text, { context })).text).toBe(text)
})

describe("variable values", () => {
  const withVars = (local: Record<string, unknown>, messages?: ReadonlyArray<ChatMessage>) => ({
    context: { ...request("").context, variables: { local }, ...(messages ? { messages } : {}) }
  })

  it("refuses a write over 1 MB: the macro stays as written and nothing is recorded", () => {
    const over = expanded(request("{{setvar::x::{{space::1000001}}}}[{{getvar::x}}]"))
    expect(over.effects).toEqual([])
    expect(over.text.startsWith("{{setvar::x::   ")).toBe(true)
    expect(over.text.endsWith("}}[]")).toBe(true)
    expect(expanded(request("{{setvarkey::a::999999999::x}}")).text).toBe("{{setvarkey::a::999999999::x}}")
    expect(expanded(request("{{setvar::x::{{space::1000000}}}}")).effects).toHaveLength(1)
  })

  it("keeps a value small enough for later text to use it", () => {
    const first = expanded(request("{{setvar::mood::x{{space::1300000}}x}}"))
    const second = expanded(request("{{addvar::mood::x{{space::700000}}x}}", withVars(first.variables.local)))
    expect(limit("Mood: {{getvar::mood}}. Again: {{getvar::mood}}.", withVars(second.variables.local))).toBe("expanded")
  })

  it("counts each comparison's scan of a value", () => {
    const x = "z".repeat(300_000)
    expect(limit("{{.x == a}}".repeat(5), withVars({ x }))).toBe("expanded")
    expect(limit("{{.x == a}}".repeat(20), withVars({ x }))).toBe("work")
    expect(limit("{{.x || a}}".repeat(20), withVars({ x }))).toBe("work")
  })

  it("parses a JSON value once per write", () => {
    const x = JSON.stringify(Array.from({ length: 1000 }, (_, i) => i))
    const parse = vi.spyOn(JSON, "parse")
    try {
      expect(expanded(request("{{getvarkey::x::5}}".repeat(50), withVars({ x }))).text).toBe("5".repeat(50))
      expect(parse.mock.calls.filter(([text]) => text === x)).toHaveLength(1)
    } finally {
      parse.mockRestore()
    }
  })

  it("refuses padding an array past 1 MB before building it", () => {
    const stringify = vi.spyOn(JSON, "stringify")
    try {
      expect(expanded(request("{{setvarkey::a::300000::x}}")).effects).toEqual([])
      expect(stringify.mock.calls.some(([value]) => Array.isArray(value) && value.length > 200_000)).toBe(false)
    } finally {
      stringify.mockRestore()
    }
  })

  it("counts setvarkey's parse of the old value", () => {
    expect(limit("{{setvarkey::x::k::v}}".repeat(20), withVars({ x: "q".repeat(300_000) }))).toBe("work")
  })

  it("counts the messages scanned", () => {
    const messages = Array.from({ length: 100_000 }, () => ({ text: "hi", fromUser: false }))
    expect(limit("{{lastUserMessage}}".repeat(5), withVars({}, messages))).toBe("expanded")
    expect(limit("{{lastUserMessage}}".repeat(50), withVars({}, messages))).toBe("work")
    expect(limit("{{idle_duration}}".repeat(50), withVars({}, messages))).toBe("work")
  })
})

describe("linear time", () => {
  const fast = (text: string, overrides: Partial<ExpandRequest> = {}) => {
    const start = performance.now()
    const result = expand(request(text, overrides))
    expect(performance.now() - start).toBeLessThan(1500)
    return result
  }

  it("skips junk after a name in one pass", () => {
    const text = "{{a!".repeat(100_000)
    expect(fast(text)).toMatchObject({ text })
  })

  it("pairs many unclosed blocks without rescanning", () => {
    const text = "{{if x}}".repeat(100_000)
    expect(fast(text, { limits: { maxExpansions: 1_000_000 } })).toMatchObject({ text })
  })

  it("removes {{trim}} without backtracking over newlines", () => {
    expect(fast("\n".repeat(200_000) + "x{{trim}}")).toMatchObject({ text: "\n".repeat(200_000) + "x" })
  })

  it("handles runs of braces and failed starts", () => {
    expect(fast("{".repeat(500_000) + "{{user}}")).toMatchObject({ text: "{".repeat(500_000) + "User" })
    expect(fast("{{ ".repeat(200_000))).toMatchObject({ text: "{{ ".repeat(200_000) })
    expect(fast(`{{.a${"-".repeat(500_000)}}}`)).toMatchObject({ _tag: "Expanded" })
  })
})

it("never evaluates text as code", () => {
  const dir = new URL("../../src/macros/", import.meta.url)
  const files = (readdirSync(dir, { recursive: true }) as Array<string>).filter((f: string) => f.endsWith(".ts"))
  expect(files.length).toBeGreaterThan(5)
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), "utf8") as string
    expect(source, file).not.toMatch(/\beval\b|\bFunction\s*\(|new\s+Function\b|import\s*\(/)
  }
})
