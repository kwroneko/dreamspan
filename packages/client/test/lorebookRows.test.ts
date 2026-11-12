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

test("a card's own book is replaced by the book the assembler would pick: linked, or named as its world", () => {
  const aria = { entity: "aria", world: "Tides" }
  const none = () => undefined
  const named = (id: string) => (id === "w" ? "Tides" : undefined)
  expect(replacedBy(aria, { aria: "w" }, [{ ref: "w", on: true }], [], none)).toBe("w")
  expect(replacedBy(aria, { aria: "w" }, [], [{ id: "w", enabled: true }], none)).toBe("w")
  expect(replacedBy(aria, { aria: "w" }, [{ ref: "w", on: false }], [{ id: "w", enabled: false }], none)).toBeNull()
  expect(replacedBy({ entity: "rook", world: undefined }, { aria: "w" }, [{ ref: "w", on: true }], [], none)).toBeNull()
  // By name, only without a link of the chat's own; an explicit "none" turns the name off.
  expect(replacedBy(aria, undefined, [{ ref: "w", on: true }], [], named)).toBe("w")
  expect(replacedBy(aria, { aria: null }, [{ ref: "w", on: true }], [], named)).toBeNull()
  expect(replacedBy({ entity: "aria", world: "Other" }, {}, [{ ref: "w", on: true }], [], named)).toBeNull()
})
