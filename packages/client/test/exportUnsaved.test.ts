// Export with unsaved changes asks first (owner, 2026-11-02): the question names each unsaved
// field once, a preset's held changes as one line.
import { HELD_FIELD, textField, valueField } from "@rp/shared/editing.ts"
import { describe, expect, it } from "vitest"
import { HELD_LABEL, unsavedFieldNames } from "../src/features/cardExport/unsaved.ts"

describe("the unsaved fields an export names", () => {
  it("names a card's fields as the editor labels them, each once", () => {
    const card = { name: "Wren", description: "Typed.", alternate_greetings: ["Hi"] }
    expect(
      unsavedFieldNames("card", card, card, [
        textField(["description"]),
        textField(["description"]),
        valueField(["talkativeness"])
      ])
    ).toEqual(["Description", "Talkativeness"])
  })

  it("names a preset's prompt by its name, and its held changes as one line", () => {
    const preset = { prompts: [{ identifier: "main", name: "Main Prompt", content: "" }] }
    expect(
      unsavedFieldNames("preset", preset, preset, [textField(["prompts", "identifier=main", "content"]), HELD_FIELD])
    ).toEqual(["Prompt “Main Prompt”: Content", HELD_LABEL])
  })

  it("names nothing when nothing is unsaved", () => {
    expect(unsavedFieldNames("card", {}, {}, [])).toEqual([])
  })
})
