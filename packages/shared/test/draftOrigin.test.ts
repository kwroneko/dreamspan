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

// Stale saves (review of 7e301b2d9): what the stale edit didn't change keeps the current value.
const staleMerge = (current: unknown, incoming: unknown, start: unknown) =>
  JSON.parse(
    reconcileForm(
      { id: "draft", rowVersion: 3, content: JSON.stringify(current) },
      { draftId: "draft", expectedRowVersion: 1 },
      JSON.stringify(incoming),
      JSON.stringify(start)
    ).content
  )
const withContext = {
  name: "",
  settings: { samplers: { reasoning_effort: "high", openai_max_context: 50000 } },
  drafts: { "settings.samplers.openai_max_context": "50000" }
}
const withEffort = { name: "", settings: { samplers: { reasoning_effort: "high" } }, drafts: {} }

it("a stale rename keeps a Context typed beside an effort", () => {
  expect(staleMerge(withContext, { ...withEffort, name: "Renamed" }, withEffort)).toEqual({
    ...withContext,
    name: "Renamed"
  })
})

it("a stale effort reset to Auto drops the effort and keeps a Context typed since", () => {
  expect(staleMerge(withContext, { name: "", settings: {}, drafts: {} }, withEffort)).toEqual({
    name: "",
    settings: { samplers: { openai_max_context: 50000 } },
    drafts: { "settings.samplers.openai_max_context": "50000" }
  })
})

it("a stale rename doesn't bring back a Context cleared since", () => {
  const typed = {
    name: "",
    settings: { samplers: { openai_max_context: 50000 } },
    drafts: { "settings.samplers.openai_max_context": "50000" }
  }
  expect(staleMerge({ name: "", settings: {}, drafts: {} }, { ...typed, name: "Renamed" }, typed)).toEqual({
    name: "Renamed",
    settings: {},
    drafts: {}
  })
})

it("a stale lorebook bulk tick keeps a value changed since", () => {
  const start = { ticked: { order: { v: 100 } } }
  expect(
    staleMerge({ ticked: { order: { v: 321 } } }, { ticked: { order: { v: 100 }, scanDepth: { v: 5 } } }, start)
  ).toEqual({ ticked: { order: { v: 321 }, scanDepth: { v: 5 } } })
})

it("a stale model bulk edit keeps a field and its tick added since", () => {
  const start = { ids: ["m1", "m2"], ticked: {}, draft: { context: "", maxOutput: "" } }
  const fromA = { ...start, ticked: { context: true }, draft: { context: "50000", maxOutput: "" } }
  const fromB = { ...start, ticked: { maxOutput: true }, draft: { context: "", maxOutput: "900" } }
  expect(staleMerge(fromA, fromB, start)).toEqual({
    ids: ["m1", "m2"],
    ticked: { context: true, maxOutput: true },
    draft: { context: "50000", maxOutput: "900" }
  })
})

// Review of 15a906b99 (3): ticks kept by name merge one by one: an untick in one tab and a tick
// or untick in another both stand.
it("a stale bulk tick or untick keeps an untick made since", () => {
  const start = { ticked: { context: true, maxOutput: true }, draft: {} }
  const fromA = { ...start, ticked: { maxOutput: true } }
  const ticking = { ...start, ticked: { context: true, maxOutput: true, temperature: true } }
  expect(staleMerge(fromA, ticking, start)).toEqual({ ticked: { maxOutput: true, temperature: true }, draft: {} })
  expect(staleMerge(fromA, { ...start, ticked: { context: true } }, start)).toEqual({ ticked: {}, draft: {} })
})

// Review of 15a906b99 (5): a list both changed is taken whole, as the text shown for it is.
it("a stale reorder of a provider list takes that order, as its text does", () => {
  const start = { settings: { routing: { order: ["Fireworks", "Together"] } }, drafts: {} }
  const fromA = { settings: { routing: { order: ["Fireworks", "Together", "DeepInfra"] } }, drafts: {} }
  const fromB = {
    settings: { routing: { order: ["Together", "Fireworks"] } },
    drafts: { "settings.routing.order": "Together,Fireworks" }
  }
  expect(staleMerge(fromA, fromB, start)).toEqual(fromB)
})

// Review of 15a906b99 (1, P1): a keyed list merges to its items only, never a hole.
it("a stale edit of one script keeps another script's deletion, with no empty slot", () => {
  const start = {
    scripts: [
      { id: "a", name: "First" },
      { id: "b", name: "Second" }
    ]
  }
  const merged = staleMerge(
    { scripts: [{ id: "b", name: "Second" }] },
    {
      scripts: [
        { id: "a", name: "First" },
        { id: "b", name: "Second, renamed" }
      ]
    },
    start
  )
  expect(merged).toEqual({ scripts: [{ id: "b", name: "Second, renamed" }] })
})

// Review of 15a906b99 (2, P1): a bulk draft kept as text before it became an object.
it("a stale bulk edit from a draft kept as text keeps a field changed since", () => {
  const start = { ids: ["m1"], ticked: { context: true }, draft: JSON.stringify({ context: "24000", maxOutput: "" }) }
  const fromA = { ...start, draft: { context: "50000", maxOutput: "" } }
  const ticked = { context: true, maxOutput: true }
  const want = { ids: ["m1"], ticked, draft: { context: "50000", maxOutput: "900" } }
  const fromB = { ...start, ticked, draft: { context: "24000", maxOutput: "900" } }
  expect(staleMerge(fromA, fromB, start)).toEqual(want)
})

// Review of 17ff0b861 (3): text typed into a field never turns into the group its JSON reads
// as, even where the field held a group: in one tab, and from a stale one.
it("JSON text typed where a group was stays text", () => {
  const held = { overrides: { sampling: { example: { x: 1 }, sibling: 1 } } }
  const typed = { overrides: { sampling: { example: '{"x":2}', sibling: 1 } } }
  const own = reconcileForm(
    { id: "draft", rowVersion: 3, content: JSON.stringify(held) },
    { draftId: "draft", expectedRowVersion: 3 },
    JSON.stringify(typed),
    JSON.stringify(held)
  )
  expect(JSON.parse(own.content)).toEqual(typed)
  const sinceA = { overrides: { sampling: { example: { x: 1 }, sibling: 2 } } }
  const fromB = { overrides: { sampling: { example: '{"x":1}', sibling: 1 } } }
  expect(staleMerge(sinceA, fromB, held)).toEqual({ overrides: { sampling: { example: '{"x":1}', sibling: 2 } } })
})
