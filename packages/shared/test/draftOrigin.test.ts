import { expect, it } from "vitest"
import { Schema } from "effect"
import { EditingOrigin } from "../src/drafts.ts"
import { editingOrigin, mapEditingOrigin, reconcileDeletedFields, trackDeletions } from "../src/draftDeletions.ts"

it.each(["another input", "another item", "root array"])(
  "an anonymous clear survives reuse in %s and serialization",
  (where) => {
    const wrap = (items: unknown[]) => JSON.stringify(where === "root array" ? items : { items })
    const original = wrap([
      { name: "Deleted text", note: "" },
      { name: "", note: "" }
    ])
    const cleared = wrap([
      { name: "", note: "" },
      { name: "", note: "" }
    ])
    const reused = wrap(
      where === "another input"
        ? [
            { name: "", note: "Deleted text" },
            { name: "", note: "" }
          ]
        : [
            { name: "", note: "" },
            { name: "Deleted text", note: "" }
          ]
    )
    const origin = Schema.decodeUnknownSync(EditingOrigin)(
      JSON.parse(JSON.stringify(editingOrigin(editingOrigin(original, original, cleared), cleared, reused)))
    )
    const initial = { id: "draft", rowVersion: 1, content: original }
    const deletions = trackDeletions(initial, reused, true, true, { before: origin, content: reused })
    expect(Object.keys(deletions)).toEqual([where === "root array" ? "[]" : '["items"]'])
    const replay = reconcileDeletedFields(
      { ...initial, content: reused, deletions },
      { draftId: "draft", expectedRowVersion: 1 },
      original
    )
    expect(JSON.parse(replay.content)).toEqual(JSON.parse(reused))
    expect(mapEditingOrigin(origin, (content) => content)).toEqual(origin)
  }
)

it("pure anonymous reordering and typing in an empty input cannot manufacture a clear", () => {
  const initial = JSON.stringify({ items: [{ name: "Kept" }, { name: "" }] })
  for (const items of [
    [{ name: "" }, { name: "Kept" }],
    [{ name: "Kept" }, { name: "New" }]
  ]) {
    const content = JSON.stringify({ items })
    const origin = editingOrigin(initial, initial, content)
    expect(origin).toBe(initial)
    expect(
      trackDeletions({ id: "draft", rowVersion: 1, content: initial }, content, true, true, { before: origin, content })
    ).toEqual({})
  }
})
