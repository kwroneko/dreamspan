import { TokenizerInfo } from "./generation.ts"
import { Placement, REPLACEABLE_CARD_FIELDS } from "./docs/note.ts"
// The request inspector and the cache-warmth estimate (DESIGN §5.5, §7.4), merged into AppApi.
import { SelectiveLogic } from "./docs/lorebook.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, ContextIssue, EntityId, ForkId, SlotId, VersionId } from "./chat.ts"
import { StartChatInput } from "./chatStart.ts"
import { NotFound, ServerError } from "./errors.ts"
import { LlmRequestId, RequestStatus, UsageSource } from "./usage.ts"
import { RefId } from "./library.ts"
import { ScriptRef } from "./regexScripts.ts"

/** Historical activation decisions; keyword text is scrubbed with the sent request. */
export const SourceActivation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lorebook"),
    status: Schema.Literal("activated"),
    step: Schema.Int,
    why: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("constant") }),
      Schema.Struct({ kind: Schema.Literal("sticky") }),
      /** Kept from an earlier turn while the history's start holds (DESIGN §1.3). */
      Schema.Struct({ kind: Schema.Literal("pinned") }),
      /** Admitted by a decision model whose answer to the entry's question was yes (spec/AGENTIC.md §7). */
      Schema.Struct({ kind: Schema.Literal("decision"), probability: Schema.Number }),
      Schema.Struct({
        kind: Schema.Literal("keys"),
        primaryKey: Schema.String,
        secondaryKeys: Schema.Array(Schema.String),
        logic: Schema.optionalKey(SelectiveLogic),
        /** The notes scanned for lorebook entries (`scan_lore`) whose text has the primary key. */
        notes: Schema.optionalKey(Schema.Array(Schema.String))
      })
    ])
  }),
  Schema.Struct({
    kind: Schema.Literal("lorebook"),
    status: Schema.Literal("skipped"),
    step: Schema.Int,
    reason: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("note"),
    activation: Schema.Literals(["explicit", "default"]),
    /** Only in snapshots from before intervals were dropped; null since. */
    interval: Schema.NullOr(Schema.Int),
    userMessages: Schema.NullOr(Schema.Int),
    /** When the note applies, for one with a condition: "on Aria's turn", "while Bram isn't muted". */
    condition: Schema.optionalKey(Schema.String),
    due: Schema.Boolean
  })
])
export type SourceActivation = typeof SourceActivation.Type

/** Where a piece of a request message came from, named for the user. */
export const ContextSource = Schema.Struct({
  summary: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      revision: Schema.String,
      stale: Schema.Boolean,
      changed: Schema.optionalKey(Schema.Boolean)
    })
  ),
  /** Built-in source kind or a namespaced plugin kind (<plugin-id>/<kind>). */
  kind: Schema.Union([
    Schema.Literals(["preset", "card", "lorebook", "note", "summary", "message", "direction", "assembler"]),
    Schema.String.check(Schema.isPattern(/^[^/]+\/[^/]+$/))
  ]),
  /** Stable identity from source references and revisions, independent of display text. */
  id: Schema.String,
  label: Schema.String,
  activation: Schema.NullOr(SourceActivation),
  /** A message of the chat, to link to. */
  slotId: Schema.NullOr(SlotId),
  /** A history message's version, by its place among the slot's versions when it was sent, from 1. */
  version: Schema.optionalKey(Schema.Int),
  /** The library item it came from (a card, lorebook or preset), to link to; absent in older captures. */
  ref: Schema.optionalKey(Schema.String),
  /**
   * What in that item it is, so its link lands there: a preset's prompt, a lorebook's entry
   * (`embedded`: a card's own book, opened on the card), a card's field. Absent: the item as a whole.
   */
  item: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("prompt"), identifier: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("entry"), uid: Schema.Int, embedded: Schema.Boolean }),
      Schema.Struct({ kind: Schema.Literal("field"), field: Schema.String })
    ])
  ),
  /** The prompt regex scripts that changed its text in this request, in the order they ran; absent: none. */
  scripts: Schema.optionalKey(Schema.Array(ScriptRef))
})
export type ContextSource = typeof ContextSource.Type

/** Why a cache breakpoint follows a message: the end of the preset's prefix, or of the stable history. */
const BreakpointReason = Schema.Literals(["prefix", "summary", "history", "pinned"])

