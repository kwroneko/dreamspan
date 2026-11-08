import { expect, test } from "vitest"
import { lorebookRows, replacedBy } from "../src/features/chat/lorebookRows.ts"

const base = { cards: [], cardsOff: [], listed: [], preset: [], pending: new Map<string, boolean>() }

test("every book is listed once: cards' own, the chat's in their order, then the preset's not listed", () => {
  const rows = lorebookRows({
    ...base,
    cards: ["aria", "rook"],
    cardsOff: ["rook"],
    listed: [
      { ref: "b", on: true },
      { ref: "a", on: false }
    ],
    preset: [
      { id: "a", enabled: true },
      { id: "style", enabled: false }
    ]
  })
  expect(rows.map((row) => [row.key, row.on])).toEqual([
    ["card:aria", true],
    ["card:rook", false],
    ["chat:b", true],
    ["chat:a", false],
    ["preset:style", false]
  ])
  // Off in the chat, but the preset sends it.
  expect(rows.find((row) => row.key === "chat:a")?.presetSends).toBe(true)
})

test("a book switched off stays listed, off, in its place", () => {
  const on = lorebookRows({
    ...base,
    listed: [
      { ref: "a", on: true },
      { ref: "b", on: true }
    ]
  })
  const off = lorebookRows({
    ...base,
    listed: [
      { ref: "a", on: false },
      { ref: "b", on: true }
    ]
  })
  expect(off.map((row) => row.key)).toEqual(on.map((row) => row.key))
  expect(off[0]?.on).toBe(false)
})

test("a switch shows at once and is pending until the server agrees", () => {
  const pending = new Map([["chat:a", false]])
  const before = lorebookRows({ ...base, listed: [{ ref: "a", on: true }], pending })
  expect(before[0]).toMatchObject({ on: false, pending: true })
  const after = lorebookRows({ ...base, listed: [{ ref: "a", on: false }], pending })
  expect(after[0]).toMatchObject({ on: false, pending: false })
})

test("a card's own book is replaced only while its linked world file is read", () => {
  const bindings = { aria: "w" }
  expect(replacedBy("aria", bindings, [{ ref: "w", on: true }], [])).toBe("w")
  expect(replacedBy("aria", bindings, [], [{ id: "w", enabled: true }])).toBe("w")
  expect(replacedBy("aria", bindings, [{ ref: "w", on: false }], [{ id: "w", enabled: false }])).toBeNull()
  expect(replacedBy("rook", bindings, [{ ref: "w", on: true }], [])).toBeNull()
  expect(replacedBy("aria", undefined, [{ ref: "w", on: true }], [])).toBeNull()
})
