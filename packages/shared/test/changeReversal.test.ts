// Revert and Redo planning (spec/WORKSHOP-CARDS.md §8.1, shared/changeReversal.ts): a change's
// fields taken back three-way on the document as it is now, conflicts and choices, lists split by
// identity, and each field's state from its records.
import { describe, expect, it } from "vitest"
import {
  changedUnits,
  combinedFileEdits,
  docOfUnits,
  ORDER_UNIT,
  planReversal,
  planGroupedReversal,
  revertedFields,
  unitKey
} from "../src/changeReversal.ts"

const D = unitKey(["description"])
const before = { name: "Mara", description: "One.\nTwo.\nThree.", personality: "Quiet." }
const after = { ...before, description: "One.\nTWO.\nThree.", personality: "Loud." }

describe("planReversal", () => {
  it("sets a field the head still has as the change left it back as it was", () => {
    const plan = planReversal({ original: before, changed: after, now: after, fields: changedUnits(before, after) })
    expect(plan.doc).toEqual(before)
    expect(plan.conflicts).toEqual([])
  })

  it("reverses the change's hunks on text changed elsewhere since", () => {
    const now = { ...after, description: "One.\nTWO.\nThree, and four." }
    const plan = planReversal({ original: before, changed: after, now, fields: [D] })
    expect(plan.doc?.description).toBe("One.\nTwo.\nThree, and four.")
    expect(plan.doc?.personality).toBe("Loud.")
    expect(plan.before[D]).toBe(now.description)
    expect(plan.after[D]).toBe("One.\nTwo.\nThree, and four.")
  })

  it("leaves a conflict unwritten until chosen", () => {
    const now = { ...after, description: "One.\nTWENTY.\nThree." }
    const plan = planReversal({ original: before, changed: after, now, fields: changedUnits(before, after) })
    expect(plan.doc).toBe(null)
    expect(plan.conflicts).toEqual([{ field: D, now: now.description, before: before.description }])
    const kept = planReversal({ original: before, changed: after, now, fields: [D], choices: { [D]: "now" } })
    expect(kept.doc).toEqual(now)
    expect(kept.kept).toEqual([D])
    const taken = planReversal({ original: before, changed: after, now, fields: [D], choices: { [D]: "before" } })
    expect(taken.doc?.description).toBe(before.description)
  })

  it("takes a list with ids element by element, and an element deleted since is a conflict", () => {
    const b = { entries: [{ uid: 1, content: "Old." }] }
    const a = {
      entries: [
        { uid: 1, content: "New." },
        { uid: 2, content: "Added." }
      ]
    }
    const units = changedUnits(b, a)
    expect(units).toEqual([unitKey(["entries", "uid=1"]), unitKey(["entries", "uid=2"])])
    const now = {
      entries: [
        { uid: 2, content: "Added." },
        { uid: 3, content: "User's." }
      ]
    }
    const plan = planReversal({ original: b, changed: a, now, fields: units })
    expect(plan.conflicts.map((c) => c.field)).toEqual([unitKey(["entries", "uid=1"])])
    const rest = planReversal({ original: b, changed: a, now, fields: units, choices: { [units[0]!]: "before" } })
    expect(rest.doc).toEqual({
      entries: [
        { uid: 1, content: "Old." },
        { uid: 3, content: "User's." }
      ]
    })
  })

  it("reverts entry order together with an entry edit, keeping unrelated entries", () => {
    const one = { uid: 1, content: "One" }
    const two = { uid: 2, content: "Two" }
    const three = { uid: 3, content: "Three" }
    const extra = { uid: 4, content: "Added later" }
    const edited = { ...two, content: "Edited" }
    const original = { entries: [one, two, three] }
    const changed = { entries: [three, edited, one] }
    const fields = changedUnits(original, changed)
    expect(fields).toEqual([unitKey(["entries", ORDER_UNIT]), unitKey(["entries", "uid=2"])])
    const now = { entries: [three, extra, edited, one] }
    expect(planReversal({ original, changed, now, fields }).doc).toEqual({ entries: [one, extra, two, three] })
  })

  it("reverts one greeting and keeps a later edit to a different greeting", () => {
    const original = { alternate_greetings: ["One", "Two", "Three"] }
    const changed = { alternate_greetings: ["First", "Two", "Three"] }
    const fields = changedUnits(original, changed)
    const now = { alternate_greetings: ["First", "Second", "Three"] }
    expect(planReversal({ original, changed, now, fields }).doc?.alternate_greetings).toEqual([
      "One",
      "Second",
      "Three"
    ])
    for (const alternate_greetings of [
      ["Overlapping edit", "Two", "Three"],
      ["Two", "First", "Three"],
      ["Added", "First", "Two", "Three"],
      ["First", "Three", "Three"]
    ]) {
      const plan = planReversal({ original, changed, now: { alternate_greetings }, fields })
      expect(plan.conflicts.map((conflict) => conflict.field)).toEqual(fields)
    }
  })

  it("replays separate file patches around an intervening save to the same field", () => {
    const oldest = {
      original: { description: "The ferry runs at dawn. The inn is quiet." },
      changed: { description: "The ferry runs at dusk. The inn is quiet." },
      fields: [D]
    }
    const newest = {
      original: { description: "The ferry runs at dusk. The inn is bustling." },
      changed: { description: "The ferry runs at dusk. The inn is abandoned." },
      fields: [D]
    }
    const plan = planGroupedReversal([newest, oldest], newest.changed)
    expect(plan.doc).toEqual({ description: "The ferry runs at dawn. The inn is bustling." })
  })

  it("redoes from a record's values", () => {
    const revertedFrom = docOfUnits({ [D]: "One.\nTWO.\nThree." })
    const revertedTo = docOfUnits({ [D]: "One.\nTwo.\nThree." })
    const now = { ...before, personality: "Kind." }
    const plan = planReversal({ original: revertedFrom, changed: revertedTo, now, fields: [D] })
    expect(plan.doc).toEqual({ ...now, description: "One.\nTWO.\nThree." })
  })
})

describe("revertedFields", () => {
  it("is each field's latest record", () => {
    expect([
      ...revertedFields([
        { action: "revert", fields: ["a", "b"] },
        { action: "redo", fields: ["a"] }
      ])
    ]).toEqual(["b"])
  })
})

describe("combinedFileEdits", () => {
  it("is each field before the first edit and after the last", () => {
    expect(
      combinedFileEdits([
        { before: { description: "A" }, after: { description: "B" } },
        { before: { description: "B", name: "W" }, after: { description: "C", name: "Wren" } }
      ])
    ).toEqual({ before: { description: "A", name: "W" }, after: { description: "C", name: "Wren" } })
  })
})
