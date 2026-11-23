// The model settings form's fields by name: what each one edits in a model's overrides (its
// paths), how a draft reads as overrides, and which fields an edit touched. The single model's
// form saves the whole draft; the model list's Edit N… applies only the fields ticked, each by
// its paths, to every selected model.
import { applyModelPatch, valueAt, withValueAt } from "@dreamspan/shared/modelPatch.ts"
import type { Model, ModelOverrides } from "@dreamspan/shared/providers.ts"
import { SAMPLER_KEYS, type SamplerKey } from "@dreamspan/shared/samplerRules.ts"
import { type Draft, draftOf, flagOf, triOf } from "./modelForm.ts"

type Json = Readonly<Record<string, unknown>>
type Path = ReadonlyArray<string>

export interface SamplerSpec {
  readonly label: string
  readonly about: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly fallback: number
}

/** The samplers' ranges and defaults (`DEFAULT_SAMPLERS`), as ST's sliders have them. */
export const SAMPLERS: Readonly<Record<Exclude<SamplerKey, "seed">, SamplerSpec>> = {
  temperature: {
    label: "Temperature",
    about: "How random word choice is. Lower is more predictable.",
    min: 0,
    max: 2,
    step: 0.01,
    fallback: 1
  },
  top_p: {
    label: "Top P",
    about: "Nucleus sampling: picks only from the likeliest words whose chances add up to this. 1: off.",
    min: 0,
    max: 1,
    step: 0.01,
    fallback: 1
  },
  top_k: {
    label: "Top K",
    about: "Picks only from the K likeliest words. 0: off.",
    min: 0,
    max: 200,
    step: 1,
    fallback: 0
  },
  min_p: {
    label: "Min P",
    about: "Leaves out words less likely than this share of the likeliest word’s chance. 0: off.",
    min: 0,
    max: 1,
    step: 0.01,
    fallback: 0
  },
  top_a: {
    label: "Top A",
    about: "Leaves out words below this share of the likeliest word’s chance, squared. 0: off.",
    min: 0,
    max: 1,
    step: 0.01,
    fallback: 0
  },
  frequency_penalty: {
    label: "Frequency penalty",
    about: "Discourages words by how often they’ve appeared so far. 0: off.",
    min: -2,
    max: 2,
    step: 0.01,
    fallback: 0
  },
  presence_penalty: {
    label: "Presence penalty",
    about: "Discourages any word that has appeared already, so new topics come up. 0: off.",
    min: -2,
    max: 2,
    step: 0.01,
    fallback: 0
  },
  repetition_penalty: {
    label: "Repetition penalty",
    about: "Discourages repeating earlier text. 1: off.",
    min: 1,
    max: 2,
    step: 0.01,
    fallback: 1
  }
}

const settingsPath = (...path: ReadonlyArray<string>): Path => ["settings", ...path]

