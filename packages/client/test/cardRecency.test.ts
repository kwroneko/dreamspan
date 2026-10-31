import { expect, test } from "vitest"
import { sortCards } from "../src/features/characters/cardRecency.ts"

// After an ST import every card was created at the same moment, after all the imported chats.
// `recentAt` is the shell read's: the latest activity in any of the card's chats (shellReads.ts).
const imported = 2_000_000
const card = (entityId: string, label: string, recentAt: number | null, createdAt = imported) => ({
  card: { entityId, label, subtitle: "" },
  createdAt,
  recentAt
})

test("Recent sorts characters by their chats' latest activity, imported dates included", () => {
  const cards = [card("a", "Ava", 1_500), card("b", "Bram", 1_200), card("c", "Cleo", 1_500), card("z", "Zed", null)]
  // Ava and Cleo tie on a group chat: by name. Zed was never used: last, as in ST.
  expect(sortCards(cards, "recent").map((c) => c.card.label)).toEqual(["Ava", "Cleo", "Bram", "Zed"])
})

test("never-used characters follow the used ones, newest first", () => {
  const cards = [card("old", "Old", null, 10), card("new", "New", null, 30), card("used", "Used", 5, 1)]
  expect(sortCards(cards, "recent").map((c) => c.card.label)).toEqual(["Used", "New", "Old"])
  expect(sortCards(cards, "created").map((c) => c.card.label)).toEqual(["New", "Old", "Used"])
  expect(sortCards(cards, "name").map((c) => c.card.label)).toEqual(["New", "Old", "Used"])
})
