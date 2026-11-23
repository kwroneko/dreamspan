// The model settings form's draft: what the user changed, as the form holds it until Save. One
// JSON text in the model's user draft (`useUserDraft`), so every field survives a reload. The
// stored overrides and settings are kept whole: each control edits one path in them, and what
// has no control stays as it was.
import type { ModelOverrides } from "@dreamspan/shared/providers.ts"

export type Tri = "auto" | "yes" | "no"
const triOf = (value: boolean | undefined): Tri => (value === undefined ? "auto" : value ? "yes" : "no")
export const flagOf = (tri: Tri) => (tri === "auto" ? undefined : tri === "yes")

export type PrefillChoice = "auto" | NonNullable<ModelOverrides["prefill"]>

type Json = Readonly<Record<string, unknown>>

/** A row of a list control (stop strings, word bias, extra parameters…) as typed. */
export interface Row {
  readonly name: string
  readonly value: string
}

/** The overrides with controls of their own at the top of the form, apart from the rest. */
const OWN = ["name", "context", "maxOutput", "vision", "reasoning", "tools", "prefill", "settings", "learned"] as const

export interface Draft {
  readonly name: string
  /** The user's own limits, as typed: empty uses what's reported. */
  readonly context: string
  readonly maxOutput: string
  readonly vision: Tri
  readonly reasoning: Tri
  readonly tools: Tri
  readonly prefill: PrefillChoice
  /** Every other capability override, whole (`maxImages`, `compat`, `sampling`, …). */
  readonly overrides: Json
  /** The model's settings (`ModelSettings`), whole. */
  readonly settings: Json
  /** A number field's text as typed, by its path, until it's a whole number again. */
  readonly drafts: Readonly<Record<string, string>>
  /** A list control's rows as typed, by its path. */
  readonly rows: Readonly<Record<string, ReadonlyArray<Row>>>
  /** Values a copy from another model brought down to this one's limits, by sampler key: why. */
  readonly clamped: Readonly<Record<string, string>>
  readonly rowVersion: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The draft of saved overrides. */
export const draftOf = (overrides: ModelOverrides, rowVersion: number): Draft => {
  const rest = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => !(OWN as ReadonlyArray<string>).includes(key))
  )
  return {
    name: overrides.name ?? "",
    context: overrides.context?.toString() ?? "",
    maxOutput: overrides.maxOutput?.toString() ?? "",
    vision: triOf(overrides.vision),
    reasoning: triOf(overrides.reasoning),
    tools: triOf(overrides.tools),
    prefill: overrides.prefill ?? "auto",
    overrides: rest,
    settings: (overrides.settings ?? {}) as Json,
    drafts: {},
    rows: {},
    clamped: {},
    rowVersion
  }
}

/**
 * Reads a stored draft text. An older one held the settings and the other overrides as JSON
 * text (the form's JSON boxes): their parsed values are taken over, and text that isn't
 * valid JSON falls back to what's saved.
 */
export const readDraft = (text: string, saved: Draft): Draft => {
  const parsed = JSON.parse(text) as Record<string, unknown>
  const json = (value: unknown, fallback: Json): Json => {
    if (isRecord(value)) return value
    if (typeof value !== "string") return fallback
    try {
      const inner: unknown = JSON.parse(value)
      return isRecord(inner) ? inner : fallback
    } catch {
      return fallback
    }
  }
  const older = typeof parsed.capabilities === "string"
  const capabilities = older ? json(parsed.capabilities, saved.overrides) : json(parsed.overrides, saved.overrides)
  const { capabilities: _c, ...rest } = parsed
  void _c
  return {
    ...saved,
    ...(rest as Partial<Draft>),
    overrides: older
      ? Object.fromEntries(
          Object.entries(capabilities).filter(([key]) => !(OWN as ReadonlyArray<string>).includes(key))
        )
      : capabilities,
    settings: json(parsed.settings, saved.settings),
    drafts: isRecord(parsed.drafts) ? (parsed.drafts as Draft["drafts"]) : {},
    rows: isRecord(parsed.rows) ? (parsed.rows as Draft["rows"]) : {},
    clamped: isRecord(parsed.clamped) ? (parsed.clamped as Draft["clamped"]) : {}
  }
}

/** The value at `path` in `root`. */
export const getAt = (root: Json, path: ReadonlyArray<string>): unknown => {
  let at: unknown = root
  for (const key of path) {
    if (!isRecord(at)) return undefined
    at = at[key]
  }
  return at
}