/** Every field of the form but the display name, in the form's order: its label and its paths. */
export const MODEL_FIELDS = {
  reasoning: { label: "Reasoning", paths: [["reasoning"]] },
  reasoning_effort: { label: "Reasoning effort", paths: [settingsPath("samplers", "reasoning_effort")] },
  openai_max_context: { label: "Context", paths: [settingsPath("samplers", "openai_max_context")] },
  context: { label: "Context window", paths: [["context"]] },
  openai_max_tokens: { label: "Reply length", paths: [settingsPath("samplers", "openai_max_tokens")] },
  maxOutput: { label: "Output limit", paths: [["maxOutput"]] },
  context_target: { label: "Trim history to", paths: [settingsPath("context_target")] },
  verbosity: { label: "Verbosity", paths: [settingsPath("samplers", "verbosity")] },
  stream: { label: "Show the reply as it’s written", paths: [settingsPath("stream")] },
  stop: { label: "Stop strings", paths: [settingsPath("stop")] },
  ...(Object.fromEntries(
    SAMPLER_KEYS.map((key) => [
      key,
      { label: key === "seed" ? "Seed" : SAMPLERS[key].label, paths: [settingsPath("samplers", key)] }
    ])
  ) as unknown as Record<SamplerKey, FieldSpec>),
  vision: { label: "Vision", paths: [["vision"]] },
  tools: { label: "Tools", paths: [["tools"]] },
  prefill: { label: "Prefill", paths: [["prefill"]] },
  names_behavior: { label: "Speaker names", paths: [settingsPath("names_behavior")] },
  postprocess: { label: "Prompt post-processing", paths: [settingsPath("postprocess")] },
  midChatSystem: { label: "System messages mid-chat", paths: [["midChatSystem"]] },
  use_sysprompt: { label: "System prompt as the system parameter", paths: [settingsPath("use_sysprompt")] },
  squash: { label: "Squash system messages", paths: [settingsPath("squash")] },
  maxImages: { label: "Images per request", paths: [["maxImages"]] },
  cacheRetention: { label: "Prompt cache lifetime", paths: [settingsPath("cacheRetention")] },
  cacheBreakpoints: { label: "Cache markers", paths: [["cacheBreakpoints"]] },
  cacheTtlS: { label: "Cache lifetime", paths: [["cacheTtlS"]] },
  lookback: { label: "Finds earlier cached parts", paths: [["cacheLayout", "lookback"]] },
  maxMarkers: { label: "Most cache markers", paths: [["cacheLayout", "maxMarkers"]] },
  minTokens: { label: "Smallest cached size", paths: [["cacheLayout", "minTokens"]] },
  marker: { label: "Bedrock cache breakpoints", paths: [["cacheLayout", "marker"]] },
  summarySplit: { label: "Marker after the summaries", paths: [["cacheLayout", "summarySplit"]] },
  routing: { label: "Routing", paths: [settingsPath("routing")] },
  logit_bias: { label: "Word bias", paths: [settingsPath("logit_bias")] },
  sampling: { label: "Extra request parameters", paths: [["sampling"]] },
  thinkingLevels: { label: "Thinking levels", paths: [["thinkingLevels"]] },
  compat: { label: "Compatibility flags", paths: [["compat"]] }
} satisfies Record<string, FieldSpec>

export interface FieldSpec {
  readonly label: string
  readonly paths: ReadonlyArray<Path>
}
export type FieldId = keyof typeof MODEL_FIELDS
export const FIELD_IDS = Object.keys(MODEL_FIELDS) as ReadonlyArray<FieldId>
const spec = (id: FieldId): FieldSpec => MODEL_FIELDS[id]

/** A number field's rule: the path it edits, and what it takes. */
export interface NumberRule {
  readonly whole?: boolean
  readonly min?: number
  readonly label: string
}
export const NUMBER_RULES: Readonly<Record<string, NumberRule>> = {
  "settings.samplers.openai_max_context": { whole: true, min: 1, label: "Context" },
  "settings.samplers.openai_max_tokens": { whole: true, min: 1, label: "Reply length" },
  "settings.samplers.seed": { whole: true, min: -1, label: "Seed" },
  "settings.context_target": { whole: true, min: 1, label: "Trim history to" },
  "overrides.maxImages": { whole: true, min: 0, label: "Images per request" },
  "overrides.cacheTtlS": { whole: true, min: 1, label: "Cache lifetime" },
  "overrides.cacheLayout.maxMarkers": { whole: true, min: 1, label: "Most cache markers" },
  "overrides.cacheLayout.minTokens": { whole: true, min: 1, label: "Smallest cached size" },
  ...Object.fromEntries(
    Object.entries(SAMPLERS).map(([key, entry]) => [`settings.samplers.${key}`, { label: entry.label }])
  )
}

/** A number as typed: its value, or why it isn't one. */
export const parseNumber = (text: string, rule: NumberRule): { value: number | undefined; problem: string | null } => {
  const trimmed = text.trim()
  if (trimmed === "") return { value: undefined, problem: null }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { value: undefined, problem: "Enter a number, or leave it empty." }
  if (rule.whole && !Number.isInteger(value))
    return {
      value: undefined,
      problem: `Enter a whole number${rule.min !== undefined ? ` of at least ${rule.min}` : ""}.`
    }
  if (rule.min !== undefined && value < rule.min)
    return { value: undefined, problem: `Enter a number of at least ${rule.min}.` }
  return { value, problem: null }
}

