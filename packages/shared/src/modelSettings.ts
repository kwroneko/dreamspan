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
  openai_max_context: 4095,
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

/** The context size assumed when no source reports the model's window. */
const FALLBACK_CONTEXT = 8192
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
  const window = context ?? FALLBACK_CONTEXT
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
