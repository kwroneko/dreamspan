// A workshop preset's structure (spec/WORKSHOP-CONTEXT.md §4): the pieces a workshop needs, and
// turning a story preset into one. The owner (2026-11-12): "It should definitely be possible to
// 'convert' an existing chat preset to workshop however." Converting makes a new preset; the
// original never changes.
import type { PresetDoc, PresetPrompt, PromptOrderEntry } from "./docs/preset.ts"

const piece = (identifier: string, name: string, marker: boolean): PresetPrompt => ({
  identifier,
  name,
  role: "system",
  content: "",
  // A marker the assembler doesn't fill yet sends nothing (`system_prompt` with an unknown
  // identifier); the instructions are the user's own text, sent where the order puts them.
  system_prompt: marker,
  marker,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: true
})

export interface WorkshopPiece {
  readonly prompt: PresetPrompt
  /** User-facing: what it is for. */
  readonly explanation: string
}

/** The pieces a workshop preset has beside the main prompt, the card and the history. */
export const workshopPieces = (): ReadonlyArray<WorkshopPiece> => [
  {
    prompt: piece("workspaceInstructions", "Workspace instructions", false),
    explanation: "Your standing instructions for the assistant, such as how you like cards written."
  },
  {
    prompt: piece("summaries", "Summaries", true),
    explanation: "Summaries of earlier messages and steps. Original steps stay available."
  },
  {
    prompt: piece("skillsIndex", "Skills", true),
    explanation: "The list of skills the assistant can use. Filled once skills exist."
  },
  {
    prompt: piece("cardSkills", "Card skills", true),
    explanation: "Skills and instructions the assistant's card carries. Filled once skills exist."
  }
]

export const WORKSHOP_PIECE_IDS: ReadonlySet<string> = new Set(workshopPieces().map((p) => p.prompt.identifier))

/** Story pieces a workshop has no use for, with why: dropped unless the user keeps them. */
const STORY_ONLY: Readonly<Record<string, string>> = {
  personaDescription: "Your persona's description, written for stories.",
  dialogueExamples: "The card's example dialogue, for a character's voice in a story.",
  scenario: "The card's scenario: where a story is set.",
  enhanceDefinitions: "Asks the model to add to a character's definitions, for stories.",
  nsfw: "A roleplay instruction.",
  jailbreak: "Post-history instructions written for roleplay."
}

/** Pieces a workshop keeps as they are: the assistant card's own and the conversation. */
const ALWAYS: ReadonlySet<string> = new Set([
  "main",
  "charDefinitions",
  "charDescription",
  "charPersonality",
  "chatHistory",
  "newestMessage",
  "worldInfoBefore",
  "worldInfoAfter"
])

export interface ConversionItem {
  readonly identifier: string
  readonly name: string
  readonly marker: boolean
  /** "story": dropped by default; "review": the user's own prompt, kept by default. */
  readonly kind: "story" | "review"
  readonly reason: string
  readonly content: string
}

/** The pieces the user decides about, in the preset's order; card and history pieces stay. */
export const conversionItems = (doc: Pick<PresetDoc, "prompts" | "order">): ReadonlyArray<ConversionItem> => {
  const byId = new Map(doc.prompts.map((p) => [p.identifier, p]))
  const ids = [...doc.order.map((e) => e.identifier), ...doc.prompts.map((p) => p.identifier)]
  return [...new Set(ids)].flatMap((identifier): Array<ConversionItem> => {
    const prompt = byId.get(identifier)
    if (!prompt || ALWAYS.has(identifier) || WORKSHOP_PIECE_IDS.has(identifier)) return []
    const story = STORY_ONLY[identifier]
    return [
      {
        identifier,
        name: prompt.name || identifier,
        marker: prompt.marker,
        kind: story ? "story" : "review",
        reason: story ?? "One of this preset's own prompts. Keep it if it still applies outside a story.",
        content: prompt.content
      }
    ]
  })
}

export interface ConversionChoice {
  readonly identifier: string
  readonly keep: boolean
  /** New text for a kept prompt; absent: unchanged. */
  readonly content?: string
}

/**
 * The workshop preset made from `doc`: dropped pieces leave the prompts and the order, kept ones
 * take their new text, and the workshop pieces are added after the main prompt and the card
 * (off, except the instructions when given). Items without a choice take their default.
 */
export const convertToWorkshop = <D extends Pick<PresetDoc, "prompts" | "order">>(
  doc: D,
  choices: ReadonlyArray<ConversionChoice>,
  instructions?: string
): D => {
  const items = new Map(conversionItems(doc).map((i) => [i.identifier, i]))
  const chosen = new Map(choices.map((c) => [c.identifier, c]))
  const keeps = (identifier: string) => {
    const item = items.get(identifier)
    if (!item) return true
    return chosen.get(identifier)?.keep ?? item.kind === "review"
  }
  const prompts = doc.prompts.flatMap((p) => {
    if (!keeps(p.identifier)) return []
    const content =
      p.identifier === "workspaceInstructions" && instructions !== undefined
        ? instructions.trim()
        : chosen.get(p.identifier)?.content
    return [content === undefined || p.marker ? p : { ...p, content }]
  })
  const order: Array<PromptOrderEntry> = doc.order
    .filter((e) => keeps(e.identifier))
    .map((e) =>
      e.identifier === "workspaceInstructions" && instructions !== undefined
        ? { ...e, enabled: instructions.trim() !== "" }
        : e
    )
  const added = workshopPieces().filter((p) => !prompts.some((q) => q.identifier === p.prompt.identifier))
  // After the card, else after main, else first.
  const anchor = Math.max(
    order.findIndex((e) => e.identifier === "charDefinitions"),
    order.findIndex((e) => e.identifier === "charPersonality"),
    order.findIndex((e) => e.identifier === "charDescription"),
    order.findIndex((e) => e.identifier === "main")
  )
  order.splice(
    anchor + 1,
    0,
    ...added.map((p) => ({
      identifier: p.prompt.identifier,
      enabled:
        p.prompt.identifier === "summaries" ||
        (p.prompt.identifier === "workspaceInstructions" && (instructions?.trim() ?? "") !== "")
    }))
  )
  return {
    ...doc,
    prompts: [
      ...prompts,
      ...added.map((p) =>
        p.prompt.identifier === "workspaceInstructions"
          ? { ...p.prompt, content: instructions?.trim() ?? "" }
          : p.prompt
      )
    ],
    order
  }
}
