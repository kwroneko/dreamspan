import { need, type Assembly } from "./pipeline.ts"

/** What the preset's budget allows: its context size, within the model's, less its response length. */
export const contextBudget = (assembly: Assembly) => {
  const { samplers } = need(assembly, "preset").doc
  const model = assembly.model
  const context = Math.min(samplers.openai_max_context, model?.context ?? Number.POSITIVE_INFINITY)
  return context - samplers.openai_max_tokens
}

/** [P] Fixed allowance, including the tail message overhead in our layouts. */
export const loreAllowance = (assembly: Assembly) => Math.max(1, Math.round(contextBudget(assembly) * 0.25))
