// Preset regex scripts on V8's linear-time engine (ARCHITECTURE §13): what runs matches what
// ST's pattern matches, and what the linear engine can't run is refused, never backtracked.
import { describe, expect, it } from "vitest"
import { caseless, compile, run } from "../src/assembler/regex.ts"

const linear = (source: string) => {
  const regex = compile(source)
  if (!(regex instanceof RegExp)) throw new Error(`${source} wasn't compiled: ${regex}`)
  expect(regex.flags).toContain("l")
  return regex
}

describe("preset regex scripts", () => {
  it("rewrites a case-insensitive pattern to match the same text", () => {
    const patterns = [
      "Hello",
      "[a-f]+x",
      "[^A-Z]",
      "\\bCat\\w*",
      "\\x41b",
      "(?<Name>bob)\\s",
      "a{2,3}B",
      "[\\x41-\\x43q]"
    ]
    const texts = [
      "hello HELLO HeLLo",
      "ABCDEFX abcx",
      "Q",
      "the CATS caterpillar",
      "AB ab aB",
      "BOB bob ",
      "AAB aab",
      "aBcQ abcq"
    ]
    for (const pattern of patterns) {
      const original = new RegExp(pattern, "gi")
      const rewritten = new RegExp(caseless(pattern), "g")
      for (const text of texts) {
        expect(
          [...text.matchAll(rewritten)].map((m) => m[0]),
          `${pattern} on ${text}`
        ).toEqual([...text.matchAll(original)].map((m) => m[0]))
      }
    }
  })

  it("runs ST's patterns on the linear engine, flags and all", () => {
    expect(run(linear("/<thinking>[\\s\\S]*?<\\/thinking>/gi"), "", [], "a<THINKING>x</thinking>b")).toBe("ab")
    expect(run(linear("/(?<who>mira)/giu"), "[$<who>]", [], "Mira and MIRA")).toBe("[Mira] and [MIRA]")
    // The catastrophic pattern runs, in linear time, rather than being refused.
    expect(run(linear("/(a+)+$/gi"), "x", [], `${"a".repeat(5000)}!`)).toBe(`${"a".repeat(5000)}!`)
  })

  it("refuses what only a backtracking engine can run", () => {
    for (const source of ["/(a)\\1/g", "/(?=a)a/", "/(a{1,30}){1,30}$/", "/\\p{L}+/u"]) {
      expect(compile(source), source).toBe("unsafe")
    }
    expect(compile("/[/")).toBeNull()
    // ST takes an unknown flag for part of the pattern, as written.
    expect(String(compile("/[a-z]/v"))).toBe("/\\/[a-z]\\/v/l")
  })
})
