// The Lorebooks tab's sections: books added to the chat, switched off ones kept while open, and globals.
import { expect, it } from "vitest"
import { lorebookSections } from "../src/features/chat/lorebookSections.ts"

it("lists attached books on, detached ones off, and each global book once with its per-chat switch", () => {
  const sections = lorebookSections({
    attached: ["harbor", "almanac"],
    detached: ["old", "harbor"],
    globals: ["almanac", "world", "tides"],
    globalsOff: ["tides"]
  })
  expect(sections.added).toEqual([
    { id: "harbor", on: true, global: false },
    { id: "almanac", on: true, global: true },
    { id: "old", on: false, global: false }
  ])
  expect(sections.global).toEqual([
    { id: "world", on: true, global: true },
    { id: "tides", on: false, global: true }
  ])
})

it("lists no global books until they're read", () => {
  expect(lorebookSections({ attached: [], detached: [], globals: null, globalsOff: [] })).toEqual({
    added: [],
    global: []
  })
})
