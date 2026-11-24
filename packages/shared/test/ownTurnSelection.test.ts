import { describe, expect, it } from "vitest"
import { ownTurnSelectionError, cutOwnTurnText } from "../src/docs/note.ts"

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

describe("whitespace at a moved passage", () => {
  for (const [text, selected, expected] of [
    ["First. Secret. Last.", "Secret.", "First. Last."],
    ["Secret. Last.", "Secret.", "Last."],
    ["First. Secret.", "Secret.", "First."],
    ["First.\n\nSecret.\n\nLast.", "Secret.", "First.\n\nLast."],
    ["Secret.\n\nLast.", "Secret.", "Last."],
    ["Secret\n    code()", "Secret", "    code()"],
    ["Secret\r\n\tcode()", "Secret\r\n", "\tcode()"],
    ["First.\n\nSecret.", "Secret.", "First."],
    ["  Unchanged  prose.\n  First. Secret. Last.  ", "Secret.", "  Unchanged  prose.\n  First. Last.  "],
    ["preSECRETfix", "SECRET", "prefix"],
    ["- Keep\n  Secret.\n  Continue", "Secret.\n", "- Keep\n  Continue"],
    ["- Keep\r\n  Secret.\r\n  Continue", "Secret.\r\n", "- Keep\r\n  Continue"],
    ["{{char}} Secret. <b>Last.</b>", "Secret.", "{{char}} <b>Last.</b>"],
    ["Secret.", "Secret.", ""],
    ["First.\r\n\r\nSecret.\r\n\r\nLast.", "Secret.", "First.\r\n\r\nLast."]
  ])
    it(`cuts only adjacent whitespace in ${JSON.stringify(text)}`, () => {
      expect(cutOwnTurnText(text!, text!.indexOf(selected!), selected!.length)).toBe(expected)
    })
})