/** A limit as typed: a whole number of at least 1, or empty. */
export const wholeText = (text: string) => {
  const trimmed = text.trim()
  if (trimmed === "") return { value: null, problem: null }
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 1
    ? { value, problem: null }
    : { value: null, problem: "Enter a whole number of at least 1, or leave it empty." }
}

/** The number fields typed into that aren't numbers they take, by draft key: why. */
export const draftProblems = (values: Draft): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(values.drafts)
      .map(([key, text]) => [key, NUMBER_RULES[key] ? parseNumber(text, NUMBER_RULES[key]).problem : null] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null)
  )

/** Whether a word-bias row has a token but no number for its bias. */
export const biasRowProblem = (row: { readonly name: string; readonly value: string }) =>
  row.name.trim() !== "" && !Number.isFinite(Number(row.value.trim() || "x"))

/** A draft key ("settings.samplers.seed", "overrides.maxImages") as a path in the overrides. */
const keyPath = (key: string): Path => {
  const [root, ...rest] = key.split(".")
  return root === "overrides" ? rest : [root!, ...rest]
}
const under = (path: Path, prefix: Path) => prefix.every((key, i) => path[i] === key)

/**
 * The draft as overrides, without checking them: the settings, the other overrides, the
 * choices with controls of their own (Auto left out) and the limits as typed when they're whole
 * numbers. Not the display name, and never the learned size.
 */
const looseOverrides = (values: Draft): Json =>
  Object.fromEntries(
    Object.entries({
      ...values.overrides,
      settings: Object.keys(values.settings).length > 0 ? values.settings : undefined,
      context: wholeText(values.context).value ?? undefined,
      maxOutput: wholeText(values.maxOutput).value ?? undefined,
      vision: flagOf(values.vision),
      reasoning: flagOf(values.reasoning),
      tools: flagOf(values.tools),
      prefill: values.prefill === "auto" ? undefined : values.prefill
    }).filter(([key, value]) => value !== undefined && key !== "learned" && key !== "name")
  )

/** The fields whose value, or text as typed, differs between two drafts. */
export const fieldsChanged = (before: Draft, after: Draft): ReadonlyArray<FieldId> => {
  const a = looseOverrides(before)
  const b = looseOverrides(after)
  const typed = (record: Readonly<Record<string, unknown>>, other: Readonly<Record<string, unknown>>) =>
    [...new Set([...Object.keys(record), ...Object.keys(other)])]
      .filter((key) => JSON.stringify(record[key]) !== JSON.stringify(other[key]))
      .map(keyPath)
  const typedPaths = [
    ...typed(before.drafts, after.drafts),
    ...typed(before.rows, after.rows),
    ...(before.context !== after.context ? [["context"]] : []),
    ...(before.maxOutput !== after.maxOutput ? [["maxOutput"]] : [])
  ]
  return FIELD_IDS.filter((id) =>
    spec(id).paths.some(
      (path) =>
        JSON.stringify(valueAt(a, path)) !== JSON.stringify(valueAt(b, path)) ||
        typedPaths.some((changed) => under(changed, path) || under(path, changed))
    )
  )
}

/** The draft with `value` at a field's `path` in the overrides, and its typed text gone. */
const withPath = (values: Draft, path: Path, value: unknown): Draft => {
  const [head, ...rest] = path
  const drop = <A>(record: Readonly<Record<string, A>>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !under(keyPath(key), path)))
  const base = { ...values, drafts: drop(values.drafts), rows: drop(values.rows) }
  switch (head) {
    case "settings":
      return { ...base, settings: withValueAt(values.settings, rest, value) }
    case "reasoning":
    case "vision":
    case "tools":
      return { ...base, [head]: triOf(typeof value === "boolean" ? value : undefined) }
    case "prefill":
      return { ...base, prefill: (value as Draft["prefill"] | undefined) ?? "auto" }
    case "context":
    case "maxOutput":
      return { ...base, [head]: typeof value === "number" ? String(value) : "" }
    default:
      return { ...base, overrides: withValueAt(values.overrides, path, value) }
  }
}

/** The fields another model sets (any of their paths has a value in its overrides). */
export const fieldsSet = (overrides: ModelOverrides): ReadonlyArray<FieldId> =>
  FIELD_IDS.filter((id) => spec(id).paths.some((path) => valueAt(overrides, path) !== undefined))

