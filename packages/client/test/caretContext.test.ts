import { describe, expect, it } from "vitest"
import { contextOffset } from "../src/ui/caretContext.ts"
import { type CaretPoint, editCaretLocators, registerEditCaret } from "../src/ui/editCaret.ts"

/** The rendered text split at the first `|`, as before and after the point. */
const at = (rendered: string) => {
  const cut = rendered.indexOf("|")
  return [rendered.slice(0, cut), rendered.slice(cut + 1)] as const
}
const offset = (source: string, rendered: string) => contextOffset(source, ...at(rendered))

describe("a rendered point found again in the stored text", () => {
  it("is the same offset in plain text", () => {
    const source = "The lantern swings over the quay."
    expect(offset(source, "The lantern sw|ings over the quay.")).toBe("The lantern sw".length)
  })

  it("skips markdown marks: bold, italics, list bullets and headings", () => {
    const source = "# Harbour\n\nThe **lantern** swings.\n\n- *first* rope\n- second rope\n"
    const rendered = "Harbour\nThe lantern swings.\nfirst rope\nsecond rope"
    const cut = (word: string, into: number) => rendered.indexOf(word) + into
    const point = (word: string, into: number) =>
      contextOffset(source, rendered.slice(0, cut(word, into)), rendered.slice(cut(word, into)))
    expect(point("lantern", 3)).toBe(source.indexOf("lantern") + 3)
    expect(point("first", 2)).toBe(source.indexOf("first") + 2)
    expect(point("second", 4)).toBe(source.indexOf("second") + 4)
    expect(point("Harbour", 0)).toBe(source.indexOf("Harbour"))
  })

  it("tells repeated words apart by their context", () => {
    const source = "The rope held. The rope frayed. The rope snapped."
    const rendered = "The rope held. The rope frayed. The ro|pe snapped."
    expect(offset(source, rendered)).toBe(source.lastIndexOf("rope") + 2)
    expect(offset(source, "The rope held. The ro|pe frayed. The rope snapped.")).toBe(source.indexOf("rope frayed") + 2)
  })

  it("picks the occurrence nearest the point's place when the context repeats too", () => {
    const line = "Waves on the stones again and again."
    const source = Array.from({ length: 6 }, () => line).join("\n\n")
    // The fourth copy: identical context, so only the proportional place tells.
    const rendered = Array.from({ length: 6 }, () => line).join("\n")
    const into = (line.length + 1) * 3 + "Waves on the st".length
    const found = contextOffset(source, rendered.slice(0, into), rendered.slice(into))
    expect(found).toBe((line.length + 2) * 3 + "Waves on the st".length)
  })

  it("matches one side alone when the other was rewritten for display (a macro)", () => {
    const source = "{{user}} smiles at the keeper."
    expect(offset(source, "Alice smi|les at the keeper.")).toBe(source.indexOf("smiles") + 3)
  })

  it("puts the caret right after a word when the point follows it", () => {
    const source = "Salt **and** tar."
    // Between "and" and the space: just after "and", inside the bold marks.
    expect(offset(source, "Salt and| tar.")).toBe(source.indexOf("and") + 3)
    // Before "tar": at its first letter.
    expect(offset(source, "Salt and |tar.")).toBe(source.indexOf("tar"))
  })

  it("falls back to the clicked word, then the nearest paragraph", () => {
    const source = "First paragraph here.\n\nSecond one, a gull.\n\nThird."
    // Context the source doesn't have around a word it does: the word's own place.
    expect(contextOffset(source, "zzqq gu", "ll xxyy")).toBe(source.indexOf("gull") + 2)
    // Nothing to match at all: the start of the paragraph at its place.
    const paragraph = contextOffset(source, "…".repeat(30), "…".repeat(20))
    expect(paragraph).toBe(source.indexOf("Second"))
  })

  it("keeps the ends and empty text in range", () => {
    expect(contextOffset("", "a", "b")).toBe(0)
    expect(offset("Short text.", "|Short text.")).toBe(0)
    expect(offset("Short text.", "Short text|.")).toBe("Short text".length)
  })
})

describe("the edit caret's locators", () => {
  it("are registered by id, in order, and a plugin can replace one", () => {
    const dispose = registerEditCaret()
    try {
      expect(editCaretLocators.list().map((locator) => [locator.id, locator.order])).toEqual([
        ["edit-caret.source-map", 0],
        ["edit-caret.context", 10]
      ])
      const always = (_point: CaretPoint, source: string) => source.length
      const undo = editCaretLocators.register({ id: "edit-caret.context", order: 10, locate: always })
      expect(editCaretLocators.get("edit-caret.context")?.locate).toBe(always)
      undo()
      expect(editCaretLocators.get("edit-caret.context")?.locate).not.toBe(always)
    } finally {
      for (const undo of dispose) undo()
    }
  })
})
