import { expect, test } from "vitest"
import { lastChatAt, sortCards } from "../src/features/characters/cardRecency.ts"

// After an ST import every card was created at the same moment, after all the imported chats.
const imported = 2_000_000
const card = (entityId: string, label: string, createdAt = imported) => ({
  card: { entityId, label, subtitle: "" },
  createdAt
})

test("Recent sorts characters by their chats' latest activity, imported dates included", () => {
  const cards = [card("a", "Ava"), card("b", "Bram"), card("c", "Cleo"), card("z", "Zed")]
  const latest = lastChatAt([
    { joined: ["a"], recentAt: 1_000 },
    { joined: ["a", "c"], recentAt: 1_500 },
    { joined: ["b"], recentAt: 1_200 },
    // An older fork doesn't move a card back.
    { joined: ["c"], recentAt: 100 }
  ])
  expect(latest.get("a")).toBe(1_500)
  expect(latest.get("c")).toBe(1_500)
  // Ava and Cleo tie on a group chat: by name. Zed was never used: last, as in ST.
  expect(sortCards(cards, latest, "recent").map((c) => c.card.label)).toEqual(["Ava", "Cleo", "Bram", "Zed"])
})

test("never-used characters follow the used ones, newest first", () => {
  const cards = [card("old", "Old", 10), card("new", "New", 30), card("used", "Used", 1)]
  const latest = lastChatAt([{ joined: ["used"], recentAt: 5 }])
  expect(sortCards(cards, latest, "recent").map((c) => c.card.label)).toEqual(["Used", "New", "Old"])
  expect(sortCards(cards, latest, "created").map((c) => c.card.label)).toEqual(["New", "Old", "Used"])
  expect(sortCards(cards, latest, "name").map((c) => c.card.label)).toEqual(["New", "Old", "Used"])
})