/** The draft with `fields` taken from `overrides`, as another model has them. */
export const copyFields = (values: Draft, overrides: ModelOverrides, fields: ReadonlyArray<FieldId>): Draft =>
  fields.reduce(
    (draft, id) => spec(id).paths.reduce((next, path) => withPath(next, path, valueAt(overrides, path)), draft),
    { ...values, clamped: {} }
  )

const shown = (value: unknown) => {
  if (value === undefined) return "not set"
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > 24 ? `${text.slice(0, 23)}…` : text
}

/**
 * What the selected models share: a draft of the fields they all have alike, and for each field
 * they differ in, how ("0.7 on 2, not set on 10").
 */
export const commonOf = (
  models: ReadonlyArray<Model>
): { readonly draft: Draft; readonly mixed: Readonly<Partial<Record<FieldId, string>>> } => {
  let common: Json = {}
  const mixed: Partial<Record<FieldId, string>> = {}
  for (const id of FIELD_IDS) {
    const counts = new Map<string, { value: unknown; count: number }>()
    for (const model of models) {
      const value = spec(id).paths.map((path) => valueAt(model.overrides, path))
      const key = JSON.stringify(value)
      const entry = counts.get(key)
      if (entry) entry.count += 1
      else counts.set(key, { value, count: 1 })
    }
    const groups = [...counts.values()].sort((a, b) => b.count - a.count)
    if (groups.length === 1) {
      const values = groups[0]!.value as ReadonlyArray<unknown>
      spec(id).paths.forEach((path, i) => {
        common = withValueAt(common, path, values[i])
      })
      continue
    }
    const parts = groups.slice(0, 4).map(({ value, count }) => {
      const values = value as ReadonlyArray<unknown>
      return `${values.length === 1 ? shown(values[0]) : values.map(shown).join(" / ")} on ${count.toLocaleString()}`
    })
    mixed[id] = `Differs: ${parts.join(", ")}${groups.length > 4 ? ", …" : ""}.`
  }
  return { draft: draftOf(common as ModelOverrides, 0), mixed }
}

/** One model's limits, as Context and Reply length are kept within. */
export interface Limits {
  readonly context: number
  readonly maxOutput: number
}

/**
 * The ticked fields as patches for `models`: each path's value from the draft, a Context of all
 * of a model's window or more removed (all of it, as the slider's end sets it), and a Reply
 * length over its output limit brought down to it. Models given the same values share a patch.
 */
export const massPatches = (
  values: Draft,
  ticked: ReadonlyArray<FieldId>,
  models: ReadonlyArray<{ readonly id: Model["id"]; readonly limits: Limits }>
): ReadonlyArray<{ modelIds: Array<Model["id"]>; paths: Array<Path>; values: Json }> => {
  const loose = looseOverrides(values)
  const paths = ticked.flatMap((id) => spec(id).paths)
  let base: Json = {}
  for (const path of paths) base = withValueAt(base, path, valueAt(loose, path))
  const groups = new Map<string, { modelIds: Array<Model["id"]>; paths: Array<Path>; values: Json }>()
  for (const model of models) {
    let own = base
    const context = valueAt(own, ["settings", "samplers", "openai_max_context"])
    if (typeof context === "number" && context >= model.limits.context)
      own = withValueAt(own, ["settings", "samplers", "openai_max_context"], undefined)
    const reply = valueAt(own, ["settings", "samplers", "openai_max_tokens"])
    if (typeof reply === "number" && reply > model.limits.maxOutput)
      own = withValueAt(own, ["settings", "samplers", "openai_max_tokens"], model.limits.maxOutput)
    const key = JSON.stringify(own)
    const group = groups.get(key)
    if (group) group.modelIds.push(model.id)
    else groups.set(key, { modelIds: [model.id], paths, values: own })
  }
  return [...groups.values()]
}

/** How many of `models` the patches would change. */
export const wouldChange = (models: ReadonlyArray<Model>, patches: ReturnType<typeof massPatches>): number => {
  const byId = new Map(models.map((model) => [model.id, model]))
  let count = 0
  for (const patch of patches)
    for (const id of patch.modelIds) {
      const model = byId.get(id)
      if (model && applyModelPatch(model.overrides, patch.paths, patch.values).previous !== null) count += 1
    }
  return count
}
