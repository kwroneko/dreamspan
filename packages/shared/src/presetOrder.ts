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

/** Older revisions remain readable without rewriting them. Off prompts keep their place. */
export function presetOrder(prompts: ReadonlyArray<PresetPrompt>, order: ReadonlyArray<PromptOrderEntry>) {
  const next = [...order]
  const included = new Set(order.map((e) => e.identifier))
  if (!included.has(newestMessage.identifier)) {
    const history = next.findIndex((e) => e.identifier === "chatHistory")
    next.splice(history < 0 ? next.length : history + 1, 0, { identifier: newestMessage.identifier, enabled: true })
    included.add(newestMessage.identifier)
  }
  for (const p of prompts)
    if (!included.has(p.identifier)) {
      next.push({ identifier: p.identifier, enabled: false })
      included.add(p.identifier)
    }
  return next
}