/** Where an image's token figure comes from (DESIGN §10.2a; `@dreamspan/shared/imageTokens.ts`). */
const ImageTokenBasis = Schema.Literals(["counted", "formula", "calibrated", "unknown"])

/** One sent image's token estimate, as the context view shows it. */
export const ContextImage = Schema.Struct({
  /** Null when unknown; the budget then counts `bound`, or a reserve. */
  tokens: Schema.NullOr(Schema.Int),
  basis: ImageTokenBasis,
  /** What the budget counted for it. */
  budgeted: Schema.Int,
  detail: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  /** False when the last-N image limit leaves it out of the request. */
  sent: Schema.Boolean
})
export type ContextImage = typeof ContextImage.Type

export const ContextMessage = Schema.Struct({
  role: Schema.Literals(["system", "developer", "user", "assistant", "model"]),
  name: Schema.NullOr(Schema.String),
  prefill: Schema.optionalKey(
    Schema.Struct({
      protocol: Schema.Literals(["deepseek_prefix", "tool_schema"]),
      schema: Schema.optionalKey(Schema.String)
    })
  ),
  content: Schema.String,
  /** The assembler's estimate: a token per four characters, plus three per message, plus its images. */
  tokens: Schema.Int,
  /** The message's images and their token estimates; absent without images. */
  images: Schema.optionalKey(Schema.Array(ContextImage)),
  sources: Schema.Array(ContextSource),
  /**
   * Where each source's text sits in `content`: character offsets, in order, not overlapping, with
   * `source` an index into `sources`. Text between parts is the assembler's joins and wrappers.
   * A rewritten piece is boxed where its text was (`rewritten`), never left to the joins.
   * Absent in captures from before parts were recorded.
   */
  parts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        start: Schema.Int,
        end: Schema.Int,
        source: Schema.Int,
        /** A wrapper its block's owner added, such as a card join prefix: framing, not content. */
        frame: Schema.optionalKey(Schema.Literal(true)),
        /**
         * Its text isn't the piece's as assembled (a provider transform rewrote the message): the
         * text where it was, between the parts around it.
         */
        rewritten: Schema.optionalKey(Schema.Literal(true)),
        /** Other sources rewritten into the same text, indices into `sources`. */
        also: Schema.optionalKey(Schema.Array(Schema.Int))
      })
    )
  ),
  /**
   * The labelled blocks around the parts (a card's wrapped field, the characters' definitions, a
   * preset prompt that read cards through a macro, a lorebook block), same offsets, nested ones
   * inside their outer ones; text in a group outside its parts is its framing. Absent in older
   * captures and when no part sits in a block.
   */
  groups: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        start: Schema.Int,
        end: Schema.Int,
        source: Schema.Int,
        rewritten: Schema.optionalKey(Schema.Literal(true))
      })
    )
  ),
  breakpoint: Schema.NullOr(BreakpointReason)
})
export type ContextMessage = typeof ContextMessage.Type

/** When a request ran, epoch ms: sent, first streamed token (text or reasoning), ended; null until then. */
const RequestTimes = {
  startedAt: Schema.Number,
  firstTokenAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number)
}

/** Only the usage fields the inspector displays; provider metadata never crosses this boundary. */
export const InspectorUsage = Schema.Struct({
  id: LlmRequestId,
  estimatedInput: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  status: RequestStatus,
  ...RequestTimes,
  counts: Schema.Struct({
    inputUncached: Schema.NullOr(Schema.Int),
    cacheRead: Schema.NullOr(Schema.Int),
    cacheWrite: Schema.NullOr(Schema.Int),
    output: Schema.NullOr(Schema.Int)
  }),
  usageSource: UsageSource,
  cost: Schema.NullOr(Schema.Struct({ amount: Schema.Number, currency: Schema.String }))
})
export type InspectorUsage = typeof InspectorUsage.Type

