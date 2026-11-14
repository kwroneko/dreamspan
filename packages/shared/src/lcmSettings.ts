import { Schema } from "effect"
import { RefId } from "./library.ts"
import { ConnectionId, ModelId } from "./providers.ts"

/** A model of the user's, by its connection. */
export const ModelChoice = Schema.Struct({ connection: ConnectionId, model: ModelId })

/** A summary request uses the current preset, a selected library preset, or no preset.
 * The optional `preset` ref holds the specific choice. */
export const SummaryPreset = Schema.Literals(["current", "specific", "raw"])
export type SummaryPreset = typeof SummaryPreset.Type
/** Old stored booleans remain readable without migrating chat state. */
const StoredSummaryPreset = Schema.Union([SummaryPreset, Schema.Boolean])
export const summaryPreset = (value: SummaryPreset | boolean): SummaryPreset =>
  value === true ? "current" : value === false ? "raw" : value

const Tokens = Schema.Int.check(Schema.isGreaterThan(0))

/** When summaries are made: right after a reply while the cache is warm, or with the next reply. */
export const LcmWhen = Schema.Literals(["after-reply", "next-reply"])
export type LcmWhen = typeof LcmWhen.Type

/** The settings a chat and the account default share (DESIGN §8), all optional but `enabled` in a chat. */
const sizes = {
  /** Choose the preset used by summary requests, or send only the instruction and messages. */
  withPreset: Schema.optionalKey(StoredSummaryPreset),
  preset: Schema.optionalKey(RefId),
  /** Send the chat's notes with a summary request: they may tell of events after the chunk. */
  withNotes: Schema.optionalKey(Schema.Boolean),
  /** Recent messages kept as written: above the maximum the oldest are summarized back to the target. */
  recentTarget: Schema.optionalKey(Tokens),
  recentMax: Schema.optionalKey(Tokens),
  /** The summary block: above the maximum the oldest summaries are condensed back to the target. */
  layerTarget: Schema.optionalKey(Tokens),
  layerMax: Schema.optionalKey(Tokens),
  when: Schema.optionalKey(LcmWhen),
  /** How a summary is written: the reply itself ("direct") or through a tool ("tool"); other ids may be registered. */
  style: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  /** The level-1 instruction; `{{words}}` is the summary length. */
  tail: Schema.optionalKey(Schema.String),
  /** Chunk size: the tokens of messages one summary covers. */
  leafInput: Schema.optionalKey(Tokens),
  /** Summary length, in tokens; the instruction asks for it in words (`summaryWords`). */
  leafTarget: Schema.optionalKey(Tokens)
}

/** A target must be below its maximum when both are set in one place. */
const ordered = Schema.makeFilter(
  (s: {
    readonly recentTarget?: number | undefined
    readonly recentMax?: number | undefined
    readonly layerTarget?: number | undefined
    readonly layerMax?: number | undefined
  }) =>
    s.recentTarget !== undefined && s.recentMax !== undefined && s.recentTarget >= s.recentMax
      ? "the recent messages' target must be below their maximum"
      : s.layerTarget !== undefined && s.layerMax !== undefined && s.layerTarget >= s.layerMax
        ? "the summary block's target must be below its maximum"
        : undefined
)

export const LcmSettings = Schema.Struct({
  enabled: Schema.Boolean,
  ...sizes,
  /** Same-level summaries condensed into one (reference-harness's condense_fanout, 5). */
  fanout: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2))),
  /** The output target of a condensation, in tokens (condense_target_tokens, 800). */
  condenseTarget: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
}).check(ordered)
export type LcmSettings = typeof LcmSettings.Type

