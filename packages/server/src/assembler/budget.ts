import type { BudgetOrigins } from "@rp/shared/inspectorApi.ts"
import { need, type Assembly } from "./pipeline.ts"
import type { ModelInput } from "./types.ts"

/** What the preset's budget allows: its context size, within the model's, less its response length. */
export const contextBudget = (assembly: Assembly) => {
  const { samplers } = need(assembly, "preset").doc
  const model = assembly.model
  const context = Math.min(samplers.openai_max_context, model?.context ?? Number.POSITIVE_INFINITY)
  return context - samplers.openai_max_tokens
}

/** The target includes the same response reserve as the maximum. */
export const targetBudget = (assembly: Assembly) => {
  const preset = need(assembly, "preset").doc
  const maximum = contextBudget(assembly) + preset.samplers.openai_max_tokens
  return Math.min(maximum, preset.context_target ?? Math.floor(maximum * 0.8)) - preset.samplers.openai_max_tokens
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

/**
 * Where the budget's context size, reply reserve and target come from (`withModelSettings`): the
 * model's own setting, or for the context size its window, from whichever source gave it.
 */
export const budgetOrigins = (model: ModelInput | null): BudgetOrigins => {
  const samplers = model?.settings?.samplers
  const window = model?.context ?? null
  const setting = samplers?.openai_max_context
  const source = model?.contextSource ?? "unknown"
  return {
    context:
      setting !== undefined && (window === null || setting <= window)
        ? "setting"
        : // A provider sets only caching fields, never the window.
          source === "unknown" || source === "provider" || window === null
          ? "assumed"
          : source,
    ...(model?.contextCatalog && source === "catalog" ? { catalog: model.contextCatalog } : {}),
    reserve: samplers?.openai_max_tokens === undefined ? "default" : "setting",
    target: model?.settings?.context_target === undefined ? "default" : "setting",
    model: model ? { connectionId: model.connectionId, modelId: model.modelId } : null
  }
}