/** One generation request's figures, for a version's metrics. */
export const RequestFigures = Schema.Struct({
  status: RequestStatus,
  ...RequestTimes,
  output: Schema.NullOr(Schema.Int),
  reasoning: Schema.NullOr(Schema.Int),
  /** `estimated`: the app counted the tokens; `none`: nobody did (the counts are null). */
  usageSource: UsageSource,
  /** Input not read from the cache, read from it and written to it (`cacheWriteLong`: the long-lived part of the writes). */
  inputUncached: Schema.NullOr(Schema.Int),
  cacheRead: Schema.NullOr(Schema.Int),
  cacheWrite: Schema.NullOr(Schema.Int),
  cacheWriteLong: Schema.NullOr(Schema.Int),
  /** The ledger's cost with its currency and the formula that priced it (`reported`, `builtin`, `user:…`). */
  cost: Schema.NullOr(
    Schema.Struct({
      amount: Schema.Number,
      currency: Schema.String,
      formula: Schema.String,
      /** Per million tokens, when the price named a rate for reasoning apart from output. */
      reasoningRate: Schema.optionalKey(Schema.Number)
    })
  ),
  /** What the provider said it charged, when it said (USD). */
  reportedCost: Schema.NullOr(Schema.Number)
})
export type RequestFigures = typeof RequestFigures.Type

/** An amount in one currency. */
export const CostAmount = Schema.Struct({ amount: Schema.Number, currency: Schema.String })
export type CostAmount = typeof CostAmount.Type

/**
 * A version's generation time and tokens (parity finding 5): summed over every generation
 * request behind its text, its own attempts and those of the versions it continued (through
 * `sourceVersionId`), with the last request's figures apart. A version none was made for
 * (a user's, an edit, an import) has none. Unknown is null or counted, never zero.
 */
export const VersionMetrics = Schema.Struct({
  versionId: VersionId,
  requests: Schema.Int,
  /** The last request is still running. */
  running: Schema.Boolean,
  /** Sum of the ended requests' durations (start to end); null when none ended. */
  elapsedMs: Schema.NullOr(Schema.Number),
  /** Sum of ended requests' streaming time; null if any first-token time is missing. */
  streamingMs: Schema.NullOr(Schema.Number),
  /** Output tokens of the ended requests that have a count; reasoning tokens are part of them. */
  output: Schema.Int,
  reasoning: Schema.NullOr(Schema.Int),
  /** Ended requests without an output count: `output` leaves them out. */
  outputUnknown: Schema.Int,
  /** Some count is the app's estimate, not the provider's. */
  estimated: Schema.Boolean,
  /**
   * The ended requests' costs, summed per currency in the order first seen: empty when none
   * has one, more than one when they were priced in different currencies (never added up).
   */
  costs: Schema.Array(CostAmount),
  /** Ended requests with no cost: `costs` leaves them out. */
  costUnknown: Schema.Int,
  /** The separate reasoning rates (per million tokens) the costs were priced with, each once; empty when reasoning was priced as output. */
  reasoningRates: Schema.Array(CostAmount),
  /** The formulas that priced them, each once, in the order first seen. */
  costSources: Schema.Array(Schema.String),
  /** Some cost came from counts the app estimated (a provider-reported cost never does). */
  costEstimated: Schema.Boolean,
  /** The sum of what the provider said it charged, over `reportedRequests` requests; null when none said. */
  reportedCost: Schema.NullOr(Schema.Number),
  reportedRequests: Schema.Int,
  /** Input token counts summed over the ended requests; null when none ended or any of them has none. */
  inputUncached: Schema.NullOr(Schema.Int),
  cacheRead: Schema.NullOr(Schema.Int),
  cacheWrite: Schema.NullOr(Schema.Int),
  cacheWriteLong: Schema.NullOr(Schema.Int),
  last: RequestFigures
})
export type VersionMetrics = typeof VersionMetrics.Type

/** Projects a version's requests, oldest first (at least one), into its metrics. */
export const versionMetricsOf = (versionId: VersionId, requests: ReadonlyArray<RequestFigures>): VersionMetrics => {
  const ended = requests.filter((r) => r.endedAt !== null)
  const sum = (values: ReadonlyArray<number>) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0))
  const counted = ended.filter((r) => r.output !== null)
  const last = requests.at(-1)!
  return {
    versionId,
    requests: requests.length,
    running: last.status === "running",
    elapsedMs: sum(ended.map((r) => r.endedAt! - r.startedAt)),
    streamingMs: ended.some((r) => r.firstTokenAt === null)
      ? null
      : sum(ended.map((r) => r.endedAt! - r.firstTokenAt!)),
    output: counted.reduce((total, r) => total + r.output!, 0),
    reasoning: ended.some((r) => r.reasoning === null) ? null : sum(ended.map((r) => r.reasoning!)),
    outputUnknown: ended.length - counted.length,
    estimated: counted.some((r) => r.usageSource === "estimated"),
    ...costsOf(ended),
    inputUncached: total(ended, (r) => r.inputUncached),
    cacheRead: total(ended, (r) => r.cacheRead),
    cacheWrite: total(ended, (r) => r.cacheWrite),
    cacheWriteLong: total(ended, (r) => r.cacheWriteLong),
    last
  }
}

