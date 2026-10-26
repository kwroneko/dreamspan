import { describe, expect, it } from "vitest"
import { parseStCreatedAt } from "../../src/formats/stCreatedAt.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { json, run, stCardV2 } from "./support.ts"

describe("ST installation creation time", () => {
  it.each([
    ["2024-07-12T01:31:37.123Z", Date.parse("2024-07-12T01:31:37.123Z")],
    [1720747897123, 1720747897123],
    ["2024-07-12@01h31m37s123ms", new Date(2024, 6, 12, 1, 31, 37, 123).getTime()],
    ["2024-7-12@01h31m37s", new Date(2024, 6, 12, 1, 31, 37).getTime()],
    ["2024-6-5 @14h 56m 50s 682ms", new Date(2024, 5, 5, 14, 56, 50, 682).getTime()],
    ["June 19, 2023 2:20pm", new Date(2023, 5, 19, 14, 20).getTime()]
  ])("parses %s", (input, expected) => expect(parseStCreatedAt(input)).toBe(expected))
  it.each([undefined, null, "", "nonsense", {}, Infinity, NaN, 1e100, "2024-13-40@01h31m37s"])(
    "rejects invalid input %s",
    (input) => expect(parseStCreatedAt(input)).toBeNull()
  )
  it("carries local creation metadata separately from the card definition", () => {
    const source = { ...stCardV2(), create_date: "2024-7-12@01h31m37s" }
    const result = run(importCard(json(source)))
    expect(result.stCreatedAt).toBe(new Date(2024, 6, 12, 1, 31, 37).getTime())
    expect(result.card.unknown_root_fields).not.toHaveProperty("create_date")
  })
})
