import { EditorState, Transaction } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import { comparisonBase, lineChanges, lineKind } from "../src/ui/codeChanges.ts"

const compared = (base: string, value: string) =>
  EditorState.create({ doc: value, extensions: [lineChanges] }).update({ effects: comparisonBase.of(base) }).state
const markers = (state: EditorState) => {
  const { base, chunks } = state.field(lineChanges)
  return Array.from({ length: state.doc.lines }, (_, index) =>
    lineKind(base, state.doc, chunks, state.doc.line(index + 1).from)
  )
}

describe("code editor line comparisons", () => {
  it("marks unchanged, modified and added lines against the revision", () => {
    expect(
      markers(compared("A quiet harbor.\nThe lamp burns.", "A quiet harbor.\nThe lamp flickers.\nA new arrival."))
    ).toEqual(["unchanged", "modified", "added"])
    expect(markers(compared("", "A new card."))).toEqual(["added"])
  })
  it("distinguishes an inserted line before a modified line in the same chunk", () => {
    expect(markers(compared("The lamp burns.", "A new arrival.\nThe lamp flickers."))).toEqual(["added", "modified"])
  })
  it("normalizes imported CRLF in both the value and comparison", () => {
    expect(markers(compared("First.\r\nLast.", "First.\r\nLast."))).toEqual(["unchanged", "unchanged"])
  })
  it.each([1, 2, 3])("marks every empty line added by %i trailing newlines", (count) => {
    const expected = ["modified", ...Array<string>(count).fill("added")]
    expect(markers(compared("A", `A${"\n".repeat(count)}`))).toEqual(expected)
    // Exercise the incremental path used when Enter is pressed at EOF too.
    let state = compared("A", "A")
    for (let index = 0; index < count; index++)
      state = state.update({ changes: { from: state.doc.length, insert: "\n" } }).state
    expect(markers(state)).toEqual(expected)
  })
  it("marks where whole lines were deleted, including the end of the document", () => {
    expect(markers(compared("First.\nRemoved.\nLast.", "First.\nLast."))).toContain("deleted")
    expect(markers(compared("First.\nRemoved.", "First."))).toContain("deleted")
  })
  it("updates incrementally and clears when the saved revision advances", () => {
    let state = compared("First.\nLast.", "First.\nLast.")
    state = state.update({ changes: { from: 0, to: 6, insert: "New first." } }).state
    expect(markers(state)).toEqual(["modified", "unchanged"])
    state = state.update({ effects: comparisonBase.of(state.doc.toString()) }).state
    expect(markers(state)).toEqual(["unchanged", "unchanged"])
  })
  it("compares an external replacement without changing the revision base", () => {
    let state = compared("First.\nLast.", "First.\nLast.")
    state = state.update({
      changes: { from: 0, to: state.doc.length, insert: "Recovered." },
      annotations: Transaction.addToHistory.of(false)
    }).state
    expect(state.field(lineChanges).base.toString()).toBe("First.\nLast.")
    expect(markers(state)).toEqual(["modified"])
  })
})