/** A count summed over requests; null when there are none or any lacks it (unknown is never zero). */
const total = (requests: ReadonlyArray<RequestFigures>, of: (r: RequestFigures) => number | null) => {
  if (requests.length === 0) return null
  let sum = 0
  for (const r of requests) {
    const n = of(r)
    if (n === null) return null
    sum += n
  }
  return sum
}

const costsOf = (ended: ReadonlyArray<RequestFigures>) => {
  const costs = new Map<string, number>()
  const sources = new Set<string>()
  const reasoningRates = new Map<string, number>()
  let reported: number | null = null
  let reportedRequests = 0
  for (const r of ended) {
    if (r.cost !== null) {
      costs.set(r.cost.currency, (costs.get(r.cost.currency) ?? 0) + r.cost.amount)
      sources.add(r.cost.formula)
      if (r.cost.reasoningRate !== undefined && !reasoningRates.has(`${r.cost.currency} ${r.cost.reasoningRate}`))
        reasoningRates.set(`${r.cost.currency} ${r.cost.reasoningRate}`, r.cost.reasoningRate)
    }
    if (r.reportedCost !== null) {
      reported = (reported ?? 0) + r.reportedCost
      reportedRequests++
    }
  }
  return {
    costs: [...costs].map(([currency, amount]) => ({ amount, currency })),
    costUnknown: ended.filter((r) => r.cost === null).length,
    costSources: [...sources],
    reasoningRates: [...reasoningRates].map(([key, amount]) => ({ amount, currency: key.split(" ")[0]! })),
    costEstimated: ended.some((r) => r.cost !== null && r.cost.formula !== "reported" && r.usageSource === "estimated"),
    reportedCost: reported,
    reportedRequests
  }
}

/** The complete display projection sanitized at final capture, excluding storage identities and usage. */
export const ContextDisplay = Schema.Struct({
  model: Schema.NullOr(
    Schema.Struct({
      connection: Schema.String,
      model: Schema.String,
      kind: Schema.String,
      /** Breakpoints go to the provider only when they're `explicit`. */
      breakpoints: Schema.Literals(["auto", "explicit", "none"])
    })
  ),
  preset: Schema.Struct({ label: Schema.NullOr(Schema.String), scope: Schema.String }),
  messages: Schema.Array(ContextMessage),
  /** Effective numeric samplers after provider mapping. */
  samplers: Schema.Record(Schema.String, Schema.Number),
  issues: Schema.Array(ContextIssue),
  /**
   * What this turn left out: notes and preset prompts whose condition didn't hold, lorebook
   * entries skipped. Absent in captures from before it was recorded.
   */
  notSent: Schema.optionalKey(Schema.Array(ContextSource))
})
export type ContextDisplay = typeof ContextDisplay.Type

/**
 * Whose view a reply's context was written from (spec/CHARACTER-CONTEXT.md §9.2 unit CU5): in a
 * separate context, the speaker's name and the messages left out because it wasn't present for
 * them, by message number (at most 200 listed, `more` counts the rest); a narrator's reply saw
 * the whole chat. From the reply's own snapshot.
 */
export const SeparateContext = Schema.Struct({
  viewer: Schema.String,
  narrator: Schema.Boolean,
  leftOut: Schema.Array(
    Schema.Struct({
      slotId: SlotId,
      number: Schema.Number,
      speaker: Schema.NullOr(Schema.String),
      merged: Schema.optionalKey(Schema.Struct({ title: Schema.String, ordinal: Schema.Int }))
    })
  ),
  more: Schema.Number
})
export type SeparateContext = typeof SeparateContext.Type

