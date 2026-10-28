import type { PresetPrompt, PromptOrderEntry } from "./docs/preset.ts"

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

/** Older revisions remain readable without rewriting them. Off prompts keep their place. */
export function presetOrder(prompts: ReadonlyArray<PresetPrompt>, order: ReadonlyArray<PromptOrderEntry>) {
  const next = [...withMain({ prompts, order }).order]
  const included = new Set(next.map((e) => e.identifier))
  if (!included.has(newestMessage.identifier)) {
    const history = next.findIndex((e) => e.identifier === "chatHistory")
    next.splice(history < 0 ? next.length : history + 1, 0, { identifier: newestMessage.identifier, enabled: true })
    included.add(newestMessage.identifier)
  }
  const outside = new Set(prompts.map((p) => p.identifier).filter((id) => !included.has(id)))
  for (const identifier of sentOutsideTheOrder) if (outside.delete(identifier)) next.push({ identifier, enabled: true })
  for (const identifier of outside) next.push({ identifier, enabled: false })
  return next
}
