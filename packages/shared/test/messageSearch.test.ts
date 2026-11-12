// What a message search's words are and how a hit's excerpt marks them (messageSearch.ts).
import { describe, expect, it } from "vitest"
import { excerpt, markWords, queryWords } from "../src/messageSearch.ts"

describe("message search words", () => {
  it("splits as the index does, lower case, without repeats", () => {
    expect(queryWords("The old-lighthouse, the  KEEPER!")).toEqual(["the", "old", "lighthouse", "keeper"])
    expect(queryWords("e\u0301cole école 東京 हिन्दी 🌊")).toEqual(["école", "東京", "हिन्दी"])
    expect(queryWords("a a a a a a a a b")).toEqual(["a", "b"])
    expect(queryWords("¿?!")).toEqual([])
    expect(queryWords("a b c d e f g h i j")).toHaveLength(8)
  })

  it("marks whole words a query word starts, folding case and accents", () => {
    const text = "Café crème at the CAFETERIA; recafe."
    expect(markWords(text, ["cafe"])).toEqual([
      { at: 0, length: 4 },
      { at: 18, length: 9 }
    ])
    expect(markWords("naïve Naive", ["naive"])).toEqual([
      { at: 0, length: 5 },
      { at: 6, length: 5 }
    ])
    // Astral characters keep their offsets.
    expect(markWords("🌊 tide and 🌊 tides", ["tide"])).toEqual([
      { at: 3, length: 4 },
      { at: 15, length: 5 }
    ])
  })

  it("shows the text around the first match on one line, marks moved with it", () => {
    const long = `${"word ".repeat(100)}the lighthouse\nkeeper ${"tail ".repeat(100)}`
    const shown = excerpt(long, ["lighthouse"])
    expect(shown.before && shown.after).toBe(true)
    expect(shown.text.length).toBeLessThanOrEqual(181)
    expect(shown.text).not.toContain("\n")
    const mark = shown.marks[0]!
    expect(shown.text.slice(mark.at, mark.at + mark.length)).toBe("lighthouse")
    expect(excerpt("No match here.", ["xyz"])).toEqual({
      text: "No match here.",
      marks: [],
      before: false,
      after: false
    })
  })
})