export const LcmDefaults = Schema.Struct({
  /** Whether new chats summarize (imported chats start off whatever this says). */
  enabled: Schema.optionalKey(Schema.Boolean),
  ...sizes,
  /** The old name of `when`: false is "next-reply". Read when `when` is absent, never written. */
  spendAhead: Schema.optionalKey(Schema.Boolean),
  /** The model that writes summaries in a chat without its own; absent: the chat's model. */
  summarizer: Schema.optionalKey(ModelChoice),
  /** Tried once for a summary whose retries ran out on the summarizer's model. */
  fallback: Schema.optionalKey(ModelChoice)
}).check(ordered)
export type LcmDefaults = typeof LcmDefaults.Type

type Binding = { readonly connection: string; readonly model: string }

/**
 * The model a chat's summaries are written with: the chat's own summary model (its
 * "summarizer"-scoped `model.binding`), else the account's (`lcm.summarizer`), else the chat's
 * model; null when none is set (the user's default model applies then, as for a reply).
 */
export const summaryModelBinding = (
  bindings: Readonly<Record<string, Binding>>,
  defaults: LcmDefaults | null | undefined
): Binding | null => bindings["summarizer"] ?? defaults?.summarizer ?? bindings["narrator"] ?? bindings[""] ?? null

/** The settings a user sets field by field: a chat's (`ChangeLcmSettings`) or the account default's. */
export type LcmField =
  | "enabled"
  | "withPreset"
  | "preset"
  | "withNotes"
  | "tail"
  | "recentTarget"
  | "recentMax"
  | "layerTarget"
  | "layerMax"
  | "when"
  | "style"
  | "leafInput"
  | "leafTarget"

/** A change to a chat's settings: a field set, or null to follow the account default again. */
export const LcmSettingsChange = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  withPreset: Schema.optionalKey(Schema.NullOr(StoredSummaryPreset)),
  preset: Schema.optionalKey(Schema.NullOr(RefId)),
  withNotes: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  tail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  recentTarget: Schema.optionalKey(Schema.NullOr(Tokens)),
  recentMax: Schema.optionalKey(Schema.NullOr(Tokens)),
  layerTarget: Schema.optionalKey(Schema.NullOr(Tokens)),
  layerMax: Schema.optionalKey(Schema.NullOr(Tokens)),
  when: Schema.optionalKey(Schema.NullOr(LcmWhen)),
  style: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)))),
  leafInput: Schema.optionalKey(Schema.NullOr(Tokens)),
  leafTarget: Schema.optionalKey(Schema.NullOr(Tokens))
})
export type LcmSettingsChange = typeof LcmSettingsChange.Type

/**
 * The built-in values (DESIGN §8). Recent messages 12,000/20,000 and the summaries 14,000/18,000
 * tokens: summaries cover all the older history, and recent chat grows faster, so it gets the
 * wider band. The chunk size has no fixed default: it is min(4,000, half the recent band) once
 * the pair is fitted to the model.
 */
export const LCM_BUILTIN = {
  enabled: true,
  withPreset: "current",
  withNotes: false,
  recentTarget: 12_000,
  recentMax: 20_000,
  layerTarget: 14_000,
  layerMax: 18_000,
  when: "after-reply" as LcmWhen,
  style: "direct",
  leafTarget: 600
} as const

/** A summary length in tokens as the words an instruction asks for: about 0.75 words a token. */
export const summaryWords = (tokens: number) => Math.max(1, Math.round(tokens * 0.75))

/**
 * The level-1 instruction when neither the chat nor the account sets one: the owner's Sum2
 * request, made neutral. `{{words}}` is the summary length.
 */
export const BUILTIN_SUMMARY_INSTRUCTION =
  "Pause the roleplay and write a summary of the story so far, for continuing it later. If there is already a summary, start where it stopped and don't repeat it. Keep the story's language and voice, names, events, relationships and unresolved threads. At most {{words}} words."

