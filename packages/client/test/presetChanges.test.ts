// The Prompt preset tab's unsaved bar says what the drafts change (owner, 2026-11-01), and
// unnamed prompts are named by their first words.
import { textField, valueField } from "@rp/shared/editing.ts"
import { describe, expect, it } from "vitest"
import { describePresetChanges } from "../src/features/editor/presetChanges.ts"
import { promptLabel } from "../src/features/editor/promptLabel.ts"

const prompt = (identifier: string, name: string, content = "") => ({
  identifier,
  name,
  role: "system",
  content,
  system_prompt: false,
  marker: false,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: false
})
const head = {
  prompts: [prompt("main", "Main Prompt"), prompt("a", "Alpha"), prompt("b", ""), prompt("c", "Gamma")],
  order: [
    { identifier: "main", enabled: true },
    { identifier: "a", enabled: true },
    { identifier: "b", enabled: true },
    { identifier: "c", enabled: false }
  ]
}
const content = (id: string) => textField(["prompts", `identifier=${id}`, "content"])

describe("describePresetChanges", () => {
  it("says nothing changed for the saved preset", () => {
    expect(describePresetChanges(head, head, [])).toEqual([])
  })

  it("tells a reorder from switch flips", () => {
    const order = [head.order[0]!, head.order[2]!, head.order[1]!, { identifier: "c", enabled: true }]
    expect(describePresetChanges(head, { ...head, order }, [valueField(["order"])])).toEqual(["new order", "1 switch"])
    const flipped = head.order.map((e) => ({ ...e, enabled: !e.enabled }))
    expect(describePresetChanges(head, { ...head, order: flipped }, [valueField(["order"])])).toEqual(["4 switches"])
  })

  it("names whose text and options changed, unnamed ones by their first words", () => {
    const current = {
      ...head,
      prompts: head.prompts.map((p) => (p.identifier === "b" ? { ...p, content: "Write tersely and well." } : p))
    }
    const fields = [content("a"), content("b"), valueField(["prompts", "identifier=c", "role"])]
    expect(describePresetChanges(head, current, fields)).toEqual([
      "text of Alpha and Write tersely and well.",
      "options of Gamma"
    ])
    expect(describePresetChanges(head, current, [content("main"), content("a"), content("c")])).toEqual([
      "text of 3 prompts"
    ])
  })

  it("counts prompts added and deleted without listing their fields, and other settings", () => {
    const current = {
      prompts: [...head.prompts.filter((p) => p.identifier !== "c"), prompt("n", "New prompt")],
      order: [...head.order.filter((e) => e.identifier !== "c"), { identifier: "n", enabled: true }]
    }
    const fields = [
      valueField(["order"]),
      valueField(["prompts", "identifier=n"]),
      content("n"),
      valueField(["prompts", "identifier=c"]),
      textField(["utility_prompts", "new_chat_prompt"])
    ]
    expect(describePresetChanges(head, current, fields)).toEqual([
      "1 prompt added",
      "1 prompt deleted",
      "1 other setting"
    ])
  })
})

describe("promptLabel", () => {
  it("is the name, else the text's first words, else says it's unnamed", () => {
    expect(promptLabel("Pacing", "anything")).toEqual({ text: "Pacing", derived: false })
    expect(promptLabel(" ", "Write in close third person, past tense, always.")).toEqual({
      text: "Write in close third person, past…",
      derived: true
    })
    expect(promptLabel("", "Short one")).toEqual({ text: "Short one", derived: true })
    expect(promptLabel("", "  \n ")).toEqual({ text: "Unnamed prompt", derived: true })
    expect(promptLabel("", `${"x".repeat(80)}`).text).toHaveLength(48)
  })
})
