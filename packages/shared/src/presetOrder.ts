import type { PresetPrompt, PromptOrderEntry } from "./docs/preset.ts"

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
  const next = [...order]
  const included = new Set(order.map((e) => e.identifier))
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
