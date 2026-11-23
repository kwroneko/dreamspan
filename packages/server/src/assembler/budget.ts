import type { BudgetOrigins } from "@dreamspan/shared/inspectorApi.ts"
import { need, type Assembly } from "./pipeline.ts"
import type { ModelInput } from "./types.ts"
import { ASSUMED_CONTEXT } from "@dreamspan/shared/modelSettings.ts"

/**
 * The input budget: the context size within the model's window, less the reply length. Both are
 * the model's settings (`withModelSettings` puts them in the preset view, replacing whatever an
 * imported preset carried): its "Context to send", else its window.
 */
export const contextBudget = (assembly: Assembly) => {
  const { samplers } = need(assembly, "preset").doc
  const model = assembly.model
  const context = Math.min(samplers.openai_max_context, model?.context ?? Number.POSITIVE_INFINITY)
  return context - samplers.openai_max_tokens
}

/**
 * What limits the context, with its size in tokens, for the notes on what was left out: the
 * model's own "Context to send", its window, or the window assumed when nothing reports one.
 */
export const contextLimit = (assembly: Assembly) => {
  const size = contextBudget(assembly) + need(assembly, "preset").doc.samplers.openai_max_tokens
  const model = assembly.model
  const tokens = `(${size.toLocaleString("en-US")} tokens)`
  if (model?.settings?.samplers?.openai_max_context === size) return `the context size set for this model ${tokens}`
  if (model?.context === size) return `this model's context window ${tokens}`
  if (model && model.context == null && size === ASSUMED_CONTEXT)
    return `the context window assumed for this model ${tokens}`
  return `the context size ${tokens}`
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
