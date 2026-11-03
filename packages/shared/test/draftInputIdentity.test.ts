import { expect, it } from "vitest"
import { reconcileDeletedFields, trackDeletions } from "../src/draftDeletions.ts"

it("legacy positional barriers retain a conflicting array instead of blanking another item", () => {
  const state = {
    id: "draft",
    rowVersion: 3,
    clearedVersion: 0,
    content: JSON.stringify({
      scripts: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "" }
      ]
    }),
    deletions: { '["scripts","1","name"]': { draftId: "draft", rowVersion: 2, value: "" } }
  }
  const result = reconcileDeletedFields(
    state,
    { draftId: "draft", expectedRowVersion: 1 },
    JSON.stringify({
      scripts: [
        { id: "b", name: "Deleted Bravo" },
        { id: "a", name: "Alpha" }
      ]
    })
  )
  expect(result).toEqual({ content: state.content, changed: true, rejected: true })
})

it("an anonymous array at the form root retains its cleared snapshot across offline reordering", () => {
  const before = JSON.stringify([{ name: "Alpha" }, { name: "Bravo" }])
  const after = JSON.stringify([{ name: "Alpha" }, { name: "" }])
  const initial = { id: "draft", rowVersion: 1, clearedVersion: 0, content: before }
  const deletions = trackDeletions(initial, after, true, true)
  const result = reconcileDeletedFields(
    { ...initial, content: after, deletions },
    { draftId: "draft", expectedRowVersion: 1 },
    JSON.stringify([{ name: "Bravo" }, { name: "Alpha" }])
  )
  expect(JSON.parse(result.content)).toEqual(JSON.parse(after))
  expect(result.rejected).toBe(false)
})
