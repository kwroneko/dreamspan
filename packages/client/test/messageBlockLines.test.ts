// The message editor's quote and list insets (ui/messageBlockLines.ts): which lines are inset by
// how much, as the message renders them, and which marks hang in the inset.
import { Text } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import { blockLines } from "../src/ui/messageBlockLines.ts"

/** Each inset line as [its number, its inset, the marks hanging in it, or "" for a continued line]. */
const insets = (source: string) => {
  const doc = Text.of(source.split("\n"))
  const out: Array<[number, string, string]> = []
  const set = blockLines(doc)
  for (let cursor = set.iter(); cursor.value; cursor.next()) {
    const spec = cursor.value.spec as { class: string; attributes: { style: string } }
    const line = doc.lineAt(cursor.from)
    if (spec.class.startsWith("rp-block-marks")) {
      out.at(-1)![2] = doc.sliceString(cursor.from, cursor.to)
      continue
    }
    out.push([line.number, /--rp-inset: ([^;]*);/.exec(spec.attributes.style)![1]!, ""])
  }
  return out
}

describe("message block lines", () => {
  it("insets a quote by its bar and padding, the mark hanging in it", () => {
    expect(insets("Before.\n\n> A quote\n> — its note\n\nAfter.")).toEqual([
      [3, "calc((3px + 0.9em))", "> "],
      [4, "calc((3px + 0.9em))", "> "]
    ])
  })

  it("insets list items by the list's padding, nested ones twice, a continued line with its item", () => {
    expect(insets("- One\n- Two\n  - Two a\n  more of two a\n1. Three\n\nAfter.")).toEqual([
      [1, "calc(1.5em)", "- "],
      [2, "calc(1.5em)", "- "],
      [3, "calc(1.5em + 1.5em)", "  - "],
      [4, "calc(1.5em + 1.5em)", ""],
      [5, "calc(1.5em)", "1. "]
    ])
  })

  it("insets a list in a quote by both", () => {
    expect(insets("> - In a quote")).toEqual([[1, "calc((3px + 0.9em) + 1.5em)", "> - "]])
  })

  it("leaves a paragraph after a list, and a fenced block, as they are", () => {
    expect(insets("- One\n\nA paragraph.\n\n```\n- not a list\n> not a quote\n```")).toEqual([[1, "calc(1.5em)", "- "]])
  })

  it("requires a matching closing fence of at least the opening length, with no info string", () => {
    expect(
      insets(["````md", "```", "- code", "~~~~", "> code", "````text", "- code", "`````  ", "- list"].join("\n"))
    ).toEqual([[9, "calc(1.5em)", "- "]])
  })
})
