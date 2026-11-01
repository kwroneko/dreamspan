import { expect, test } from "vitest"
import { shortAgo, sortCards } from "../src/features/characters/cardRecency.ts"

// After an ST import every card was created at the same moment, after all the imported chats.
// `recentAt` is the shell read's: the latest activity in any of the card's chats (shellReads.ts).
const imported = 2_000_000
const card = (entityId: string, label: string, recentAt: number | null, createdAt = imported, addedAt = imported) => ({
  card: { entityId, label, subtitle: "" },
  createdAt,
  addedAt,
  recentAt
})
const names = (cards: ReadonlyArray<ReturnType<typeof card>>) => cards.map((c) => c.card.label)

test("Recent sorts characters by their chats' latest activity, imported dates included", () => {
  const cards = [card("a", "Ava", 1_500), card("b", "Bram", 1_200), card("c", "Cleo", 1_500), card("z", "Zed", null)]
  // Ava and Cleo tie on a group chat: by name. Zed was never used: last, as in ST.
  expect(names(sortCards(cards, "recent"))).toEqual(["Ava", "Cleo", "Bram", "Zed"])
  // Oldest first keeps the never-used last.
  expect(names(sortCards(cards, "recent", true))).toEqual(["Bram", "Ava", "Cleo", "Zed"])
})

test("never-used characters follow the used ones, newest first", () => {
  const cards = [card("old", "Old", null, 10), card("new", "New", null, 30), card("used", "Used", 5, 1)]
  expect(names(sortCards(cards, "recent"))).toEqual(["Used", "New", "Old"])
  expect(names(sortCards(cards, "created"))).toEqual(["New", "Old", "Used"])
  expect(names(sortCards(cards, "name"))).toEqual(["New", "Old", "Used"])
})

test("Added orders by arrival here, not the card's own date; each sort turns round", () => {
  // An old card imported today, a new one written a week ago.
  const cards = [
    card("old", "Old", null, 10, 900),
    card("new", "New", null, 800, 100),
    card("mid", "Mid", null, 50, 500)
  ]
  expect(names(sortCards(cards, "added"))).toEqual(["Old", "Mid", "New"])
  expect(names(sortCards(cards, "added", true))).toEqual(["New", "Mid", "Old"])
  expect(names(sortCards(cards, "created"))).toEqual(["New", "Mid", "Old"])
  expect(names(sortCards(cards, "name", true))).toEqual(["Old", "New", "Mid"])
})

test("a tile's date is short", () => {
  const now = Date.UTC(2026, 10, 1, 12)
  expect(shortAgo(now - 30_000, now)).toBe("now")
  expect(shortAgo(now - 5 * 60_000, now)).toBe("5m ago")
  expect(shortAgo(now - 3 * 3_600_000, now)).toBe("3h ago")
  expect(shortAgo(now - 2 * 86_400_000, now)).toBe("2d ago")
  expect(shortAgo(now - 15 * 86_400_000, now)).toBe("2w ago")
  expect(shortAgo(now - 100 * 86_400_000, now)).toBe("3mo ago")
})
