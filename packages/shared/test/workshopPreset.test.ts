// Converting a story preset to a workshop preset (spec/WORKSHOP-CONTEXT.md §4.4): synthetic prompts only.
import { describe, expect, it } from "vitest"
import type { PresetPrompt } from "../src/docs/preset.ts"
import { conversionItems, convertToWorkshop, WORKSHOP_PIECE_IDS } from "../src/workshopPreset.ts"

const prompt = (identifier: string, content = "", marker = false): PresetPrompt => ({
  identifier,
  name: identifier,
  role: "system",
  content,
  system_prompt: marker,
  marker,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: false
})

const story = {
  prompts: [
    prompt("main", "Write the next reply."),
    prompt("charDescription", "", true),
    prompt("personaDescription", "", true),
    prompt("scenario", "", true),
    prompt("style", "Use short paragraphs."),
    prompt("chatHistory", "", true),
    prompt("jailbreak", "Stay in character.")
  ],
  order: ["main", "charDescription", "personaDescription", "scenario", "style", "chatHistory", "jailbreak"].map(
    (identifier) => ({ identifier, enabled: true })
  )
}

describe("workshop preset conversion", () => {
  it("lists the story pieces to drop and the preset's own prompts to review; card and history stay", () => {
    expect(conversionItems(story).map((i) => [i.identifier, i.kind])).toEqual([
      ["personaDescription", "story"],
      ["scenario", "story"],
      ["style", "review"],
      ["jailbreak", "story"]
    ])
  })

  it("drops story pieces and keeps the user's prompts by default, adding the workshop pieces after the card", () => {
    const converted = convertToWorkshop(story, [])
    expect(converted.order.map((e) => e.identifier)).toEqual([
      "main",
      "charDescription",
      "workspaceInstructions",
      "summaries",
      "skillsIndex",
      "cardSkills",
      "style",
      "chatHistory"
    ])
    expect(
      converted.order.filter((e) => WORKSHOP_PIECE_IDS.has(e.identifier) && e.enabled).map((e) => e.identifier)
    ).toEqual(["summaries"])
    expect(converted.prompts.map((p) => p.identifier)).not.toContain("scenario")
    // The original is untouched.
    expect(story.order).toHaveLength(7)
  })

  it("follows the user's choices: keep a story piece, drop a prompt, reword one, give instructions", () => {
    const converted = convertToWorkshop(
      story,
      [
        { identifier: "jailbreak", keep: true, content: "Answer plainly." },
        { identifier: "style", keep: false },
        { identifier: "scenario", keep: true, content: "ignored for a marker" }
      ],
      "  Keep cards under 400 tokens.  "
    )
    const byId = new Map(converted.prompts.map((p) => [p.identifier, p]))
    expect(byId.get("jailbreak")?.content).toBe("Answer plainly.")
    expect(byId.has("style")).toBe(false)
    expect(byId.get("scenario")?.content).toBe("")
    expect(byId.get("workspaceInstructions")?.content).toBe("Keep cards under 400 tokens.")
    expect(converted.order.find((e) => e.identifier === "workspaceInstructions")?.enabled).toBe(true)
  })

  it("converting a workshop preset again adds nothing twice", () => {
    const once = convertToWorkshop(story, [])
    const twice = convertToWorkshop(once, [])
    expect(twice.order.map((e) => e.identifier)).toEqual(once.order.map((e) => e.identifier))
    expect(twice.prompts).toHaveLength(once.prompts.length)
  })

  it("applies replacement instructions when converting an existing workshop preset", () => {
    const once = convertToWorkshop(story, [], "Keep the old instructions.")
    const twice = convertToWorkshop(once, [], "Use the new instructions.")
    expect(twice.prompts.find((p) => p.identifier === "workspaceInstructions")?.content).toBe(
      "Use the new instructions."
    )
    expect(twice.order.find((p) => p.identifier === "workspaceInstructions")?.enabled).toBe(true)
    expect(once.prompts.find((p) => p.identifier === "workspaceInstructions")?.content).toBe(
      "Keep the old instructions."
    )
    const cleared = convertToWorkshop(once, [], "")
    expect(cleared.prompts.find((p) => p.identifier === "workspaceInstructions")?.content).toBe("")
    expect(cleared.order.find((p) => p.identifier === "workspaceInstructions")?.enabled).toBe(false)
    expect(convertToWorkshop(once, []).prompts).toEqual(once.prompts)
  })

  it("puts the pieces first when there is neither a main prompt nor a card", () => {
    const converted = convertToWorkshop(
      { prompts: [prompt("chatHistory", "", true)], order: [{ identifier: "chatHistory", enabled: true }] },
      []
    )
    expect(converted.order.map((e) => e.identifier)).toEqual([...WORKSHOP_PIECE_IDS, "chatHistory"])
  })
})
