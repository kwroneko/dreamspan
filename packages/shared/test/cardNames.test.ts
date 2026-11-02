import { describe, expect, it } from "vitest"
import { cardNameClash, cardNames, renameQuestion } from "../src/cardNames.ts"
import { cardTokenTexts, sumCardTokens } from "../src/cardTokens.ts"
import type { RefId } from "../src/library.ts"

const refs = [
  { id: "a" as RefId, label: "Aria Vance", subtitle: "1.0" },
  { id: "b" as RefId, label: "Aria Vance", subtitle: "1.0" }
]

describe("standard card names", () => {
  it.each([undefined, "", "Aria"])("maps nickname %s and the version", (nickname) => {
    expect(cardNames({ name: "Aria Vance", nickname, character_version: "1.0" })).toEqual({
      displayName: "Aria Vance",
      modelName: nickname || "Aria Vance",
      version: "1.0"
    })
  })
  it("explains an exact pair clash for a new card or fork", () => {
    expect(cardNameClash(refs, "Aria Vance", "1.0")).toBe(
      "Another card is already called Aria Vance · 1.0: change the display name or the version"
    )
    expect(cardNameClash(refs, "Aria Vance", "2.0")).toBeNull()
    expect(cardNameClash(refs, "Aria", "1.0")).toBeNull()
  })
  it("leaves imported collisions alone until their name or version changes", () => {
    expect(cardNameClash(refs, "Aria Vance", "1.0", refs[0])).toBeNull()
    expect(cardNameClash([...refs, { ...refs[1]!, subtitle: "2.0" }], "Aria Vance", "2.0", refs[0])).toContain(
      "Another card"
    )
  })
})

describe("what a rename asks (the owner's matrix, 2026-11-01)", () => {
  const names = (name: string, nickname = "") => ({ name, nickname })
  it("asks nothing when the display name changes with a nickname set", () => {
    expect(renameQuestion(names("Mio Tanaka", "Mio"), names("Mio T.", "Mio"))).toBeNull()
  })
  it("offers history replacement when the nickname changes", () => {
    expect(renameQuestion(names("Mio Tanaka", "Mio"), names("Mio Tanaka", "Mimi"))).toEqual({
      kind: "history",
      oldName: "Mio",
      newName: "Mimi"
    })
  })
  it("asks on a first nickname only when it differs from the display name", () => {
    expect(renameQuestion(names("Mio"), names("Mio", "Mio"))).toBeNull()
    expect(renameQuestion(names("Mio Tanaka"), names("Mio Tanaka", "Mio"))).toEqual({
      kind: "history",
      oldName: "Mio Tanaka",
      newName: "Mio"
    })
  })
  it("asks on a cleared nickname only when the display name differs", () => {
    expect(renameQuestion(names("Mio", "Mio"), names("Mio"))).toBeNull()
    expect(renameQuestion(names("Mio Tanaka", "Mio"), names("Mio Tanaka"))).toEqual({
      kind: "history",
      oldName: "Mio",
      newName: "Mio Tanaka"
    })
  })
  it("offers the three choices when the display name changes with no nickname", () => {
    expect(renameQuestion(names("Mio"), names("Mia"))).toEqual({ kind: "display", oldName: "Mio", newName: "Mia" })
  })
  it("asks nothing when nothing chats use changes, or a name is empty", () => {
    expect(renameQuestion(names("Mio"), names("Mio"))).toBeNull()
    expect(renameQuestion(names(""), names("Mio"))).toBeNull()
  })
})

describe("token counts (ST's total and permanent)", () => {
  const doc = {
    name: "Mio",
    nickname: "",
    description: "a".repeat(40),
    personality: "b".repeat(8),
    scenario: "c".repeat(4),
    first_mes: "d".repeat(400),
    mes_example: "e".repeat(80),
    system_prompt: "f".repeat(4),
    post_history_instructions: "",
    alternate_greetings: ["g".repeat(4000)],
    creator_notes: "h".repeat(4000)
  }
  // A stand-in tokenizer, four characters a token: the real one is the server's.
  const count = (doc: Parameters<typeof cardTokenTexts>[0], notes?: ReadonlyArray<string>) => {
    const texts = cardTokenTexts(doc, notes)
    return sumCardTokens(
      texts,
      texts.map(({ text }) => Math.ceil(text.length / 4))
    )
  }
  it("counts the name, description, personality and scenario as permanent", () => {
    expect(count(doc).permanent).toBe(1 + 10 + 2 + 1)
  })
  it("adds the first message, examples and the card's prompts to the total, not greetings or creator's notes", () => {
    expect(count(doc).total).toBe(14 + 100 + 20 + 1)
  })
  it("counts the notes on by default as ST counts its Character's Note: permanent", () => {
    expect(count(doc, ["n".repeat(12)])).toEqual({ permanent: 14 + 3, total: 135 + 3 })
  })
  it("counts the nickname, the name chats send", () => {
    expect(count({ ...doc, nickname: "Mio Tanaka-san" }).permanent).toBe(4 + 13)
  })
  it("lists ST's counted fields in its panel's order, each counted on its own", () => {
    expect(cardTokenTexts(doc).map((t) => t.text.slice(0, 1))).toEqual(["M", "a", "d", "f", "", "b", "c", "e"])
  })
})
