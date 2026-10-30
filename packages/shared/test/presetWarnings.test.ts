// The preset editor's warnings and the end-of-request texts' normalization (DESIGN §2.2): a
// direction text without {{direction}} loses the direction; every read gives a preset its three
// texts outside the order.
import { describe, expect, it } from "vitest"
import type { PresetDoc, PresetPrompt } from "../src/docs/preset.ts"
import { DIRECTION_PROMPT, DIRECTION_TEXT, GROUP_NUDGE, IMPERSONATION_PROMPT, TURN_TEXT } from "../src/endOfRequest.ts"
import { presetWarnings, withEndOfRequest } from "../src/presetConditions.ts"
import { presetOrder } from "../src/presetOrder.ts"

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

const doc = (
  prompts: ReadonlyArray<PresetPrompt>,
  utility: Partial<PresetDoc["utility_prompts"]> = {}
): Pick<PresetDoc, "prompts" | "order" | "utility_prompts"> => ({
  prompts,
  order: prompts.map((p) => ({ identifier: p.identifier, enabled: true })),
  utility_prompts: { group_nudge_prompt: "", impersonation_prompt: "", ...utility } as PresetDoc["utility_prompts"]
})

describe("preset warnings", () => {
  const warnings = (content: string | null) =>
    presetWarnings(new Map(content === null ? [] : [[DIRECTION_PROMPT, prompt(DIRECTION_PROMPT, { content })]]))

  it("warns when the direction text doesn't read {{direction}}", () => {
    expect(warnings(DIRECTION_TEXT).directionLost).toBe(false)
    expect(warnings("[Next: {{ Direction }}]").directionLost).toBe(false)
    expect(warnings("[What happens next.]").directionLost).toBe(true)
    expect(warnings("").directionLost).toBe(true)
    expect(warnings(null).directionLost).toBe(true)
  })

  it("names the switched-on prompts whose condition and generation types never meet", () => {
    const prompts = [
      prompt("asCardNormal", { condition: "as_user", injection_trigger: ["normal"] }),
      prompt("asCardContinue", { condition: "as_user", injection_trigger: ["normal", "continue"] }),
      prompt("asCharacterImpersonate", { condition: "as_character", injection_trigger: ["impersonate"] }),
      prompt("asCharacterRegenerate", { condition: "as_character", injection_trigger: ["regenerate"] }),
      prompt("directionQuiet", { condition: "with_direction", injection_trigger: ["quiet"] }),
      prompt("alwaysQuiet", { injection_trigger: ["quiet"] }),
      prompt("asCardAny", { condition: "as_user" }),
      prompt("offNever", { condition: "as_user", injection_trigger: ["swipe"] })
    ]
    const order = prompts.map((p) => ({ identifier: p.identifier, enabled: p.identifier !== "offNever" }))
    const { neverSent } = presetWarnings(new Map(prompts.map((p) => [p.identifier, p])), order)
    expect(neverSent.map((p) => p.identifier)).toEqual(["asCardNormal", "asCharacterImpersonate", "directionQuiet"])
  })
})

describe("the end-of-request texts", () => {
  it("are created with their defaults, outside the order, and a converted preset comes back as it is", () => {
    const { doc: converted, changes } = withEndOfRequest(doc([prompt("main"), prompt("chatHistory", { marker: true })]))
    expect(changes).toEqual([])
    const byId = new Map(converted.prompts.map((p) => [p.identifier, p]))
    expect(byId.get(GROUP_NUDGE)).toMatchObject({ role: "user", content: TURN_TEXT, name: "When a character speaks" })
    expect(byId.get(IMPERSONATION_PROMPT)).toMatchObject({ content: TURN_TEXT, name: "When your card speaks" })
    expect(byId.get(DIRECTION_PROMPT)).toMatchObject({ content: DIRECTION_TEXT })
    expect(converted.order.map((e) => e.identifier)).toEqual(["main", "chatHistory"])
    // The editor's order doesn't list them either.
    expect(presetOrder(converted.prompts, converted.order).map((e) => e.identifier)).toEqual([
      "main",
      "chatHistory",
      "newestMessage"
    ])
    expect(withEndOfRequest(converted).doc).toBe(converted)
  })

  it("takes ST's group nudge and impersonation prompt from the utility prompts, once", () => {
    const { doc: converted, changes } = withEndOfRequest(
      doc([prompt("main")], {
        group_nudge_prompt: "[Write the next reply only as {{char}}.]",
        impersonation_prompt: "[Write as {{user}}.]"
      })
    )
    expect(changes.map((c) => c.kind)).toEqual(["group_nudge", "impersonation"])
    const byId = new Map(converted.prompts.map((p) => [p.identifier, p]))
    expect(byId.get(GROUP_NUDGE)!.content).toBe("[Write the next reply only as {{speaker}}.]")
    expect(byId.get(IMPERSONATION_PROMPT)!.content).toBe("[Write as {{speaker}}.]")
    expect(converted.utility_prompts.group_nudge_prompt).toBe("")
    expect(converted.utility_prompts.impersonation_prompt).toBe("")
  })

  it("leaves the order of a preset that listed them, keeping their text", () => {
    const nudge = prompt(GROUP_NUDGE, { content: "[Mine.]", condition: "as_character" })
    const { doc: converted } = withEndOfRequest(doc([prompt("main"), prompt("chatHistory"), nudge]))
    expect(converted.order.map((e) => e.identifier)).toEqual(["main", "chatHistory"])
    expect(converted.prompts.find((p) => p.identifier === GROUP_NUDGE)!.content).toBe("[Mine.]")
  })
})
