import { describe, expect, it } from "vitest"
import { ownTurnSelectionError } from "../src/docs/note.ts"

describe("move selections", () => {
  for (const text of ["First.\n\nSecond.", "Hello {{char}}.", "{{outer::{{char}}}}", '<p title="a > b">Blue.</p>']) {
    it(`accepts the whole field: ${text}`, () => expect(ownTurnSelectionError(text, 0, text.length)).toBeNull())
  }
  it("accepts text within HTML and a whole nested element", () => {
    const text = '<p title="a > b">Blue <b>eyes</b>.</p>'
    for (const selected of ["Blue", "<b>eyes</b>", "eyes"])
      expect(ownTurnSelectionError(text, text.indexOf(selected), selected.length)).toBeNull()
    expect(ownTurnSelectionError(text, text.indexOf("a > b"), 5)).not.toBeNull()
  })
  it("rejects either cut boundary of a nested macro", () => {
    const text = "{{outer::{{char}}}}"
    for (const [at, length] of [
      [0, 12],
      [2, 16],
      [9, 8]
    ])
      expect(ownTurnSelectionError(text, at!, length!)).not.toBeNull()
  })
})
