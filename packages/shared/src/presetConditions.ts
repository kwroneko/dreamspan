// Conditioned prompts (DESIGN §2.2, owner 2026-10-27): who the model writes as and the
// one-turn direction reach the model through ordinary preset prompts with conditions. ST's
// prompt triggers, group nudge and impersonation prompt map onto them; the import and the
// read of a preset saved before conditions existed go through the same conversion.
import type { PresetDoc, PresetPrompt, PromptCondition, PromptOrderEntry } from "./docs/preset.ts"
import { newestMessage, presetOrder } from "./presetOrder.ts"

export const GROUP_NUDGE = "groupNudge"
export const IMPERSONATION_PROMPT = "impersonationPrompt"
const DIRECTION_PROMPT = "direction"

/** The default direction prompt, user role (DESIGN §2.2). */
export const DIRECTION_TEXT =
  "[The user has written a direction for {{speaker}}'s next message. It is not part of the story; follow it closely: {{direction}}]"

/** The user turn the assembler adds when a request would otherwise end on an assistant message. */
export const LAST_TURN_TEXT = "[Write {{speaker}}'s next message.]"

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

export const directionPrompt: PresetPrompt = {
  ...prompt({ identifier: DIRECTION_PROMPT, name: "Direction", role: "user", content: DIRECTION_TEXT }),
  condition: "with_direction",
  added_on_import: true
}

const CHARACTER_TYPES = ["normal", "swipe", "regenerate"]

/**
 * ST's triggers as a condition: none is always; impersonation alone is writing as `{{user}}`;
 * normal, swipe or regenerate without impersonation is writing as a character; both are always,
 * and so are triggers naming only Continue or summarization, which keep limiting the prompt to
 * those (`triggersFor`).
 */
export const conditionFromTriggers = (triggers: ReadonlyArray<string>): PromptCondition => {
  const user = triggers.includes("impersonate")
  const character = triggers.some((t) => CHARACTER_TYPES.includes(t))
  return user && !character ? "as_user" : character && !user ? "as_character" : "always"
}

/** The prompt's condition: its own, else as its ST triggers map. */
export const conditionOf = (prompt: PresetPrompt): PromptCondition =>
  prompt.condition ?? conditionFromTriggers(prompt.injection_trigger)

/**
 * Whether the prompt's ST triggers let it be sent for this generation type. The condition
 * replaces them for normal generations, swipes and impersonation; a prompt naming only
 * Continue or summarization (`quiet`) is still sent only for those, and those types send
 * only the prompts that name them, as in ST.
 */
export const triggersFor = (prompt: PresetPrompt, type: string): boolean => {
  const triggers = prompt.injection_trigger
  if (triggers.length === 0) return true
  if (type === "continue" || type === "quiet") return triggers.includes(type)
  return triggers.some((t) => t === "impersonate" || CHARACTER_TYPES.includes(t))
}

/** A prompt's text reads the direction, so it carries one wherever it's sent. */
export const readsDirection = (text: string) => /\{\{\s*direction\s*\}\}/i.test(text)

/** `{{char}}` (group nudge) or `{{user}}` (impersonation) as `{{speaker}}`, and back for export. */
const toSpeaker = (text: string, macro: "char" | "user") =>
  text.replace(new RegExp(`\\{\\{\\s*${macro}\\s*\\}\\}`, "gi"), "{{speaker}}")
export const fromSpeaker = (text: string, macro: "char" | "user") =>
  text.replace(/\{\{\s*speaker\s*\}\}/gi, `{{${macro}}}`)

export interface ConditionChange {
  readonly kind: "group_nudge" | "impersonation" | "direction"
}

type ConditionedDoc = Pick<PresetDoc, "prompts" | "order" | "utility_prompts">

/**
 * The preset with ST's group nudge and impersonation prompt as conditioned prompts right after
 * the history (where ST sends them), their utility fields emptied so the conversion happens
 * once, and the default direction prompt last, unless it has one. Pure: a preset already
 * converted comes back as it is.
 */
