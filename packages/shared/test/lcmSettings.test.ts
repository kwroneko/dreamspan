// The summarization settings' small rules (DESIGN §8): a maximum lowered past its target takes
// the target with it, and the instruction asks for the summary length in words.
import { describe, expect, it } from "vitest"
import { loweredTarget, resolveLcm, summaryWords } from "../src/lcmSettings.ts"

describe("loweredTarget", () => {
  it("keeps the target while it is below the new maximum", () => {
    expect(loweredTarget(14_000, 18_000, 16_000)).toBeNull()
  })
  it("lowers it to the same share of the maximum, in hundreds", () => {
    expect(loweredTarget(14_000, 18_000, 10_000)).toBe(7700)
    expect(loweredTarget(12_000, 20_000, 12_000)).toBe(7200)
  })
  it("stays below a small maximum", () => {
    expect(loweredTarget(14_000, 18_000, 50)).toBe(49)
    expect(loweredTarget(19_000, 18_000, 10_000)).toBe(9999)
  })
})

describe("summary length", () => {
  it("is asked for in words, about 0.75 a token", () => {
    expect(summaryWords(600)).toBe(450)
    expect(summaryWords(75)).toBe(56)
    expect(summaryWords(1)).toBe(1)
  })
})

describe("the built-ins", () => {
  it("are recent 12,000/20,000 and summaries 14,000/18,000, without notes in summary requests", () => {
    const r = resolveLcm(null, null)
    expect([r.recentTarget, r.recentMax, r.layerTarget, r.layerMax, r.withNotes]).toEqual([
      12_000,
      20_000,
      14_000,
      18_000,
      false
    ])
  })
})
