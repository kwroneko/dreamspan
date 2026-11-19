// Subagents' models and limits (spec/SUBAGENTS.md §5, §6.2, §6.3): which models a chat's
// subagents may use, by a short alias with a one-line note the assistant reads, and how much
// each subagent, each reply's subagents together, and the account's running subagents may do.
//
// A pick is one of the subagent model chip's entries: `same` (the chat's own model, tracking the
// model chip), `summary` (the chat's summary model) or a model, as `<connection> <model>`.
// The account's picks are what every chat follows; a chat locked to its own picks keeps them
// (state key `subagents.models`), exactly as the model chip's lock works (DESIGN §7.10 [D]).
import { Schema } from "effect"

/** The chat's own model: always first on the list the assistant sees, where it's picked. */
export const SAME = "same"
/** The chat's summary model, offered where it differs from the chat's model. */
export const SUMMARY = "summary"

/** A chip entry: `same`, `summary`, or `<connection> <model>`. */
export const SubagentPick = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))

/** What the chip and the agent may pick, at most this many. */
export const MAX_PICKS = 32

export const SubagentPicks = Schema.Array(SubagentPick).check(Schema.isMaxLength(MAX_PICKS))
export type SubagentPicks = typeof SubagentPicks.Type

/** A short lower-case word the assistant writes: `fast`, `strong`, `local`. */
const SubagentAlias = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,23}$/))

/** Limits per subagent (§6.2); a model's row may lower or raise any of them for that model. */
export const SubagentCaps = Schema.Struct({
  /** Its most model requests; the last is made without tools ("Write your report now."). */
  requests: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  /** Tokens in and out, summed over its requests. */
  tokens: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 100_000_000 }))),
  /** Cost in the ledger's currency (US dollars by default). */
  cost: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
  /** Wall time, in minutes. */
  minutes: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 24 * 60 })))
})
export type SubagentCaps = typeof SubagentCaps.Type

/** One model's alias, its note for the assistant, and its own limits. */
export const SubagentModelRow = Schema.Struct({
  alias: SubagentAlias,
  note: Schema.String.check(Schema.isMaxLength(300)),
  caps: Schema.optionalKey(SubagentCaps)
})
export type SubagentModelRow = typeof SubagentModelRow.Type

/** The account setting `subagents.models`: its picks, and each model's row by pick. */
export const SubagentModels = Schema.Struct({
  picks: SubagentPicks,
  rows: Schema.Record(SubagentPick, SubagentModelRow)
})
export type SubagentModels = typeof SubagentModels.Type

/** The account setting `subagents.limits` (§6.2, §6.3); absent fields take the defaults. */
export const SubagentLimits = Schema.Struct({
  ...SubagentCaps.fields,
  /** Subagents one reply may start, continuations included. */
  perRun: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  /** A reply's subagents together may cost at most this many times one subagent's cost limit. */
  runCostTimes: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  /** Running at once per reply; more wait, queued. */
  runConcurrent: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
  /** Running at once across the account; more wait, queued. */
  accountConcurrent: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })))
})
export type SubagentLimits = typeof SubagentLimits.Type
export type ResolvedLimits = Required<SubagentLimits>

/** The defaults (§6.2, §6.3), for a workshop subagent. */
const DEFAULT_LIMITS: ResolvedLimits = {
  requests: 30,
  tokens: 400_000,
  cost: 0.5,
  minutes: 15,
  perRun: 16,
  runCostTimes: 4,
  runConcurrent: 4,
  accountConcurrent: 8
}

export const resolveLimits = (stored: SubagentLimits | null | undefined): ResolvedLimits => ({
  ...DEFAULT_LIMITS,
  ...stored
})

/** The rows the account has without writing any: `same` and the summary model's `fast`. */
const DEFAULT_ROWS: Readonly<Record<string, SubagentModelRow>> = {
  [SAME]: { alias: "same", note: "The model you're running on." },
  [SUMMARY]: { alias: "fast", note: "Cheaper and faster; for lookups and reading." }
}

/** The default picks (DESIGN §7.10 [D]): "Same as this chat's model". */
const DEFAULT_PICKS: SubagentPicks = [SAME]

export const resolveModels = (stored: SubagentModels | null | undefined): SubagentModels => ({
  picks: stored?.picks ?? DEFAULT_PICKS,
  rows: { ...DEFAULT_ROWS, ...stored?.rows }
})

/** A model pick's connection and model; null for `same` and `summary`. */
export const parseModelPick = (pick: string): { readonly connection: string; readonly model: string } | null => {
  if (pick === SAME || pick === SUMMARY) return null
  const space = pick.indexOf(" ")
  return space <= 0 || space === pick.length - 1
    ? null
    : { connection: pick.slice(0, space), model: pick.slice(space + 1) }
}

/** An alias for a model without a row: its id's last part, lower-cased, made unique among `taken`. */
const aliasFor = (modelId: string, taken: ReadonlySet<string>) => {
  const base =
    (modelId.split("/").at(-1) ?? modelId)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 20) || "model"
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** Every pick's row: its own, else a default, else an alias made from its model's id. */
export const rowsFor = (models: SubagentModels, picks: ReadonlyArray<string>) => {
  const taken = new Set(Object.values(models.rows).map((r) => r.alias))
  const rows = new Map<string, SubagentModelRow>()
  for (const pick of picks) {
    const own = models.rows[pick]
    if (own) {
      rows.set(pick, own)
      continue
    }
    const alias = aliasFor(parseModelPick(pick)?.model ?? pick, taken)
    taken.add(alias)
    rows.set(pick, { alias, note: "" })
  }
  return rows
}

/** What's wrong with a set of rows: two picks with one alias, or `same` used for another model. */
export const rowProblems = (rows: Readonly<Record<string, SubagentModelRow>>): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const seen = new Map<string, string>()
  for (const [pick, row] of Object.entries(rows)) {
    if (row.alias === "same" && pick !== SAME) problems.push(`“same” is the chat's own model's name.`)
    const other = seen.get(row.alias)
    if (other !== undefined) problems.push(`Two models are called “${row.alias}”.`)
    seen.set(row.alias, pick)
  }
  return problems
}

/** The settings page's read: the account's models (picks and rows, defaults filled in) and limits. */
export const SubagentSettings = Schema.Struct({
  models: SubagentModels,
  limits: SubagentLimits
})
export type SubagentSettings = typeof SubagentSettings.Type

/** A change the settings page can't save as it is: two models with one alias, say. */
export class SubagentSettingsRejected extends Schema.TaggedError<SubagentSettingsRejected>()(
  "SubagentSettingsRejected",
  { message: Schema.String }
) {}
