import { expect, it } from "vitest"
import { Schema } from "effect"
import { EditingOrigin } from "../src/drafts.ts"
import {
  editingOrigin,
  mapEditingOrigin,
  reconcileDeletedFields,
  reconcileForm,
  trackDeletions
} from "../src/draftDeletions.ts"

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

it("a whole-field clear remains an explicit event after new text, schema decoding and version mapping", () => {
  const clear = editingOrigin("Deleted text", "Deleted text", "")
  const fresh = Schema.decodeUnknownSync(EditingOrigin)(
    JSON.parse(JSON.stringify(editingOrigin(clear, "", "New text")))
  )
  const initial = { id: "draft", rowVersion: 1, content: "Deleted text" }
  const deletions = trackDeletions(initial, "New text", true, true, { before: fresh, content: "New text" })
  expect(deletions[""]?.rowVersion).toBe(2)
  expect(mapEditingOrigin(fresh, (content) => content)).toEqual(clear)
})

it("continuing one whole-form clear cannot invent a later per-input deletion", () => {
  const old = JSON.stringify({ name: "Removed name", note: "" })
  const intent = editingOrigin(old, old, "")
  const initial = { id: "draft", rowVersion: 1, content: old }
  const cleared = trackDeletions(initial, "", true, true, { before: intent, content: "" })
  const next = JSON.stringify({ name: "", note: "Typed after clearing" })
  expect(
    trackDeletions({ ...initial, rowVersion: 2, content: "", deletions: cleared }, next, true, true, {
      before: editingOrigin(intent, "", next),
      content: next
    })
  ).toEqual(cleared)
})

it("new input clears after a whole-field clear keep their own later barrier", () => {
  const original = JSON.stringify({ name: "Old name" })
  const root = editingOrigin(original, original, "")
  const initial = { id: "draft", rowVersion: 1, content: original }
  const cleared = trackDeletions(initial, "", true, true, { before: root, content: "" })
  const typed = JSON.stringify({ name: "Newly typed after the root clear" })
  const empty = JSON.stringify({ name: "" })
  const later = editingOrigin(editingOrigin(root, "", typed), typed, empty)
  const markers = trackDeletions({ ...initial, rowVersion: 2, content: typed, deletions: cleared }, empty, true, true, {
    before: later,
    content: empty
  })
  expect(markers[""]).toEqual(cleared[""])
  expect(markers['["name"]']?.rowVersion).toBe(3)
})

it("a new whole-field clear replaces old form values, while its later continuation preserves untouched new inputs", () => {
  const old = JSON.stringify({ name: "Old name", note: "" })
  const intent = editingOrigin(old, old, "")
  const fresh = JSON.stringify({ name: "", note: "Typed after clearing" })
  const initial = { id: "draft", rowVersion: 1, content: old }
  const base = { draftId: "draft", expectedRowVersion: 1 }
  expect(reconcileForm(initial, base, fresh, editingOrigin(intent, "", fresh)).content).toBe(fresh)
  const cleared = trackDeletions(initial, "", true, true, { before: intent, content: "" })
  const remote = JSON.stringify({ name: "Another device's post-clear name", note: "" })
  const continued = reconcileForm(
    { ...initial, content: remote, rowVersion: 3, deletions: cleared },
    base,
    fresh,
    editingOrigin(intent, "", fresh)
  )
  expect(JSON.parse(continued.content)).toEqual({
    name: "Another device's post-clear name",
    note: "Typed after clearing"
  })
})

// A group the current edit emptied goes with its numbers and choices; one merely absent from
// what a stale save started from stays whole (review of b79e26e1f: three stale saves lost values).
it("a group this edit emptied goes, numbers and all (Context's End back to All)", () => {
  const typed = JSON.stringify({ settings: { samplers: { openai_max_context: 1100 } }, drafts: {} })
  const draft = { id: "draft", rowVersion: 3, content: typed }
  const back = JSON.stringify({ settings: {}, drafts: {} })
  expect(reconcileForm(draft, { draftId: "draft", expectedRowVersion: 3 }, back, typed).content).toBe(back)
  // What this edit never saw in the group (another tab's sampler) stays.
  const other = JSON.stringify({ settings: { samplers: { openai_max_context: 1100, temperature: 0.4 } }, drafts: {} })
  const kept = reconcileForm({ ...draft, content: other }, { draftId: "draft", expectedRowVersion: 2 }, back, typed)
  expect(JSON.parse(kept.content)).toEqual({ settings: { samplers: { temperature: 0.4 } }, drafts: {} })
})

it("a stale model settings save keeps a sampler another tab typed", () => {
  const start = JSON.stringify({ name: "", settings: {}, drafts: {} })
  const typedInA = JSON.stringify({
    name: "",
    settings: { samplers: { openai_max_context: 50000 } },
    drafts: { "settings.samplers.openai_max_context": "50000" }
  })
  const fromB = JSON.stringify({ name: "Renamed", settings: {}, drafts: {} })
  const merged = reconcileForm(
    { id: "draft", rowVersion: 3, content: typedInA },
    { draftId: "draft", expectedRowVersion: 1 },
    fromB,
    start
  )
  expect(JSON.parse(merged.content)).toEqual({
    name: "Renamed",
    settings: { samplers: { openai_max_context: 50000 } },
    drafts: { "settings.samplers.openai_max_context": "50000" }
  })
})

it("a stale lorebook bulk edit keeps the setting another tab ticked", () => {
  const start = JSON.stringify({ ticked: {} })
  const tickedInA = JSON.stringify({ ticked: { order: { v: 321 } } })
  const fromB = JSON.stringify({ ticked: { scanDepth: { v: 5 } } })
  const merged = reconcileForm(
    { id: "draft", rowVersion: 3, content: tickedInA },
    { draftId: "draft", expectedRowVersion: 1 },
    fromB,
    start
  )
  expect(JSON.parse(merged.content)).toEqual({ ticked: { scanDepth: { v: 5 }, order: { v: 321 } } })
})

it("a stale preset conversion save keeps a choice's keep flag", () => {
  const start = JSON.stringify({ name: "P (workshop)", instructions: "", choices: {} })
  const draftedInA = JSON.stringify({
    name: "P (workshop)",
    instructions: "",
    choices: { custom: { identifier: "custom", keep: true, replacement: "Replacement text" } }
  })
  const fromB = JSON.stringify({ name: "P (workshop)", instructions: "Workspace instructions", choices: {} })
  const merged = reconcileForm(
    { id: "draft", rowVersion: 3, content: draftedInA },
    { draftId: "draft", expectedRowVersion: 1 },
    fromB,
    start
  )
  expect(JSON.parse(merged.content)).toEqual({
    name: "P (workshop)",
    instructions: "Workspace instructions",
    choices: { custom: { identifier: "custom", keep: true, replacement: "Replacement text" } }
  })
})
