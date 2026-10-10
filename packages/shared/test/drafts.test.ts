import { describe, expect, it } from "vitest"
import { applyPatch, diffPatch, invertPatch, isDestructive } from "../src/drafts.ts"

const roundTrip = (before: string, after: string) => {
  const patch = diffPatch(before, after)
  expect(applyPatch(before, patch)).toBe(after)
  expect(applyPatch(after, invertPatch(patch))).toBe(before)
  return patch
}

describe("draft patches", () => {
  it("captures just the changed region and inverts it", () => {
    expect(roundTrip("The red door.", "The blue door.")).toEqual({ start: 4, removed: "red", inserted: "blue" })
    roundTrip("", "hello")
    roundTrip("hello", "")
    roundTrip("aaaa", "aa")
    roundTrip("abc", "abc")
  })

  it("never splits a surrogate pair", () => {
    for (const [before, after] of [
      ["smile 😀 here", "smile 😃 here"],
      ["😀", "😃"],
      ["x😀", "x😀😀"],
      ["😀😀y", "😀y"]
    ] as const) {
      const patch = roundTrip(before, after)
      for (const part of [patch.removed, patch.inserted]) {
        expect(part).toBe(new TextDecoder().decode(new TextEncoder().encode(part))) // no lone surrogates
      }
    }
  })

  it("flags destructive changes such as select-all plus a keystroke", () => {
    const text = "A long paragraph the user has been writing for a while."
    expect(isDestructive(diffPatch(text, "x"), text)).toBe(true)
    expect(isDestructive(diffPatch(text, text + " More."), text)).toBe(false)
  })
})