/** One generation's request as it was sent, and what the provider reported for it. */
export class RunContext extends Schema.Class<RunContext>("RunContext")({
  continuity: Schema.optionalKey(
    Schema.Struct({
      parentVersionId: Schema.optionalKey(VersionId),
      reason: Schema.optionalKey(Schema.String),
      /** Older tool results left out of the carried request to make room. */
      elided: Schema.optionalKey(Schema.Int)
    })
  ),
  chatId: ChatId,
  slotId: SlotId,
  versionId: VersionId,
  builtAt: Schema.Number,
  /** The rollout's status: running, completed, stopped, failed, interrupted. */
  status: Schema.String,
  type: Schema.Literals(["normal", "swipe", "impersonate", "continue", "quiet"]),
  mode: Schema.Literals(["st", "layouts"]),
  capture: Schema.Literals(["captured", "unavailable"]),
  tokenizer: Schema.optionalKey(TokenizerInfo),
  /** The decision model chose who wrote this reply (DESIGN §2.3): by the name it was asked about, how sure. */
  speakerPick: Schema.optionalKey(Schema.Struct({ name: Schema.String, confidence: Schema.Number })),
  /**
   * Decision points a connection has on that this chat turned off when the reply was written
   * (`decision.points`): nothing was asked, and `instead` says what decided. Absent: none.
   */
  decisionsOff: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, instead: Schema.String }))
  ),
  /** Absent: one shared context, or a reply from before separate contexts. */
  separateContext: Schema.optionalKey(SeparateContext),
  ...ContextDisplay.fields,
  /** Every attempt, retries included, oldest first. */
  requests: Schema.Array(InspectorUsage)
}) {}

/**
 * Whether the provider's cache for a chat is likely warm (DESIGN §5.5), from its last
 * request: when it started, the model's cache TTL, and whether the next request matches it
 * up to its last cache breakpoint. An estimate: the provider decides.
 */
export const CacheWarmth = Schema.Struct({
  /** Conditional re-read cost when own-turn notes make the speakers’ starts differ. */
  speakerChange: Schema.optionalKey(Schema.String),
  lastRequestAt: Schema.Number,
  ttlS: Schema.NullOr(Schema.Int),
  /** Historical expiry, independent of the next model's eligibility and TTL. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** The provider reported reading or writing its cache on that request. */
  verified: Schema.Boolean,
  /** The last request's tokens up to its last breakpoint: what a warm cache holds. */
  prefixTokens: Schema.Int,
  /** First difference in the mapped prefix, and the next prefix's uncached suffix tokens. */
  changed: Schema.NullOr(Schema.Struct({ reason: Schema.String, tokens: Schema.Int })),
  /** The whole next request's tokens, counted as `changed.tokens` is; absent when it can't be counted. */
  requestTokens: Schema.optionalKey(Schema.Int)
})
export type CacheWarmth = typeof CacheWarmth.Type

/** Estimated budget for the next context, with raw history excluded from its fixed cost. */
export const ContextBudget = Schema.Struct({
  countedInput: Schema.optionalKey(Schema.Int),
  tokenizer: Schema.optionalKey(TokenizerInfo),
  /** Effective context window and stepped target, both including the response reserve. */
  maximum: Schema.Int,
  target: Schema.Int,
  responseReserve: Schema.Int,
  /** Estimated tokens for fixed content, examples, summaries and framing, excluding raw history. */
  nonHistoryTokens: Schema.Int
})
export type ContextBudget = typeof ContextBudget.Type

/**
 * Where the budget's numbers come from, so the note and the refusal name each and the setting
 * that changes it. `context`: the model's own context size setting, or its window from the
 * window's source (`assumed`: no source reports it). `reserve` and `target`: the model's setting
 * or the default.
 */
export const BudgetOrigins = Schema.Struct({
  context: Schema.Literals(["setting", "user", "learned", "upstream", "catalog", "assumed"]),
  /** The catalog and entry, when a catalog gave the window. */
  catalog: Schema.optionalKey(Schema.String),
  reserve: Schema.Literals(["setting", "default"]),
  target: Schema.Literals(["setting", "default"]),
  /** The model whose settings change them; null without one. */
  model: Schema.NullOr(Schema.Struct({ connectionId: Schema.String, modelId: Schema.String }))
})
export type BudgetOrigins = typeof BudgetOrigins.Type

/**
 * The preset the next request uses and the level of the scope chain it comes from
 * (DATA-MODEL §5.4): the chat's role binding, the chat's own, the connection's override, the
 * user's default, or ST's built-in default.
 */
export const EffectivePreset = Schema.Struct({
  /** Null for ST's built-in default. */
  ref: Schema.NullOr(Schema.String),
  name: Schema.String,
  scope: Schema.Literals(["role", "chat", "connection", "user", "builtin"])
})
export type EffectivePreset = typeof EffectivePreset.Type

/**
 * The model the next request uses and where the choice comes from: the chat's binding or the
 * user's default. Names are null when the connection or the model is gone; a hidden model is
 * still used, only left out of the lists to choose from.
 */
