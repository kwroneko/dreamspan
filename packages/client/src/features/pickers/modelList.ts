// What a model list shows, in which order: a text filter, then by name (connection · model, A to
// Z) or by when each last wrote a reply for the user, latest first and never-used last.
import type { DisplayPrefs } from "@dreamspan/shared/chatApi.ts"
import { formatAgo as ago } from "../characters/data.ts"
import type { ModelChoice } from "../chat/modelChoices.ts"
import type { ModelRow } from "./VirtualModelList.tsx"
import { exactTime, fold } from "./presetList.ts"

export type ModelSort = DisplayPrefs["modelSort"]

export const MODEL_SORTS: ReadonlyArray<{
  readonly value: ModelSort
  readonly label: string
  readonly description: string
}> = [
  { value: "name", label: "Name", description: "Sorts each connection's models by name, A to Z." },
  { value: "used", label: "Last used", description: "Sorts each connection's models by their latest choice or reply." }
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

const tokenCount = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(tokens)

/** "200k context", "1M context", "128k context (assumed)": the row's window, from the model (WORKSHOP-CONTEXT §1.3). */
export const modelWindow = ({ window }: Windowed) =>
  window ? `${tokenCount(window.tokens)} context${window.assumed ? " (assumed)" : ""}` : null

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

/** Lower case without accents or punctuation, so `claude 3.1` types as `claude31`; `starts`
 * holds the positions where a word of the original text begins. */
const searchable = (text: string) => {
  let out = ""
  const starts = new Set<number>()
  let boundary = true
  for (const char of fold(text)) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      if (boundary) starts.add(out.length)
      out += char
      boundary = false
    } else boundary = true
  }
  return { text: out, starts }
}

/** How well one typed word matches a field: 0 none, 1 inside a word, 2 at a word's start, 3 the whole field. */
const wordScore = (field: ReturnType<typeof searchable>, needle: string) => {
  if (field.text === needle) return 3
  let best = 0
  for (let at = field.text.indexOf(needle); at >= 0; at = field.text.indexOf(needle, at + 1)) {
    if (field.starts.has(at)) return 2
    best = 1
  }
  return best
}

/**
 * How well `query` matches a model, or 0 when it doesn't: every typed word must appear in its
 * name, id or connection name (accents and punctuation ignored). Words in the name or id
 * count more than words in the connection's name, and a word's start more than its middle.
 */
function modelMatch(model: ModelChoice, query: string): number {
  const words = query
    .trim()
    .split(/\s+/)
    .map((word) => searchable(word).text)
    .filter((word) => word !== "")
  if (words.length === 0) return 1
  const own = [modelName(model), model.modelKey ?? model.label].map(searchable)
  const connection = searchable(modelConnection(model).name)
  let total = 0
  for (const word of words) {
    const score = Math.max(...own.map((field) => wordScore(field, word) * 2), wordScore(connection, word))
    if (score === 0) return 0
    total += score
  }
  return total
}

export const matchesModel = (model: ModelChoice, query: string) => modelMatch(model, query) > 0

/** The heading of the matches after the pinned ones, while searching. */
const MATCHES = "Matches"

/**
 * Without a search: pins, then recent choices (both across connections), then the remaining
 * catalog grouped by connection. While searching: pins that match, then every other match,
 * best first. A heading shows only where there's more than one section.
 */
export function modelRows(
  models: ReadonlyArray<ModelChoice>,
  sort: ModelSort,
  query: string,
  connection: string,
  pins: Readonly<Record<string, boolean>>,
  used: ReadonlyMap<string, number>,
  ordered = false
): ReadonlyArray<ModelRow> {
  const inConnection = models.filter((model) => !connection || modelConnection(model).id === connection)
  const rows: Array<ModelRow> = []
  const section = (heading: string, items: ReadonlyArray<ModelChoice>, mixed: boolean) => {
    if (!items.length) return
    rows.push({ heading, key: `heading:${heading}` })
    rows.push(...items.map((model) => ({ model, key: model.value, mixed })))
  }
  if (query.trim()) {
    const scores = new Map<string, number>()
    for (const model of inConnection) {
      const score = modelMatch(model, query)
      if (score > 0) scores.set(model.value, score)
    }
    const ranked = inConnection
      .filter((model) => scores.has(model.value))
      .sort(
        (a, b) =>
          scores.get(b.value)! - scores.get(a.value)! ||
          (used.get(b.value) ?? -1) - (used.get(a.value) ?? -1) ||
          byName(a, b)
      )
    const pinned = ranked.filter((model) => pins[model.value])
    const rest = ranked.filter((model) => !pins[model.value])
    section("Pinned", pinned, !connection)
    if (pinned.length) section(MATCHES, rest, !connection)
    else rows.push(...rest.map((model) => ({ model, key: model.value, mixed: !connection })))
    return rows
  }
  const pinned = inConnection.filter((model) => pins[model.value]).sort(byName)
  const recent = inConnection
    .filter((model) => !pins[model.value] && used.has(model.value))
    .sort((a, b) => used.get(b.value)! - used.get(a.value)! || byName(a, b))
    .slice(0, 12)
  const included = new Set([...pinned, ...recent].map((model) => model.value))
  const remaining = inConnection.filter((model) => !included.has(model.value))
  const rest = ordered ? remaining : modelsInOrder(sort, "", remaining, used)
  section("Pinned", pinned, !connection)
  section("Recent", recent, !connection)
  const groups = new Map<string, { name: string; models: ModelChoice[] }>()
  for (const model of rest) {
    const group = modelConnection(model)
    if (!groups.has(group.id)) groups.set(group.id, { name: group.name, models: [] })
    groups.get(group.id)!.models.push(model)
  }
  for (const [id, group] of groups) {
    if (rows.length || groups.size > 1) rows.push({ heading: group.name, key: `connection:${id}` })
    rows.push(...group.models.map((model) => ({ model, key: model.value, mixed: false })))
  }
  return rows
}
