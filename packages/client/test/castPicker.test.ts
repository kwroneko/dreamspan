import { expect, test } from "vitest"
import type { CastCard } from "@rp/shared/chat.ts"
import { addableGroups } from "../src/features/chat/cast.ts"

const card = (entityId: string, name: string, persona = false, subtitle = "") =>
  ({
    entityId,
    name,
    label: name,
    persona,
    subtitle,
    inBin: false,
    lorebook: false,
    avatarMediaId: null
  }) as unknown as CastCard

const cards = [
  card("a", "Ava", false, "1.0"),
  card("b", "Bram", false, "v2"),
  card("c", "Cleo"),
  card("p", "Pip", true, "1.0"),
  card("b2", "Bram", false, "Storm")
]
const recency = new Map([
  ["c", 300],
  ["a", 100],
  ["b2", 200]
])

test("the Add character picker lists characters first, latest chats first, then by name; personas apart", () => {
  const { characters, personas } = addableGroups(cards, recency, "")
  expect(characters.map(({ card }) => card.entityId)).toEqual(["c", "b2", "a", "b"])
  expect(personas.map(({ card }) => card.entityId)).toEqual(["p"])
})

test("a version shows only to tell two cards of the same name apart", () => {
  const { characters, personas } = addableGroups(cards, recency, "")
  expect(Object.fromEntries(characters.map(({ card, version }) => [card.entityId, version]))).toEqual({
    c: "",
    b2: "Storm",
    a: "",
    b: "v2"
  })
  expect(personas[0]!.version).toBe("")
})

test("searching matches names and versions, and the version rule follows what's found", () => {
  expect(addableGroups(cards, recency, "storm").characters).toEqual([{ card: cards[4], version: "" }])
  expect(addableGroups(cards, recency, "bram").characters.map(({ version }) => version)).toEqual(["Storm", "v2"])
})
