import { describe, expect, it } from "vitest"
import { searchTexts } from "../src/features/editor/searchCore.ts"
import { presetOrder, newestMessage } from "@rp/shared/presetOrder.ts"
const search = (changes: Partial<Parameters<typeof searchTexts>[0]> = {}) =>
  searchTexts({
    texts: ["Aria aria ARIA Ariadne", "aria waits"],
    find: "aria",
    replace: "rook",
    regex: false,
    caseSensitive: false,
    max: 500,
    ...changes
  })
describe("preset search", () => {
  it("replaces across prompts with before/after previews and preserve case", () => {
    const result = search({ preserveCase: true, wholeWord: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.replaced).toEqual(["Rook rook ROOK Ariadne", "rook waits"])
    expect(result.matches.map((m) => m.replacement)).toEqual(["Rook", "rook", "ROOK", "rook"])
  })
  it("supports regex captures and literal dollar replacements", () => {
    const result = search({ texts: ["Aria Vance"], find: "(Aria) (Vance)", regex: true, replace: "$2, $1 $$ $&" })
    expect(result.ok && result.replaced).toEqual(["Vance, Aria $ Aria Vance"])
    expect(search({ texts: ["aria"], replace: "$1" })).toMatchObject({ replaced: ["$1"] })
  })
  it("honors match case, Unicode word boundaries, invalid patterns and preview limits", () => {
    expect(search({ caseSensitive: true })).toMatchObject({
      matches: [
        { index: 0, at: 5, length: 4, replacement: "rook" },
        { index: 1, at: 0, length: 4, replacement: "rook" }
      ]
    })
    expect(search({ texts: ["ariaé aria"], wholeWord: true })).toMatchObject({ replaced: ["ariaé rook"] })
    expect(search({ regex: true, find: "(" })).toMatchObject({ ok: false })
    expect(search({ max: 1 })).toMatchObject({ truncated: true, replaced: ["rook rook rook rookdne", "rook waits"] })
  })
  it("still runs patterns that only plain (non-Unicode) regular expressions accept", () => {
    const text = [`it's a-b, say "hi"`]
    for (const find of ["\\'", "\\-", '\\"hi\\"', "a\\-b"])
      expect(search({ texts: text, find, regex: true, replace: null })).toMatchObject({ ok: true })
    expect(search({ texts: text, find: "a\\-b", regex: true, replace: "x" })).toMatchObject({
      replaced: [`it's x, say "hi"`]
    })
    expect(search({ texts: ["a-b ab-c"], find: "a\\-b", regex: true, wholeWord: true, replace: "x" })).toMatchObject({
      replaced: ["x ab-c"]
    })
  })
  it("advances empty Unicode matches without hanging", () => {
    expect(search({ texts: ["🙂"], regex: true, find: "(?:)", replace: "x" })).toMatchObject({ replaced: ["x🙂x"] })
  })
})
it("keeps off prompts in place and appends older pool entries off", () => {
  const prompts = [newestMessage, { ...newestMessage, identifier: "parked" }]
  expect(
    presetOrder(prompts, [
      { identifier: "chatHistory", enabled: true },
      { identifier: "off", enabled: false }
    ])
  ).toEqual([
    { identifier: "chatHistory", enabled: true },
    { identifier: "newestMessage", enabled: true },
    { identifier: "off", enabled: false },
    { identifier: "parked", enabled: false }
  ])
})