/** The settings that apply to a chat, each from the chat, else the account default, else built in. */
export interface ResolvedLcm {
  readonly enabled: boolean
  readonly withPreset: SummaryPreset
  readonly preset: typeof RefId.Type | null
  readonly withNotes: boolean
  /** Null: the built-in instruction. */
  readonly tail: string | null
  readonly recentTarget: number
  readonly recentMax: number
  readonly layerTarget: number
  readonly layerMax: number
  readonly when: LcmWhen
  readonly style: string
  /** Null: min(4,000, half the recent band). */
  readonly leafInput: number | null
  readonly leafTarget: number
  /** Where each field comes from. */
  readonly from: Readonly<Record<LcmField, "chat" | "account" | "builtin">>
}

const whenOf = (defaults: LcmDefaults | null | undefined): LcmWhen | undefined =>
  defaults?.when ??
  (defaults?.spendAhead === false ? "next-reply" : defaults?.spendAhead === true ? "after-reply" : undefined)

/**
 * Resolution, one function for server and client: the chat's field, else the account
 * default's, else the built-in. A chat's `enabled` is its own; without a chat (a new one) it
 * is the account default's.
 */
export const resolveLcm = (
  chat: Partial<LcmSettings> | null | undefined,
  defaults: LcmDefaults | null | undefined
): ResolvedLcm => {
  const account: Partial<Record<LcmField, unknown>> = { ...defaults, when: whenOf(defaults) }
  const from = {} as Record<LcmField, "chat" | "account" | "builtin">
  const pick = <K extends LcmField>(key: K, builtin: unknown) => {
    const own = chat?.[key as keyof LcmSettings]
    if (own !== undefined) {
      from[key] = "chat"
      return own
    }
    if (account[key] !== undefined) {
      from[key] = "account"
      return account[key]
    }
    from[key] = "builtin"
    return builtin
  }
  return {
    enabled: pick("enabled", chat ? false : LCM_BUILTIN.enabled) as boolean,
    withPreset: summaryPreset(pick("withPreset", LCM_BUILTIN.withPreset) as SummaryPreset | boolean),
    preset: pick("preset", null) as typeof RefId.Type | null,
    withNotes: pick("withNotes", LCM_BUILTIN.withNotes) as boolean,
    tail: pick("tail", null) as string | null,
    recentTarget: pick("recentTarget", LCM_BUILTIN.recentTarget) as number,
    recentMax: pick("recentMax", LCM_BUILTIN.recentMax) as number,
    layerTarget: pick("layerTarget", LCM_BUILTIN.layerTarget) as number,
    layerMax: pick("layerMax", LCM_BUILTIN.layerMax) as number,
    when: pick("when", LCM_BUILTIN.when) as LcmWhen,
    style: pick("style", LCM_BUILTIN.style) as string,
    leafInput: pick("leafInput", null) as number | null,
    leafTarget: pick("leafTarget", LCM_BUILTIN.leafTarget) as number,
    from
  }
}

/**
 * What a new chat stores: a full copy of the account default as it resolves now, so a later
 * change of the default leaves the chat as it was (the instruction and chunk size only when
 * the account sets them; otherwise the built-in applies).
 */
export const newChatLcm = (defaults: LcmDefaults | null | undefined, enabled?: boolean): LcmSettings => {
  const r = resolveLcm(null, defaults)
  return {
    enabled: enabled ?? r.enabled,
    withPreset: r.withPreset,
    ...(r.preset !== null ? { preset: r.preset } : {}),
    withNotes: r.withNotes,
    recentTarget: r.recentTarget,
    recentMax: r.recentMax,
    layerTarget: r.layerTarget,
    layerMax: r.layerMax,
    when: r.when,
    style: r.style,
    leafTarget: r.leafTarget,
    ...(r.tail !== null ? { tail: r.tail } : {}),
    ...(r.leafInput !== null ? { leafInput: r.leafInput } : {})
  }
}

/** A pair fitted to what the model leaves: scaled down whole when its maximum is over `room`. */
export const fitPair = (target: number, maximum: number, room: number) => {
  const max = Math.max(0, Math.floor(Math.min(maximum, room)))
  const scaled = maximum > room ? Math.floor((target * max) / Math.max(1, maximum)) : target
  return { target: Math.max(0, Math.min(scaled, max)), maximum: max, clamped: maximum > room }
}

