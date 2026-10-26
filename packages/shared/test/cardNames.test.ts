import { describe, expect, it } from "vitest"
import { cardNameClash, cardNames } from "../src/cardNames.ts"
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
