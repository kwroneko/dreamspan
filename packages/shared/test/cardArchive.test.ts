import { describe, expect, it } from "vitest"
import { cardArchiveCriteria } from "../src/cardArchive.ts"

describe("card archive calendar-month cutoff", () => {
  it.each([
    ["2026-05-31T12:34:56.789Z", 3, "2026-02-28T12:34:56.789Z"],
    ["2024-08-31T12:34:56.789Z", 6, "2024-02-29T12:34:56.789Z"],
    ["2026-03-31T12:34:56.789Z", 1, "2026-02-28T12:34:56.789Z"],
    ["2026-01-31T12:34:56.789Z", 2, "2025-11-30T12:34:56.789Z"],
    ["2026-11-07T12:34:56.789Z", 6, "2026-05-07T12:34:56.789Z"]
  ])("subtracts from %s by %i months without overflowing the target month", (now, months, cutoff) => {
    const matches = cardArchiveCriteria.get("inactive")!.matches
    const at = Date.parse(cutoff)
    expect(
      matches({ addedAt: 0, lastUsedAt: at - 1, fromSource: null, userMessages: 0 }, Date.parse(now), months)
    ).toBe(true)
    expect(matches({ addedAt: 0, lastUsedAt: at, fromSource: null, userMessages: 0 }, Date.parse(now), months)).toBe(
      false
    )
    expect(
      matches({ addedAt: 0, lastUsedAt: at + 1, fromSource: null, userMessages: 0 }, Date.parse(now), months)
    ).toBe(false)
    expect(matches({ addedAt: 0, lastUsedAt: null, fromSource: null, userMessages: 0 }, Date.parse(now), months)).toBe(
      false
    )
  })
})