/** `root` with `value` at `path`; undefined removes it, and groups left empty go with it. */
export const setAt = (root: Json, path: ReadonlyArray<string>, value: unknown): Json => {
  const [key, ...rest] = path
  if (key === undefined) return root
  const inner = rest.length === 0 ? value : setAt(isRecord(root[key]) ? root[key] : {}, rest, value)
  const { [key]: _, ...others } = root
  void _
  return inner === undefined || (isRecord(inner) && Object.keys(inner).length === 0 && rest.length > 0)
    ? others
    : { ...others, [key]: inner }
}

/**
 * A value as typed in a parameter row: a number, true or false, or text. Quotes keep text that
 * reads as a number or true/false ("1" stays the text 1). Empty is null.
 */
export const parseTyped = (text: string): unknown => {
  const trimmed = text.trim()
  if (trimmed === "") return null
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$/i.test(trimmed)) return Number(trimmed)
  const quoted = /^"(.*)"$/s.exec(trimmed)
  return quoted ? quoted[1] : text
}

/** What a typed value reads as, for the row's tag. */
export const typeOf = (value: unknown) =>
  value === null
    ? "empty"
    : typeof value === "number"
      ? "number"
      : typeof value === "boolean"
        ? "true/false"
        : typeof value === "string"
          ? "text"
          : Array.isArray(value)
            ? "list"
            : "group"

/** A stored value as a row shows it: text that reads as something else gets its quotes. */
const showTyped = (value: unknown): string => {
  if (typeof value === "string") {
    const reads = parseTyped(value)
    return reads === value ? value : `"${value}"`
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

/** Whether a stored value can be edited in a row: a number, true or false, or text. */
export const isScalar = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"

/** A record's entries as rows. */
export const rowsOf = (record: unknown, show: (value: unknown) => string = showTyped): ReadonlyArray<Row> =>
  isRecord(record) ? Object.entries(record).map(([name, value]) => ({ name, value: show(value) })) : []

/**
 * Rows back to a record: each named row's value parsed by `parse`. A row a structured stored
 * value stands behind (a list or group no row can show) keeps that value.
 */
export const recordOf = (
  rows: ReadonlyArray<Row>,
  stored: unknown,
  parse: (text: string) => unknown = parseTyped
): Record<string, unknown> | undefined => {
  const kept = isRecord(stored) ? stored : {}
  const entries = rows
    .filter((row) => row.name.trim() !== "")
    .map((row) => {
      const name = row.name.trim()
      const before = kept[name]
      return [name, before !== undefined && !isScalar(before) && row.value === "" ? before : parse(row.value)] as const
    })
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/** A comma-separated list as typed ("together, deepinfra/fp8") and back. */
export const listOf = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
export const showList = (value: unknown) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : ""

/**
 * The draft with another model's user settings in it, unsaved: its settings (samplers, effort,
 * verbosity, stop strings, routing, the rest), whether it reasons, and its extra request
 * parameters. This model's name, its own limits and every other capability override stay as
 * they are. A context or reply length over this model's limits comes down to them, and
 * `clamped` says so in the field's hover.
 */
export const copyInto = (
  draft: Draft,
  source: ModelOverrides,
  from: string,
  limits: { readonly context: number; readonly maxOutput: number }
): Draft => {
  let settings = (source.settings ?? {}) as Json
  const clamped: Record<string, string> = {}
  const context = getAt(settings, ["samplers", "openai_max_context"])
  if (typeof context === "number" && context >= limits.context) {
    // All of the window, as the slider at its end sets it.
    settings = setAt(settings, ["samplers", "openai_max_context"], undefined)
    if (context > limits.context)
      clamped.openai_max_context = `${from} has ${context.toLocaleString()}: limited to this model’s context window, ${limits.context.toLocaleString()}.`
  }
  const reply = getAt(settings, ["samplers", "openai_max_tokens"])
  if (typeof reply === "number" && reply > limits.maxOutput) {
    settings = setAt(settings, ["samplers", "openai_max_tokens"], limits.maxOutput)
    clamped.openai_max_tokens = `${from} has ${reply.toLocaleString()}: limited to this model’s output limit, ${limits.maxOutput.toLocaleString()}.`
  }
  const copied = (key: string) => key.startsWith("settings.") || key === "overrides.sampling"
  const kept = <A>(record: Readonly<Record<string, A>>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !copied(key)))
  return {
    ...draft,
    reasoning: triOf(source.reasoning),
    settings,
    overrides: setAt(draft.overrides, ["sampling"], source.sampling),
    drafts: kept(draft.drafts),
    rows: kept(draft.rows),
    clamped
  }
}
