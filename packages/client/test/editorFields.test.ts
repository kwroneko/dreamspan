import { describe, expect, it } from "vitest"
import { resolution } from "../src/features/editor/conflicts.tsx"
import { changedFields, fieldLabel, searchable } from "../src/features/editor/fields.ts"

const preset = {
  prompts: [
    { identifier: "main", name: "Main Prompt", content: "Be vivid." },
    { identifier: "jb", name: "", content: "Stay in character." }
  ],
  order: [
    { identifier: "main", enabled: true },
    { identifier: "jb", enabled: true }
  ],
  samplers: { temperature: 1 }
}

describe("editor fields", () => {
  it("lists what changed field by field, elements by identity", () => {
    const after = {
      ...preset,
      prompts: [preset.prompts[1]!, { ...preset.prompts[0]!, content: "Be terse." }],
      samplers: { temperature: 0.7 }
    }
    expect(changedFields(preset, after).map((c) => [c.path, c.before, c.after])).toEqual([
      [["prompts", "identifier=main", "content"], "Be vivid.", "Be terse."],
      [["samplers", "temperature"], 1, 0.7]
    ])
    // A list only reordered is one change: its order.
    const reordered = { ...preset, order: [...preset.order].reverse() }
    expect(changedFields(preset, reordered).map((c) => c.path)).toEqual([["order"]])
  })

  it("names fields as the editor shows them", () => {
    expect(fieldLabel("preset", preset, ["prompts", "identifier=main", "content"])).toBe(
      "Prompt “Main Prompt”: Content"
    )
    expect(fieldLabel("preset", preset, ["prompts", "identifier=jb", "content"])).toBe("Prompt jb: Content")
    expect(fieldLabel("card", {}, ["alternate_greetings", 1])).toBe("Alternate greetings 2")
    expect(fieldLabel("card", {}, ["description"])).toBe("Description")
  })

  it("searches every text field, greetings as elements of their list", () => {
    const card = { name: "Wren", description: "A keeper.", alternate_greetings: ["Hi.", "Hello."], modules: [] }
    expect(searchable("card", card).map((f) => [f.label, f.text, f.inList?.index])).toEqual([
      ["Name", "Wren", undefined],
      ["Description", "A keeper.", undefined],
      ["Alternate greetings 1", "Hi.", 0],
      ["Alternate greetings 2", "Hello.", 1]
    ])
    expect(searchable("card", { character_version: "v2" }).map((f) => f.label)).toEqual(["Character version"])
  })
})

describe("resolving an update", () => {
  const merged = { modules: [{ id: "m", title: "M", placement: { mode: "depth", depth: 2, role: "system" } }] }
  const path = ["modules", "id=m", "placement"]
  const conflict = { key: "p", label: "Placement", mine: { mode: "tail", role: "user" }, theirs: undefined }

  it("deletes what the side taken deleted", () => {
    expect(resolution(merged, [path], [conflict], [{ side: "theirs" }])).toEqual({
      modules: [{ id: "m", title: "M" }]
    })
    expect(resolution(merged, [path], [conflict], [{ side: "mine" }])).toEqual({
      modules: [{ id: "m", title: "M", placement: { mode: "tail", role: "user" } }]
    })
  })

  it("refuses an edit that isn't valid instead of deleting the field", () => {
    expect(resolution(merged, [path], [conflict], [{ side: "edit", text: "{not json" }])).toBeNull()
  })
})
