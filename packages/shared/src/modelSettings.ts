// Model-specific generation and wire settings. Prompt text belongs to the prompt preset.
import { Schema } from "effect"
import { ImportReport } from "./importReport.ts"
import { LegacyPresetDoc, type PresetSamplers } from "./docs/preset.ts"

export const DEFAULT_SAMPLERS: PresetSamplers = {
  temperature: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  top_p: 1,
  top_k: 0,
  top_a: 0,
  min_p: 0,
  repetition_penalty: 1,
  // The model's window replaces it (withModelSettings); ASSUMED_CONTEXT when nothing reports one.
  openai_max_context: 128_000,
  openai_max_tokens: 300,
  max_context_unlocked: false,
  seed: -1,
  n: 1,
  reasoning_effort: "auto",
  verbosity: "auto"
}

export const ModelSettings = Schema.Struct({
  samplers: Schema.optionalKey(
    LegacyPresetDoc.fields.samplers.mapFields(
      (fields) =>
        Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Schema.optionalKey(value)])) as {
          [K in keyof typeof fields]: Schema.optionalKey<(typeof fields)[K]>
        }
    )
  ),
  context_target: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  names_behavior: Schema.optionalKey(LegacyPresetDoc.fields.names_behavior),
  squash: Schema.optionalKey(Schema.Boolean),
  postprocess: Schema.optionalKey(LegacyPresetDoc.fields.postprocess),
  use_sysprompt: Schema.optionalKey(Schema.Boolean),
  stop: Schema.optionalKey(Schema.Array(Schema.String)),
  logit_bias: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  stream: Schema.optionalKey(Schema.Boolean),
  cacheRetention: Schema.optionalKey(Schema.Literals(["none", "short", "long"])),
  routing: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})
export type ModelSettings = typeof ModelSettings.Type

/**
 * The window assumed when no source reports the model's (its setting, the provider's list, a
 * catalog, a limit learned from an error): a modern size, always shown as assumed.
 */
export const ASSUMED_CONTEXT = 128_000
/**
 * The output limit assumed when no source reports the model's (its setting, the provider's list,
 * a catalog): a modern ceiling within the context window, always shown as assumed.
 */
export const ASSUMED_MAX_OUTPUT = 65_536
/** The response length a model without its own gets, within its output limit and half its context. */
export const DEFAULT_RESPONSE = 4096

/**
 * Compatibility view for the ST composer; never persisted as a prompt document. `context` and
 * `maxOutput` are the model's reported limits (null when unknown); the model's own context size
 * and response length win over the defaults derived from them.
 */
export const withModelSettings = (
  doc: LegacyPresetDoc,
  settings: ModelSettings,
  context: number | null | undefined,
  maxOutput: number | null | undefined
): LegacyPresetDoc => {
  const { context_target, ...text } = doc
  void context_target
  const window = context ?? ASSUMED_CONTEXT
  // The context size the budget will use: the model's own, within its reported window.
  const size = Math.min(settings.samplers?.openai_max_context ?? window, context ?? Number.POSITIVE_INFINITY)
  return {
    ...text,
    samplers: {
      ...DEFAULT_SAMPLERS,
      openai_max_context: window,
      openai_max_tokens: Math.max(1, Math.min(maxOutput ?? DEFAULT_RESPONSE, DEFAULT_RESPONSE, Math.floor(size / 2))),
      ...settings.samplers
    },
    names_behavior: settings.names_behavior ?? "default",
    squash: settings.squash ?? false,
    postprocess: settings.postprocess ?? "none",
    use_sysprompt: settings.use_sysprompt ?? true,
    ...(settings.context_target === undefined ? {} : { context_target: settings.context_target })
  }
}

export const StSettingsImport = Schema.Struct({
  report: ImportReport,
  model: Schema.NullOr(ModelSettings),
  connection: Schema.NullOr(
    Schema.Struct({ kind: Schema.String, baseUrl: Schema.NullOr(Schema.String), model: Schema.NullOr(Schema.String) })
  )
})
export type StSettingsImport = typeof StSettingsImport.Type

/**
 * The reasoning levels a request can ask for (pi-ai's thinking levels), as the model's "Reasoning
 * effort" setting names them; each provider maps them onto its own field (assembler/wire.ts).
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
export const ReasoningEffort = Schema.Literals(REASONING_EFFORTS)
export type ReasoningEffort = typeof ReasoningEffort.Type

export const EFFORT_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
}

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === "string" && (REASONING_EFFORTS as ReadonlyArray<string>).includes(value)

/**
 * The levels a model takes: none where it doesn't reason; else every level its thinking-level map
 * doesn't mark unsupported (null). `reasoning` and `thinkingLevels` as `resolveModel` resolves them.
 */
export const supportedEfforts = (model: {
  readonly reasoning: { readonly value: boolean }
  readonly thinkingLevels: { readonly value: Readonly<Record<string, string | null>> | null }
}): ReadonlyArray<ReasoningEffort> =>
  model.reasoning.value ? REASONING_EFFORTS.filter((level) => model.thinkingLevels.value?.[level] !== null) : []
