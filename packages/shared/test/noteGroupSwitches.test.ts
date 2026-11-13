import { describe, expect, it } from "vitest"
import { noteSwitches, type FoldableEvent } from "../src/state.ts"
const note = (entity: string, card: string, group = "g") => ({ entity, doc: { owner: { card }, move_group: group } })
const switched = (note: string, on: boolean): FoldableEvent => ({
  scope: null,
  data: { key: on ? "note.activate" : "note.deactivate", value: { note: note as never } }
})
describe("moved note group switches", () => {
  it("includes a later member and scopes a portable group to its owner card", () => {
    const notes = [
      note("shared", "Mira"),
      note("first", "Mira"),
      note("later", "Mira"),
      note("copied", "Mira fork"),
      note("other field", "Mira", "other")
    ]
    const switches = noteSwitches([switched("first", true), switched("shared", false)], notes)
    expect([...switches]).toEqual([
      ["shared", false],
      ["first", false],
      ["later", false]
    ])
    expect(switches.has("copied")).toBe(false)
    expect(switches.has("other field")).toBe(false)
    expect([...noteSwitches([switched("first", false), switched("later", true)], notes)].every(([, on]) => on)).toBe(
      true
    )
  })
  it("retains ordinary ungrouped notes and leaves defaults alone", () => {
    expect([...noteSwitches([switched("ordinary", true)], [note("later", "Mira")])]).toEqual([["ordinary", true]])
    expect(noteSwitches([], [note("later", "Mira")]).size).toBe(0)
  })
})
