import type { PresetPrompt, PromptOrderEntry } from "./docs/preset.ts"
import { SEND_NUDGE_PROMPT } from "./agentInstructions.ts"
import { endOfRequestText } from "./endOfRequest.ts"

/**
 * A prompt the app sends on its own, never from the order: the end-of-request texts (DESIGN
 * §2.2) and the agent's "When the reply wasn't sent" (spec/REPLY-CONTRACT.md §3.3).
 */
export const outsideTheOrder = (identifier: string) =>
  endOfRequestText(identifier) !== undefined || identifier === SEND_NUDGE_PROMPT.identifier

/** Main always has a slot, even in files and old revisions that left it out. */
export const mainPrompt: PresetPrompt = {
  identifier: "main",
  name: "Main Prompt",
  role: "system",
  content: "",
  system_prompt: true,
  marker: false,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: true
}

/** Materialize Main without enabling it or changing an existing Main's text or position. */
export function withMain<
  D extends { readonly prompts: ReadonlyArray<PresetPrompt>; readonly order: ReadonlyArray<PromptOrderEntry> }
>(doc: D): D {
  const hasPrompt = doc.prompts.some((p) => p.identifier === "main")
  const hasOrder = doc.order.some((e) => e.identifier === "main")
  if (hasPrompt && hasOrder) return doc
  return {
    ...doc,
    prompts: hasPrompt ? doc.prompts : [mainPrompt, ...doc.prompts],
    order: hasOrder ? doc.order : [{ identifier: "main", enabled: false }, ...doc.order]
  }
}

export const newestMessage: PresetPrompt = {
  identifier: "newestMessage",
  name: "Newest message",
  role: "user",
  content: "",
  system_prompt: true,
  marker: true,
  injection_position: "relative",
  injection_depth: 0,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: true
}

/** The speaker's card notes, movable like every other preset marker. */
export const ownTurnNotes: PresetPrompt = {
  ...newestMessage,
  identifier: "ownTurnNotes",
  name: "Own-turn notes",
  role: "system"
}

/**
 * The whole-card "Definitions" marker (DESIGN §5.0): each character in its labelled block and
 * each persona in its own. Never added to existing orders; the editor inserts it.
 */
export const charDefinitions: PresetPrompt = {
  identifier: "charDefinitions",
  name: "Definitions",
  role: "system",
  content: "",
  system_prompt: true,
  marker: true,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: true
}

/** The per-field markers the Definitions marker leaves empty when an order has both. */
export const perFieldMarkers: ReadonlyArray<string> = [
  "charDescription",
  "charPersonality",
  "scenario",
  "personaDescription"
]

/**
 * The markers ST sends even when its prompt order leaves them out: it appends them, in this
 * order, after the ordered prompts (preparePromptsForChatCompletion). Appended on here, so an
 * imported preset still sends them where ST does; any other prompt outside the order is off.
 */
export const sentOutsideTheOrder = [
  "worldInfoBefore",
  "worldInfoAfter",
  "charDescription",
  "charPersonality",
  "scenario",
  "personaDescription"
]

/**
 * Older revisions remain readable without rewriting them. Off prompts keep their place. The
 * end-of-request texts are never in the order (DESIGN §2.2).
 */
export function presetOrder(prompts: ReadonlyArray<PresetPrompt>, order: ReadonlyArray<PromptOrderEntry>) {
  const next = withMain({ prompts, order }).order.filter((e) => !outsideTheOrder(e.identifier))
  const included = new Set(next.map((e) => e.identifier))
  if (!included.has(newestMessage.identifier)) {
    const history = next.findIndex((e) => e.identifier === "chatHistory")
    next.splice(history < 0 ? next.length : history + 1, 0, { identifier: newestMessage.identifier, enabled: true })
    included.add(newestMessage.identifier)
  }
  const outside = new Set(prompts.map((p) => p.identifier).filter((id) => !included.has(id) && !outsideTheOrder(id)))
  for (const identifier of sentOutsideTheOrder) if (outside.delete(identifier)) next.push({ identifier, enabled: true })
  for (const identifier of outside) next.push({ identifier, enabled: false })
  return next
}

/**
 * The "Agent instructions" prompt (owner, 2026-11-17): what an agent reply is told about its
 * tools and how to give its reply, held, edited and placed like any prompt. Sent only when the
 * reply uses tools, never in a workshop (its own text is `workshopTurn`). Empty text sends the
 * app's default, which follows the chat's tools and reply setting. Last among the order's
 * prompts that are on, it goes with the end-of-request message, where a preset without it sends
 * the default (the fallback); anywhere else it's its own message there.
 */
export const agentInstructionsPrompt: PresetPrompt = {
  identifier: "agentInstructions",
  name: "Agent instructions",
  role: "system",
  content: "",
  system_prompt: true,
  marker: false,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: true
}

/**
 * Where a preset sends the agent instructions: `end` with the end-of-request message (also a
 * preset without the prompt), `order` at its place in the order, `off` not at all. `prompt`:
 * the preset's own, or null when it has none.
 */
export function agentInstructionsPlace(
  prompts: ReadonlyArray<PresetPrompt>,
  order: ReadonlyArray<PromptOrderEntry>
): { readonly place: "end" | "order" | "off"; readonly prompt: PresetPrompt | null } {
  const prompt = prompts.find((p) => p.identifier === agentInstructionsPrompt.identifier) ?? null
  if (prompt === null) return { place: "end", prompt: null }
  const ordered = presetOrder(prompts, order)
  const at = ordered.findIndex((e) => e.identifier === agentInstructionsPrompt.identifier)
  if (at < 0 || !ordered[at]!.enabled) return { place: "off", prompt }
  return { place: ordered.slice(at + 1).some((e) => e.enabled) ? "order" : "end", prompt }
}
