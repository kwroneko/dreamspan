// What a model list shows, in which order: a text filter, then by name (connection · model, A to
// Z) or by when each last wrote a reply for the user, latest first and never-used last.
import type { DisplayPrefs } from "@dreamspan/shared/chatApi.ts"
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
  { value: "used", label: "Used", description: "Sort by the latest choice or reply" }
]

const byName = (a: ModelChoice, b: ModelChoice) =>
  modelConnection(a).name.localeCompare(modelConnection(b).name) ||
  modelName(a).localeCompare(modelName(b)) ||
  a.value.localeCompare(b.value)

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

type Windowed = { readonly window?: { readonly tokens: number; readonly assumed: boolean } }

/** "200k context", "128k context (assumed)": the row's window, from the model (WORKSHOP-CONTEXT §1.3). */
export const modelWindow = ({ window }: Windowed) =>
  window
    ? `${window.tokens >= 1000 ? `${Math.round(window.tokens / 1000)}k` : window.tokens} context${window.assumed ? " (assumed)" : ""}`
    : null

/** The window in the row's hover explanation. */
export const modelWindowHint = ({ window }: Windowed) =>
  !window
    ? ""
    : window.assumed
      ? ` Context window: ${window.tokens.toLocaleString("en-US")} tokens, assumed: nothing reports this model's window. Set it in Settings → Connections.`
      : ` Context window: ${window.tokens.toLocaleString("en-US")} tokens.`

export const modelTime = (at: number | undefined) =>
  at === undefined ? "Not used for a reply yet" : `Last used ${exactTime(at)}`

/** Connection identity is separate from its editable display name. */
export const modelConnection = (model: ModelChoice) => ({
  id: model.connectionId ?? model.value.split(" ")[0]!,
  name: model.connectionName ?? model.label.split(" · ")[0]!
})
export const modelName = (model: ModelChoice) =>
  model.name ?? (model.label.split(" · ").slice(1).join(" · ") || model.label)

/** Punctuation and accents do not make provider/model ids hard to type. Each word can
 * match a subsequence, so `anth cld 31` also finds `anthropic/claude-3.1`. */
const searchText = (text: string) => fold(text).replace(/[^\p{L}\p{N}]/gu, "")
export function matchesModel(model: ModelChoice, query: string): boolean {
  if (!query.trim()) return true
  const fields = [model.label, model.name ?? "", model.modelKey ?? ""].map(searchText)
  return query
    .trim()
    .split(/\s+/)
    .every((word) => {
      const needle = searchText(word)
      return fields.some((text) => {
        if (!needle || text.includes(needle)) return true
        let at = 0
        for (const char of text) if (char === needle[at]) at++
        return at === needle.length
      })
    })
}

/** Pins and recent choices span connections; the remaining catalog is grouped. */
export function modelRows(
  models: ReadonlyArray<ModelChoice>,
  sort: ModelSort,
  query: string,
  connection: string,
  pins: Readonly<Record<string, boolean>>,
  used: ReadonlyMap<string, number>,
  ordered = false
): ReadonlyArray<import("./VirtualModelList.tsx").ModelRow> {
  const shown = models.filter(
    (model) => (!connection || modelConnection(model).id === connection) && matchesModel(model, query)
  )
  const pinned = shown.filter((model) => pins[model.value]).sort(byName)
  const recent = shown
    .filter((model) => !pins[model.value] && used.has(model.value))
    .sort((a, b) => used.get(b.value)! - used.get(a.value)! || byName(a, b))
    .slice(0, 12)
  const included = new Set([...pinned, ...recent].map((model) => model.value))
  const remaining = shown.filter((model) => !included.has(model.value))
  const rest = ordered ? remaining : modelsInOrder(sort, "", remaining, used)
  const rows: Array<import("./VirtualModelList.tsx").ModelRow> = []
  const section = (heading: string, items: ReadonlyArray<ModelChoice>) => {
    if (!items.length) return
    rows.push({ heading, key: `heading:${heading}` })
    rows.push(...items.map((model) => ({ model, key: model.value })))
  }
  section("Pinned", pinned)
  section("Recent", recent)
  const groups = new Map<string, { name: string; models: ModelChoice[] }>()
  for (const model of rest) {
    const group = modelConnection(model)
    if (!groups.has(group.id)) groups.set(group.id, { name: group.name, models: [] })
    groups.get(group.id)!.models.push(model)
  }
  for (const [id, group] of groups) {
    if (!connection) rows.push({ heading: group.name, key: `connection:${id}` })
    rows.push(...group.models.map((model) => ({ model, key: model.value })))
  }
  return rows
}
