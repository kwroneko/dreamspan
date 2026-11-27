// Changing some of many models' settings at once (the model list's Edit N…): a patch names the
// paths it sets in a model's overrides and carries their values as an overrides object, so the
// schema checks every value where it goes. A path whose value is absent is removed. Applying a
// patch returns what it replaced as a patch of the same shape: applied again, that is the Undo.
import { Schema } from "effect"
import { ModelId, ModelIds, ModelOverrides } from "./providers.ts"
import { SAMPLER_KEYS } from "./samplerRules.ts"

// The schema supplies the editable leaves. Lists and free-form maps are edited as whole fields.
// Learned limits have their own operations, and the legacy samplers without controls stay as stored.
const {
  settings,
  cacheLayout,
  learned: _learned,
  learnedOutput: _learnedOutput,
  ...overrideFields
} = ModelOverrides.fields
const { samplers: _samplers, ...settingFields } = settings.schema.fields
const editablePaths = new Set(
  [
    ...Object.keys(overrideFields).map((key) => [key]),
    ...Object.keys(cacheLayout.schema.fields).map((key) => ["cacheLayout", key]),
    ...Object.keys(settingFields).map((key) => ["settings", key]),
    ...[...SAMPLER_KEYS, "reasoning_effort", "verbosity", "openai_max_context", "openai_max_tokens"].map((key) => [
      "settings",
      "samplers",
      key
    ])
  ].map((path) => JSON.stringify(path))
)

/** A path into a model's overrides (["settings", "samplers", "temperature"]). */
const ModelPath = Schema.Array(Schema.String).check(
  Schema.isMaxLength(3),
  Schema.makeFilter(
    (path: ReadonlyArray<string>) => editablePaths.has(JSON.stringify(path)) || "Not an editable model field"
  )
)

/** The same change to every model in `modelIds`: each path set to its value in `values`, or removed. */
const ModelPatch = Schema.Struct({
  modelIds: ModelIds,
  paths: Schema.Array(ModelPath).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  values: ModelOverrides
})

/** Several patches, applied in order in one change. */
export const ModelPatches = Schema.Array(ModelPatch).check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
export type ModelPatches = typeof ModelPatches.Type

/** What a change replaced: per model it changed, the paths that changed and their values before. */
export const ModelPatchResult = Schema.Struct({
  changed: Schema.Array(
    Schema.Struct({
      modelId: ModelId,
      paths: Schema.Array(ModelPath),
      values: ModelOverrides
    })
  )
})
export type ModelPatchResult = typeof ModelPatchResult.Type

type Json = Readonly<Record<string, unknown>>
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The value at `path` in `root`. */
export const valueAt = (root: unknown, path: ReadonlyArray<string>): unknown => {
  let at: unknown = root
  for (const key of path) {
    if (!isRecord(at) || !Object.hasOwn(at, key)) return undefined
    at = at[key]
  }
  return at
}

/** `root` with `value` at `path`; undefined removes it, and groups it leaves empty go with it. */
export const withValueAt = (root: Json, path: ReadonlyArray<string>, value: unknown): Json => {
  const [key, ...rest] = path
  if (key === undefined) return root
  const inner = rest.length === 0 ? value : withValueAt(isRecord(root[key]) ? root[key] : {}, rest, value)
  const others = Object.fromEntries(Object.entries(root).filter(([other]) => other !== key))
  return inner === undefined || (isRecord(inner) && Object.keys(inner).length === 0 && rest.length > 0)
    ? others
    : { ...others, [key]: inner }
}

/** A canonical text of a value, for telling whether it changed (keys sorted). */
const canonical = (value: unknown): string =>
  value === undefined
    ? "undefined"
    : JSON.stringify(value, (_, inner: unknown) =>
        isRecord(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) : inner
      )

/**
 * `overrides` with the patch's paths set, and what they held before at the paths that changed
 * (null: nothing changed). Later paths win where they overlap.
 */
export const applyModelPatch = (
  overrides: Json,
  paths: ReadonlyArray<ReadonlyArray<string>>,
  values: Json
): { readonly next: Json; readonly previous: { paths: Array<ReadonlyArray<string>>; values: Json } | null } => {
  let next = overrides
  for (const path of paths) next = withValueAt(next, path, valueAt(values, path))
  const changedPaths = paths.filter((path) => canonical(valueAt(overrides, path)) !== canonical(valueAt(next, path)))
  if (changedPaths.length === 0 || canonical(next) === canonical(overrides)) return { next: overrides, previous: null }
  let before: Json = {}
  for (const path of changedPaths) before = withValueAt(before, path, valueAt(overrides, path))
  return { next, previous: { paths: changedPaths, values: before } }
}
