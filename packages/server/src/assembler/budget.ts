import { need, type Assembly } from "./pipeline.ts"

/** What the preset's budget allows: its context size, within the model's, less its response length. */
export const contextBudget = (assembly: Assembly) => {
  const { samplers } = need(assembly, "preset").doc
  const model = assembly.model
  const context = Math.min(samplers.openai_max_context, model?.context ?? Number.POSITIVE_INFINITY)
  return context - samplers.openai_max_tokens
}

/** ST's default lore budget; our layouts also enforce a stable tail allowance. */
export const loreBudget = (assembly: Assembly) => Math.max(1, Math.round(contextBudget(assembly) * 0.25))

/** [P] Size eligible stored content, independent of matching, probability and macro draws. */
export const loreAllowance = (assembly: Assembly) => {
  let characters = 0
  let entries = 0
  for (const book of assembly.lorebooks ?? []) {
    for (const entry of book.doc.entries) {
      if (!entry.enabled || (!entry.constant && !entry.keys.length) || !entry.content) continue
      characters += entry.content.length
      entries++
    }
  }
  // Joined nonempty contents plus one system message. Expansion overflow is cut, never borrowed.
  return Math.min(loreBudget(assembly), entries ? Math.ceil((characters + entries - 1) / 4) + 3 : 0)
}
