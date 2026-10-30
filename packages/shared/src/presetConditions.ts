// Conditioned prompts (DESIGN §2.2, owner 2026-10-27): every prompt has a condition (always,
// as a character, as {{user}}, with a direction) beside ST's per-prompt triggers (generation
// types, owner 2026-10-28). Who writes next and the direction itself are the end-of-request
// instruction (`endOfRequest.ts`, owner 2026-10-29): three texts of the preset outside the order.
// ST's group nudge and impersonation prompt map onto two of them; the import and every read of a
// stored preset go through the same conversion.
import type { PresetDoc, PresetPrompt, PromptCondition } from "./docs/preset.ts"
import {
  DIRECTION_PROMPT,
  END_OF_REQUEST,
  endOfRequestText,
  GROUP_NUDGE,
  IMPERSONATION_PROMPT
} from "./endOfRequest.ts"
import { withMain } from "./presetOrder.ts"

const prompt = (fields: Pick<PresetPrompt, "identifier" | "name" | "role" | "content">): PresetPrompt => ({
  ...fields,
  system_prompt: false,
  marker: false,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: false
})

/** ST's generation types, in the order its prompt editor lists them, with the editor's names. */
export const TRIGGERS = [
  { value: "normal", label: "Normal" },
  { value: "continue", label: "Continue" },
  { value: "impersonate", label: "Impersonate" },
  { value: "swipe", label: "Swipe" },
  { value: "regenerate", label: "Regenerate" },
  { value: "quiet", label: "Quiet" }
] as const

/** The prompt's condition; absent is always. */
export const conditionOf = (prompt: PresetPrompt): PromptCondition => prompt.condition ?? "always"

/**
 * Whether the prompt's ST triggers let it be sent for this generation type, as ST's
 * `shouldTrigger`: none is every type. Our types are ST's, except that a new version of a reply
 * is both ST's swipe and its regenerate (there's no regenerate that deletes the reply), and a
 * summary is ST's quiet generation.
 */
export const triggersFor = (prompt: PresetPrompt, type: string): boolean => {
  const triggers = prompt.injection_trigger
  if (triggers.length === 0) return true
  return type === "swipe" ? triggers.includes("swipe") || triggers.includes("regenerate") : triggers.includes(type)
}

/**
 * The triggers that carry a condition to ST, which has none: the generation types the prompt
 * is sent for under its condition and its own triggers. A condition triggers can't express
 * (with a direction) keeps the prompt's own.
 */
export const triggersWithCondition = (prompt: PresetPrompt): Array<string> => {
  const condition = conditionOf(prompt)
  if (condition === "always" || condition === "with_direction") return [...prompt.injection_trigger]
  const types: ReadonlyArray<string> =
    condition === "as_user" ? ["impersonate"] : ["normal", "swipe", "regenerate", "continue"]
  if (prompt.injection_trigger.length === 0) return [...types]
  const both = prompt.injection_trigger.filter((t) => types.includes(t))
  return both.length > 0 ? both : [...prompt.injection_trigger]
}

/** A prompt's text reads the direction, so it carries one wherever it's sent. */
const readsDirection = (text: string) => /\{\{\s*direction\s*\}\}/i.test(text)

/** `{{char}}` (group nudge) or `{{user}}` (impersonation) as `{{speaker}}`, and back for export. */
const toSpeaker = (text: string, macro: "char" | "user") =>
  text.replace(new RegExp(`\\{\\{\\s*${macro}\\s*\\}\\}`, "gi"), "{{speaker}}")
export const fromSpeaker = (text: string, macro: "char" | "user") =>
  text.replace(/\{\{\s*speaker\s*\}\}/gi, `{{${macro}}}`)

export interface ConditionChange {
  readonly kind: "group_nudge" | "impersonation"
}

type ConditionedDoc = Pick<PresetDoc, "prompts" | "order" | "utility_prompts">

/**
 * The preset with its end-of-request texts (DESIGN §2.2): ST's group nudge and impersonation
 * prompt move from the utility prompts into `groupNudge` and `impersonationPrompt` (their
 * macros as `{{speaker}}`), any of the three still missing gets its default, and none of them
 * is in the order. The utility fields are emptied so the move happens once. Pure: a preset
 * already converted comes back as it is.
 */
export const withEndOfRequest = <D extends ConditionedDoc>(doc: D): { doc: D; changes: Array<ConditionChange> } => {
  doc = withMain(doc)
  const changes: Array<ConditionChange> = []
  const utility = { ...doc.utility_prompts }
  const ids = new Set(doc.prompts.map((p) => p.identifier))
  const moved = new Map<string, string>()
  const move = (field: "group_nudge_prompt" | "impersonation_prompt", identifier: string, macro: "char" | "user") => {
    const text = utility[field]
    if (!text) return
    utility[field] = ""
    if (ids.has(identifier)) return
    moved.set(identifier, toSpeaker(text, macro))
    changes.push({ kind: macro === "char" ? "group_nudge" : "impersonation" })
  }
  move("group_nudge_prompt", GROUP_NUDGE, "char")
  move("impersonation_prompt", IMPERSONATION_PROMPT, "user")
  const added = END_OF_REQUEST.filter((text) => !ids.has(text.identifier)).map((text) =>
    prompt({
      identifier: text.identifier,
      name: text.label,
      role: "user",
      content: moved.get(text.identifier) ?? text.content
    })
  )
  const inOrder = doc.order.some((e) => endOfRequestText(e.identifier))
  const emptied =
    utility.group_nudge_prompt !== doc.utility_prompts.group_nudge_prompt ||
    utility.impersonation_prompt !== doc.utility_prompts.impersonation_prompt
  if (added.length === 0 && !inOrder && !emptied) return { doc, changes }
  return {
    doc: {
      ...doc,
      prompts: [...doc.prompts, ...added],
      order: inOrder ? doc.order.filter((e) => !endOfRequestText(e.identifier)) : doc.order,
      utility_prompts: utility
    },
    changes
  }
}

/**
 * What the preset editor warns about (DESIGN §2.2): the direction text doesn't read
 * `{{direction}}`, so a direction the user gives would be lost.
 */
export const presetWarnings = (prompts: ReadonlyMap<string, PresetPrompt>): { directionLost: boolean } => ({
  directionLost: !readsDirection(prompts.get(DIRECTION_PROMPT)?.content ?? "")
})

/** The editor's names for the conditions; the inspector says which one admitted a prompt. */
export const CONDITION_LABELS: Readonly<Record<PromptCondition, string>> = {
  always: "Always",
  as_character: "When writing as a character",
  as_user: "When writing as {{user}}",
  with_direction: "When there's a direction"
}

/**
 * A library document as the editors read it: a preset comes with its end-of-request texts,
 * and the first save writes them (no new revision before that).
 */
export const editedDoc = <D extends Readonly<Record<string, unknown>>>(kind: string, doc: D): D =>
  kind === "preset" && Array.isArray(doc.prompts) && Array.isArray(doc.order) && doc.utility_prompts
    ? (withEndOfRequest(doc as unknown as ConditionedDoc).doc as unknown as D)
    : doc