const EffectiveModel = Schema.Struct({
  connection: Schema.String,
  model: Schema.String,
  connectionName: Schema.NullOr(Schema.String),
  modelKey: Schema.NullOr(Schema.String),
  hidden: Schema.Boolean,
  scope: Schema.Literals(["chat", "user"]),
  /**
   * Whether the model takes the start of its reply (a prefill), as its capabilities say:
   * Resolved independently of whether the context can be assembled.
   */
  prefill: Schema.optionalKey(Schema.Literals(["none", "assistant", "tool_schema"])),
  continueUnavailable: Schema.optionalKey(Schema.String),
  vision: Schema.optionalKey(Schema.Boolean),
  maxImages: Schema.optionalKey(Schema.Int)
})

export const SummaryFill = Schema.Struct({
  prompts: Schema.Array(Schema.String),
  kind: Schema.Literals(["notes", "none"]),
  count: Schema.Int,
  tokens: Schema.Int,
  titles: Schema.Array(Schema.String)
})
export type SummaryFill = typeof SummaryFill.Type

/** A note that replaces a prompt or card field in the open chat, as the editors show it. */
export const NoteReplacementView = Schema.Struct({
  note: RefId,
  title: Schema.String,
  /** The card whose note it is; null for the chat's own. */
  card: Schema.NullOr(Schema.String),
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("preset_prompt"), identifier: Schema.String }),
    Schema.Struct({
      kind: Schema.Literal("card_field"),
      card: Schema.String,
      field: Schema.Literals(REPLACEABLE_CARD_FIELDS)
    })
  ]),
  ownPosition: Schema.Boolean,
  status: Schema.Literals(["replaced", "own_position", "not_due", "forbidden", "missing", "disabled", "conflict"])
})
export type NoteReplacementView = typeof NoteReplacementView.Type

export const PresetContext = Schema.Struct({
  blocks: Schema.Array(
    Schema.Struct({ identifier: Schema.String, tokens: Schema.Int, labels: Schema.Array(Schema.String) })
  ),
  cacheAfter: Schema.Array(Schema.Struct({ identifier: Schema.String, reason: BreakpointReason })),
  /**
   * The speaker's card prompts at `main` and `jailbreak` (DESIGN §5.0): used in place of the
   * prompt, or kept out because it forbids them, is off, or the preset has none.
   */
  overrides: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        identifier: Schema.Literals(["main", "jailbreak"]),
        card: Schema.String,
        name: Schema.String,
        status: Schema.Literals(["replaced", "forbidden", "disabled", "missing"])
      })
    )
  ),
  notes: Schema.Array(
    Schema.Struct({ ref: RefId, title: Schema.String, placement: Placement, due: Schema.optionalKey(Schema.Boolean) })
  ),
  /**
   * The notes on in this chat that replace a preset prompt or card field (DESIGN §4.2), and what
   * became of each (`NoteReplacement` in the assembler): a card field's `card` is the card that
   * fills the character's place on the branch. Absent when none does.
   */
  replacements: Schema.optionalKey(Schema.Array(NoteReplacementView)),
  /**
   * What `{{summary}}` fills in for this chat (DESIGN §8 [P]): the prompts of the preset that hold
   * it, and the summaries when summarization is on and has some, else the switched-on summary notes.
   */
  summary: Schema.optionalKey(SummaryFill)
})
export type PresetContext = typeof PresetContext.Type

/** The next request's images, summed (counted in the budget and the cache estimate). */
const NextImages = Schema.Struct({
  count: Schema.Int,
  tokens: Schema.Int,
  /** Images whose cost nothing states yet: budgeted at a bound or a reserve. */
  unknown: Schema.Int,
  bases: Schema.Array(ImageTokenBasis)
})
/**
 * An image of the path that the request leaves out, and why, as the assembler's registered
 * `images` stage (or a plugin's stage after it) decided (ARCHITECTURE §15).
 */
export const ImageLeftOut = Schema.Struct({
  slotId: SlotId,
  versionId: VersionId,
  mediaId: Schema.String,
  depth: Schema.Int,
  /** Its place among its message's images, from 0. */
  index: Schema.Int,
  /**
   * The rule: `user` (taken out by the user), `hidden` (its message isn't sent), `history` (its
   * message doesn't fit), `vision`, `limit` (the last-N limit), or a plugin's `<plugin>/<rule>`.
   */
  rule: Schema.String,
  /** Why, for the user: "Only the last 4 images are sent to this model". */
  message: Schema.String
})
export type ImageLeftOut = typeof ImageLeftOut.Type

