import { expect, test } from "vitest"
import { bookSourceName, replacingBook } from "../src/lorebookLink.ts"

test.each([
  ["worlds/Tides.json", "Tides"],
  ["C:\\worlds\\Tides.JSON", "Tides"],
  ["Tides", "Tides"],
  ["worlds/Tides.extra.json", "Tides.extra"],
  [null, null],
  [undefined, null]
])("resolves an imported world's filename %s", (path, name) => {
  expect(bookSourceName(path)).toBe(name)
})

const books = [{ id: "named", sourceName: "Tides" }, { id: "linked", sourceName: "Other" }, { id: "authored" }]

test("a stored link takes precedence over the card's world name, even when unavailable", () => {
  expect(replacingBook("linked", "Tides", books)).toBe("linked")
  expect(replacingBook("authored", "Tides", books)).toBe("authored")
  expect(replacingBook("missing", "Tides", books)).toBeNull()
  expect(replacingBook(null, "Tides", books)).toBeNull()
})

test("only an absent link resolves the exact imported filename among books being read", () => {
  expect(replacingBook(undefined, "Tides", books)).toBe("named")
  expect(replacingBook(undefined, "tides", books)).toBeNull()
  expect(replacingBook(undefined, " Tides ", books)).toBeNull()
  expect(replacingBook(undefined, "Tides", [])).toBeNull()
  for (const world of [undefined, null, 17, {}, ""])
    expect(replacingBook(undefined, world, [{ id: "empty", sourceName: "" }, { id: "authored" }])).toBeNull()
})
