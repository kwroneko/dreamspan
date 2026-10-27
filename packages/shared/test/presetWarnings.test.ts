// The preset editor's warnings (DESIGN §2.2): a preset whose prompts after the history end on
// an assistant prompt without a prefill, and one with no prompt sending the direction.
import { describe, expect, it } from "vitest"
import type { PresetPrompt, PromptOrderEntry } from "../src/docs/preset.ts"
import { directionPrompt, presetWarnings } from "../src/presetConditions.ts"

const prompt = (identifier: string, fields: Partial<PresetPrompt> = {}): PresetPrompt => ({
  identifier,
  name: identifier,
  role: "system",
  content: `${identifier} text`,
  system_prompt: false,
  marker: false,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: false,
  ...fields
})

const warnings = (prompts: ReadonlyArray<PresetPrompt>, prefill = "", off: ReadonlyArray<string> = []) =>
  presetWarnings(
    prompts.map((p): PromptOrderEntry => ({ identifier: p.identifier, enabled: !off.includes(p.identifier) })),
    new Map(prompts.map((p) => [p.identifier, p])),
    prefill
  )

const history = prompt("chatHistory", { marker: true, content: "" })
const ending = prompt("jailbreak", { role: "assistant", content: "Understood." })

describe("preset warnings", () => {
  it("an assistant prompt after the history warns, even with the imported direction prompt last", () => {
    const result = warnings([prompt("main"), history, ending, directionPrompt])
    expect(result.endsOn?.identifier).toBe("jailbreak")
    expect(result.direction).toBe(true)
  })

  it("a prefill, a user prompt a plain turn sends, or the prompt being off: no warning", () => {
    expect(warnings([history, ending, directionPrompt], "Sure,").endsOn).toBeNull()
    expect(warnings([history, ending, prompt("tail", { role: "user" })]).endsOn).toBeNull()
    expect(warnings([history, ending], "", ["jailbreak"]).endsOn).toBeNull()
    // System prompts after it don't change which turn the request ends on.
    expect(warnings([history, ending, prompt("note")]).endsOn?.identifier).toBe("jailbreak")
  })

  it("a user prompt sent only as {{user}} or only on Continue doesn't hide the assistant ending", () => {
    const asUser = prompt("asUser", { role: "user", condition: "as_user" })
    const onContinue = prompt("onContinue", { role: "user", injection_trigger: ["continue"] })
    expect(warnings([history, ending, asUser, onContinue]).endsOn?.identifier).toBe("jailbreak")
    const asCharacter = prompt("asCharacter", { role: "user", condition: "as_character" })
    expect(warnings([history, ending, asCharacter]).endsOn).toBeNull()
  })

  it("no prompt that's on reads {{direction}}", () => {
    expect(warnings([history, directionPrompt], "", ["direction"]).direction).toBe(false)
    expect(warnings([history, prompt("mine", { content: "Do this: {{ direction }}" })]).direction).toBe(true)
  })
})