/** The images a request leaves out: each one it read, and depth ranges of messages it never read. */
export const ImagesLeftOut = Schema.Struct({
  images: Schema.Array(ImageLeftOut),
  /** Every image of a message at a depth from `from` to `to` (inclusive): summarized, or too far back. */
  ranges: Schema.Array(Schema.Struct({ from: Schema.Int, to: Schema.Int, rule: Schema.String, message: Schema.String }))
})
export type ImagesLeftOut = typeof ImagesLeftOut.Type

/** The next request boundary, also available before a first send or without a cache TTL. */
export const NextContext = Schema.Struct({
  /** Why the next request cannot be assembled; cleared after a successful estimate. */
  assemblyError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The kind of that failure (`budget`: the fixed part and the reply don't fit), for its actions. */
  assemblyErrorReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The next request's images, when it has any. */
  imageTokens: Schema.optionalKey(NextImages),
  /** Which fork the estimate describes, including when two forks share a tip. */
  forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
  presetContext: Schema.optionalKey(Schema.NullOr(PresetContext)),
  /** Null when neither the chat nor the user's defaults name a model. */
  model: Schema.optionalKey(Schema.NullOr(EffectiveModel)),
  preset: Schema.optionalKey(Schema.NullOr(EffectivePreset)),
  budget: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        ...ContextBudget.fields,
        presetName: Schema.String,
        builtinPreset: Schema.Boolean,
        origins: Schema.optionalKey(BudgetOrigins)
      })
    )
  ),
  warmth: Schema.NullOr(CacheWarmth),
  leafSlotId: Schema.NullOr(Schema.String),
  historyStart: Schema.NullOr(Schema.Struct({ slotId: Schema.NullOr(Schema.String), depth: Schema.Int })),
  summarizedThrough: Schema.NullOr(Schema.Int),
  /** The images the next request leaves out and why; absent when it can't be assembled. */
  images: Schema.optionalKey(ImagesLeftOut)
})
export type NextContext = typeof NextContext.Type

/**
 * The request a chat not sent yet would make first (DESIGN §2.1), as the inspector shows a
 * reply's: mapped for the model's API, never captured from a provider, since nothing is sent.
 */
export const DraftRequest = Schema.Struct({
  builtAt: Schema.Number,
  type: Schema.Literals(["normal", "swipe", "impersonate", "continue", "quiet"]),
  mode: Schema.Literals(["st", "layouts"]),
  tokenizer: Schema.optionalKey(TokenizerInfo),
  ...ContextDisplay.fields
})
export type DraftRequest = typeof DraftRequest.Type

/** A chat not sent yet: its first request's size and budget, and the request; null when it can't be built. */
export const DraftChatPreview = Schema.Struct({
  ...NextContext.fields,
  request: Schema.NullOr(DraftRequest)
})
export type DraftChatPreview = typeof DraftChatPreview.Type

/** Versions one metrics read takes. */
export const MAX_METRICS_VERSIONS = 200

export class InspectorApi extends RpcGroup.make(
  /** The context a version was generated from, as sent; NotFound without one. */
  Rpc.make("GetRunContext", {
    payload: { versionId: VersionId },
    success: RunContext,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Generation time and tokens of these versions; versions without any, or not the caller's, are left out. */
  Rpc.make("GetVersionMetrics", {
    payload: { versionIds: Schema.Array(VersionId).check(Schema.isMaxLength(MAX_METRICS_VERSIONS)) },
    success: Schema.Array(VersionMetrics),
    error: ServerError
  })
) {}

/** A chat not sent yet's first request; its own group, served by its own handler layer (api.ts). */
export class DraftPreviewApi extends RpcGroup.make(
  /**
   * The first request of a chat not sent yet (DESIGN §2.1), from what `StartChat` would take:
   * built by the same assembler, counted with local tokenizers. Nothing is written, nothing is
   * sent to a provider, and no remote token count runs. `replier`: who answers a sent message,
   * as the Generate after the send names them.
   */
  Rpc.make("PreviewChat", {
    payload: { ...StartChatInput, replier: Schema.optionalKey(Schema.NullOr(EntityId)) },
    success: DraftChatPreview,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
