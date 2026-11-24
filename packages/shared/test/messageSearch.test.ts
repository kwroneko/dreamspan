// What a message search's words are and how a hit's excerpt marks them (messageSearch.ts).
import { describe, expect, it } from "vitest"
import { branchMatches } from "../src/branchNaming.ts"
import { excerpt, findPhrase, focusPhrase, markWords, parseQuery, queryWords } from "../src/messageSearch.ts"

describe("message search phrases", () => {
  it("reads quoted phrases apart from the other words, within the word limit", () => {
    expect(parseQuery('her "handwriting was" unmistakable')).toEqual({
      phrases: [["handwriting", "was"]],
      words: ["her", "unmistakable"]
    })
    expect(parseQuery("“The Seal,” smudged „wax")).toEqual({ phrases: [["the", "seal"], ["wax"]], words: ["smudged"] })
    expect(parseQuery('"" a b a')).toEqual({ phrases: [], words: ["a", "b"] })
    expect(parseQuery('"a b c d e f" g h i j').words).toEqual(["g", "h"])
    expect(queryWords('"the tide" the keeper')).toEqual(["the", "tide", "keeper"])
    expect(focusPhrase("handwriting was unmistakable")).toEqual(["handwriting", "was", "unmistakable"])
    expect(focusPhrase('lamp "the tide"')).toEqual(["the", "tide"])
    expect(focusPhrase("lamp")).toBeNull()
  })

  it("finds words side by side, each the start of a word, across punctuation", () => {
    const text = "The was, then: her Handwriting — was unmistakable."
    expect(findPhrase(text, ["handwriting", "was", "unmistak"])).toBe(text.indexOf("Handwriting"))
    expect(findPhrase(text, ["was", "handwriting"])).toBeNull()
    expect(findPhrase("Café crème", ["cafe", "creme"])).toBe(0)
    const long = `${"was ".repeat(80)}her handwriting was unmistakable ${"tail ".repeat(80)}`
    const shown = excerpt(long, ["handwriting", "was", "unmistakable"], undefined, [
      "handwriting",
      "was",
      "unmistakable"
    ])
    expect(shown.text).toContain("her handwriting was unmistakable")
  })

  it("matches a branch when every word typed is in its name or last message", () => {
    expect(branchMatches("", ["Original"])).toBe(true)
    expect(branchMatches("  docks NIGHT ", ["At the docks", "It was night."])).toBe(true)
    expect(branchMatches("docks dawn", ["At the docks", "It was night."])).toBe(false)
  })
})

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

  it("finds and marks supplementary-plane words using UTF-16 offsets", () => {
    const text = `${"word ".repeat(100)}𐐀𐐨𐐩, tide`
    const at = text.indexOf("𐐀")
    expect(findPhrase(text, ["𐐨𐐨", "tide"])).toBe(at)
    expect(markWords(text, ["𐐨𐐨"])).toEqual([{ at, length: 6 }])
    const shown = excerpt(text, ["𐐨𐐨"])
    expect(shown.before).toBe(true)
    expect(shown.marks.map((mark) => shown.text.slice(mark.at, mark.at + mark.length))).toEqual(["𐐀𐐨𐐩"])
  })
})
