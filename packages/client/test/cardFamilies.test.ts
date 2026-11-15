import type { ShellCard } from "@rp/shared/chatSetupApi.ts"
import { expect, test } from "vitest"
import { groupFamilies } from "../src/features/characters/cardFamilies.ts"
import { readHomeSearch, writeHomeSearch } from "../src/features/characters/homeSearch.ts"

// Only what the grouping reads: a card, its family (the shell read's `ShellCard.family`) and its Recent.
const card = (id: string, family?: string, recentAt: number | null = null) =>
  ({ card: { entityId: id }, recentAt, ...(family === undefined ? {} : { family }) }) as unknown as ShellCard
const shown = (tiles: ReturnType<typeof groupFamilies>) =>
  tiles.map((t) =>
    t.family ? `${t.card.card.entityId}${t.family.head ? `(${t.family.count})` : "·"}` : t.card.card.entityId
  )

test("a family is one tile where its first member stands, by the member used last", () => {
  const cards = [card("solo"), card("a1", "a", 10), card("other"), card("a2", "a", 30), card("a3", "a", 20)]
  expect(shown(groupFamilies(cards, null))).toEqual(["solo", "a2(3)", "other"])
  // None used: the first in the list's order stands for it.
  expect(shown(groupFamilies([card("b2", "b"), card("b1", "b")], null))).toEqual(["b2(2)"])
})

test("the open family lists its other members after it, in the list's order; the others stay closed", () => {
  const cards = [card("a1", "a", 10), card("b1", "b", 5), card("a2", "a", 30), card("b2", "b", 1), card("a3", "a", 20)]
  const tiles = groupFamilies(cards, "a")
  expect(shown(tiles)).toEqual(["a2(3)", "a1·", "a3·", "b1(2)"])
  expect(tiles.filter((t) => t.family?.id === "a").every((t) => t.family!.expanded)).toBe(true)
  expect(tiles.at(-1)!.family!.expanded).toBe(false)
})

test("a family with one member in the list is that card alone: filters and searches decide the members", () => {
  // Its other members were filtered out (archived, not a favourite, not matching).
  const tiles = groupFamilies([card("a2", "a", 30), card("solo")], "a")
  expect(shown(tiles)).toEqual(["a2", "solo"])
  expect(tiles[0]!.family).toBeUndefined()
  expect(groupFamilies([], "a")).toEqual([])
})

test("thousands of cards group in one pass", () => {
  const cards = Array.from({ length: 6000 }, (_, i) => card(`c${i}`, i % 3 === 0 ? `f${i % 300}` : undefined, i))
  const started = performance.now()
  const tiles = groupFamilies(cards, "f0")
  expect(performance.now() - started).toBeLessThan(200)
  expect(tiles.filter((t) => t.family?.head).length).toBe(100)
})

test("the open family is in the URL and left out when none is", () => {
  expect(readHomeSearch({ family: "0190-root" }).family).toBe("0190-root")
  expect(writeHomeSearch(readHomeSearch({ family: "0190-root" })).family).toBe("0190-root")
  expect(readHomeSearch({ family: 5 }).family).toBeNull()
  expect(writeHomeSearch(readHomeSearch({})).family).toBeUndefined()
})

test("the grouping part can be replaced or disabled without changing stored preferences", async () => {
  const { cardGrouping } = await import("../src/features/characters/cardGrouping.tsx")
  const cards = [card("a", "root"), card("b", "root")]
  const control = () => null
  const original = cardGrouping.register({ id: "forks", group: groupFamilies, control })
  try {
    expect(cardGrouping.get("forks")!.group(cards, null)).toHaveLength(1)
    const replacement = cardGrouping.register({
      id: "forks",
      group: (cards) => cards.map((card) => ({ card })),
      control
    })
    expect(cardGrouping.get("forks")!.group(cards, null)).toHaveLength(2)
    const restore = cardGrouping.disable("forks")
    expect(cardGrouping.get("forks")).toBeUndefined()
    restore()
    replacement()
    expect(cardGrouping.get("forks")!.group(cards, null)).toHaveLength(1)
  } finally {
    original()
  }
})