/**
 * The target a new maximum at or below it takes with it (DESIGN §8): the same share of the
 * maximum as before, in hundreds, and always below it; null when the target already fits.
 */
export const loweredTarget = (target: number, maximum: number, newMaximum: number): number | null => {
  if (newMaximum > target) return null
  const share = Math.floor((target * newMaximum) / Math.max(1, maximum) / 100) * 100
  return Math.max(1, share > 0 && share < newMaximum ? share : newMaximum - 1)
}

/** The chunk size: the setting, else min(4,000, half the recent band). */
export const chunkSize = (leafInput: number | null, recent: { readonly target: number; readonly maximum: number }) =>
  leafInput ?? Math.min(4000, Math.floor((recent.maximum - recent.target) / 2))

/** A setting that doesn't fit: one plain sentence, keyed by the field it is shown under. */
export interface LcmMisfit {
  readonly field: "recentMax" | "recentTarget" | "layerMax" | "layerTarget" | "leafInput"
  readonly message: string
}

const n = (value: number) => Math.round(value).toLocaleString("en-US")

/**
 * The fit check (DESIGN §8: "the section shows when the pairs don't fit"): both maxima beside
 * the fixed part and the reply against the model's context; the chunk twice inside the recent
 * band; each target below its maximum.
 */
export const lcmMisfits = (
  r: Pick<ResolvedLcm, "recentTarget" | "recentMax" | "layerTarget" | "layerMax" | "leafInput">,
  room: { readonly context: number; readonly fixed: number; readonly reply: number } | null,
  /** The recent pair as fitted to the model, which the chunk must fit twice; the settings' own without a model. */
  recent: { readonly target: number; readonly maximum: number } = { target: r.recentTarget, maximum: r.recentMax }
): ReadonlyArray<LcmMisfit> => {
  const out: Array<LcmMisfit> = []
  if (r.recentTarget >= r.recentMax)
    out.push({
      field: "recentTarget",
      message: `The target (${n(r.recentTarget)}) must be below the maximum (${n(r.recentMax)}).`
    })
  if (r.layerTarget >= r.layerMax)
    out.push({
      field: "layerTarget",
      message: `The target (${n(r.layerTarget)}) must be below the maximum (${n(r.layerMax)}).`
    })
  if (room) {
    const left = room.context - room.fixed - room.reply
    // Shown under the pair that takes the larger share: the one to look at first.
    if (r.recentMax + r.layerMax > left)
      out.push({
        field: r.layerMax > r.recentMax ? "layerMax" : "recentMax",
        message: `Recent messages (${n(r.recentMax)}) and summaries (${n(r.layerMax)}) need ${n(r.recentMax + r.layerMax)} tokens; this model's context leaves ${n(Math.max(0, left))} after the preset and reply.`
      })
  }
  const chunk = chunkSize(r.leafInput, recent)
  if (recent.target < recent.maximum && (chunk < 1 || chunk * 2 > recent.maximum - recent.target))
    out.push({
      field: "leafInput",
      message: `Chunk size ${n(chunk)} needs a gap of at least ${n(chunk * 2)} tokens. The recent target and maximum are ${n(recent.maximum - recent.target)} apart.`
    })
  return out
}

/**
 * The prompts of a preset that send `{{summary}}`: those its order has on whose text holds the
 * macro, by identifier (ST sends a prompt only while its order entry is enabled).
 */
export const summaryMacroPrompts = (preset: {
  readonly prompts: ReadonlyArray<{ readonly identifier: string; readonly content: string }>
  readonly order: ReadonlyArray<{ readonly identifier: string; readonly enabled: boolean }>
}) => {
  const on = new Set(preset.order.filter((e) => e.enabled).map((e) => e.identifier))
  return preset.prompts
    .filter((p) => on.has(p.identifier) && /\{\{summary\}\}/i.test(p.content))
    .map((p) => p.identifier)
}
