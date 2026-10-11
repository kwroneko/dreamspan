import { describe, expect, it } from "vitest"
import { diffJson } from "./report.ts"

describe("the ST harness's JSON diff", () => {
  it("finds nothing between equal values", () => {
    expect(diffJson({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toEqual([])
  })

  it("names the path of every difference, absent values included", () => {
    const left = { messages: [{ role: "system", content: "A" }], temperature: 1 }
    const right = {
      messages: [
        { role: "user", content: "A" },
        { role: "user", content: "B" }
      ],
      top_p: 1
    }
    expect(diffJson(left, right)).toEqual([
      'messages[0].role: "system" ≠ "user"',
      'messages[1]: (absent) ≠ {"role":"user","content":"B"}',
      "temperature: 1 ≠ (absent)",
      "top_p: (absent) ≠ 1"
    ])
  })

  it("tells a number from the same number as text", () => {
    expect(diffJson({ n: 1 }, { n: "1" })).toEqual(['n: 1 ≠ "1"'])
  })

  it("shortens long text from the middle", () => {
    const [line] = diffJson("a".repeat(500), `${"a".repeat(499)}b`)
    expect(line!.length).toBeLessThan(400)
    expect(line).toContain("...")
    expect(line!.endsWith('ab"')).toBe(true)
  })
})