export const withConditions = <D extends ConditionedDoc>(doc: D): { doc: D; changes: Array<ConditionChange> } => {
  const changes: Array<ConditionChange> = []
  const utility = { ...doc.utility_prompts }
  const ids = new Set(doc.prompts.map((p) => p.identifier))
  const added: Array<PresetPrompt> = []
  const nudge = utility.group_nudge_prompt
  if (nudge) {
    utility.group_nudge_prompt = ""
    if (!ids.has(GROUP_NUDGE)) {
      added.push({
        ...prompt({ identifier: GROUP_NUDGE, name: "Group nudge", role: "system", content: toSpeaker(nudge, "char") }),
        condition: "as_character"
      })
      changes.push({ kind: "group_nudge" })
    }
  }
  const impersonation = utility.impersonation_prompt
  if (impersonation) {
    utility.impersonation_prompt = ""
    if (!ids.has(IMPERSONATION_PROMPT)) {
      added.push({
        ...prompt({
          identifier: IMPERSONATION_PROMPT,
          name: "Impersonation prompt",
          role: "system",
          content: toSpeaker(impersonation, "user")
        }),
        condition: "as_user"
      })
      changes.push({ kind: "impersonation" })
    }
  }
  const direction = !ids.has(DIRECTION_PROMPT)
  if (direction) changes.push({ kind: "direction" })
  if (!nudge && !impersonation && !direction) return { doc, changes }
  const prompts = [...doc.prompts]
  let order: Array<PromptOrderEntry> = [...doc.order]
  if (added.length > 0 || direction) {
    // The order as it reads, with the newest-message marker where older revisions imply it.
    order = presetOrder(prompts, order)
    if (!ids.has(newestMessage.identifier)) prompts.push(newestMessage)
  }
  if (added.length > 0) {
    const history = order.findIndex((e) => e.identifier === "chatHistory")
    const after =
      history < 0
        ? order.length
        : order[history + 1]?.identifier === newestMessage.identifier
          ? history + 2
          : history + 1
    // Before the direction prompt, as a fresh import lists them, so an export reimports the same.
    const at = prompts.findIndex((p) => p.identifier === DIRECTION_PROMPT)
    prompts.splice(at < 0 ? prompts.length : at, 0, ...added)
    order.splice(after, 0, ...added.map((p) => ({ identifier: p.identifier, enabled: true })))
  }
  if (direction) {
    prompts.push(directionPrompt)
    order.push({ identifier: DIRECTION_PROMPT, enabled: true })
  }
  return { doc: { ...doc, prompts, order, utility_prompts: utility }, changes }
}

/**
 * What the preset editor warns about (DESIGN §2.2), for the order as it reads: `endsOn`, the
 * prompt a plain character turn ends on after the history, when that's an assistant prompt and
 * nothing prefills (the assembler then adds a user turn), and whether any prompt that's on sends the
 * direction. A plain turn has no direction, so the direction prompt last in an imported preset
 * doesn't hide an assistant prompt before it.
 */
export const presetWarnings = (
  order: ReadonlyArray<PromptOrderEntry>,
  prompts: ReadonlyMap<string, PresetPrompt>,
  prefill: string
): { endsOn: PresetPrompt | null; direction: boolean } => {
  const history = order.findIndex((e) => e.identifier === "chatHistory")
  const sent = order.flatMap((e, index) => {
    const prompt = prompts.get(e.identifier)
    return e.enabled && prompt && !prompt.marker && prompt.content.trim() !== "" ? [{ index, prompt }] : []
  })
  const last = sent
    .filter(
      ({ index, prompt }) =>
        index > history &&
        prompt.injection_position === "relative" &&
        (conditionOf(prompt) === "always" || conditionOf(prompt) === "as_character") &&
        triggersFor(prompt, "normal")
    )
    .findLast(({ prompt }) => prompt.role !== "system")?.prompt
  return {
    endsOn: history >= 0 && last?.role === "assistant" && prefill.trim() === "" ? last : null,
    direction: sent.some(({ prompt }) => readsDirection(prompt.content))
  }
}

/** The editor's names for the conditions; the inspector says which one admitted a prompt. */
export const CONDITION_LABELS: Readonly<Record<PromptCondition, string>> = {
  always: "Always",
  as_character: "When writing as a character",
  as_user: "When writing as {{user}}",
  with_direction: "When there's a direction"
}

/**
 * A library document as the editors read it: a preset saved before conditions existed comes
 * converted, and the first save writes it (no new revision before that).
 */
export const editedDoc = <D extends Readonly<Record<string, unknown>>>(kind: string, doc: D): D =>
  kind === "preset" && Array.isArray(doc.prompts) && Array.isArray(doc.order) && doc.utility_prompts
    ? (withConditions(doc as unknown as ConditionedDoc).doc as unknown as D)
    : doc
