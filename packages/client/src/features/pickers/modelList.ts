// What a model list shows, in which order: a text filter, then by name (connection · model, A to
// Z) or by when each last wrote a reply for the user, latest first and never-used last.
import type { DisplayPrefs } from "@rp/shared/chatApi.ts"
import { formatAgo as ago } from "../characters/data.ts"
import type { ModelChoice } from "../chat/modelChoices.ts"
import { exactTime, fold } from "./presetList.ts"

export type ModelSort = DisplayPrefs["modelSort"]

export const MODEL_SORTS: ReadonlyArray<{
  readonly value: ModelSort
  readonly label: string
  readonly description: string
}> = [
  { value: "name", label: "Name", description: "Sort by connection and model name, A to Z" },
  { value: "used", label: "Used", description: "Sort by when each last wrote a reply, latest first" }
]

const byName = (a: ModelChoice, b: ModelChoice) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)

/** The models a sort lists, filtered by the text; `used` maps a model's value to its last use. */
export function modelsInOrder(
  sort: ModelSort,
  query: string,
  models: ReadonlyArray<ModelChoice>,
  used: ReadonlyMap<string, number>
): ReadonlyArray<ModelChoice> {
  const q = fold(query.trim())
  return models
    .filter((model) => q === "" || fold(model.label).includes(q))
    .sort(sort === "name" ? byName : (a, b) => (used.get(b.value) ?? -1) - (used.get(a.value) ?? -1) || byName(a, b))
}

export const modelDetail = (at: number | undefined, now = Date.now()) =>
  at === undefined ? "never used" : `used ${ago(at, now)}`

export const modelTime = (at: number | undefined) =>
  at === undefined ? "Not used for a reply yet" : `Last used ${exactTime(at)}`
