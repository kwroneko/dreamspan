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
    { id: "harbor", on: true, global: false, attached: true },
    { id: "old", on: false, global: false, attached: true }
  ])
  // A global book also attached here is listed once, here, and stays on while it's attached.
  expect(sections.global).toEqual([
    { id: "almanac", on: true, global: true, attached: true },
    { id: "world", on: true, global: true, attached: false },
    { id: "tides", on: false, global: true, attached: false }
  ])
})

it("lists no global books until they're read", () => {
  expect(lorebookSections({ attached: [], detached: [], globals: null, globalsOff: [] })).toEqual({
    added: [],
    global: []
  })
})

it("keeps global use independent of an attachment and retains its detached switch", () => {
  const read = (attached: string[], detached: string[], globalsOff: string[]) =>
    lorebookSections({ attached, detached, globals: ["book"], globalsOff }).global[0]
  expect(read(["book"], [], ["book"])).toEqual({ id: "book", on: false, global: true, attached: true })
  expect(read([], ["book"], [])).toEqual({ id: "book", on: true, global: true, attached: true })
})
