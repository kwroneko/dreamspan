import { Placement } from "./docs/note.ts"
// The request inspector and the cache-warmth estimate (DESIGN §5.5, §7.4), merged into AppApi.
import { SelectiveLogic } from "./docs/lorebook.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, ContextIssue, ForkId, SlotId, VersionId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"
import { LlmRequestId, RequestStatus, UsageSource } from "./usage.ts"

/** Historical activation decisions; keyword text is scrubbed with the sent request. */
export const SourceActivation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lorebook"),
    status: Schema.Literal("activated"),
    step: Schema.Int,
    why: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("constant") }),
      /** Kept from an earlier turn while the history's start holds (DESIGN §1.3). */
      Schema.Struct({ kind: Schema.Literal("pinned") }),
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
  ref: Schema.optionalKey(Schema.String)
})
export type ContextSource = typeof ContextSource.Type

/** Why a cache breakpoint follows a message: the end of the preset's prefix, or of the stable history. */
const BreakpointReason = Schema.Literals(["prefix", "summary", "history", "pinned"])

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
  /** The assembler's estimate: a token per four characters, plus three per message. */
  tokens: Schema.Int,
  sources: Schema.Array(ContextSource),
  /**
   * Where each source's text sits in `content`: character offsets, in order, not overlapping, with
   * `source` an index into `sources`. Text between parts is the assembler's joins and wrappers.
   * Absent in captures from before parts were recorded.
   */
  parts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        start: Schema.Int,
        end: Schema.Int,
        source: Schema.Int,
        /** A wrapper its block's owner added, such as a card join prefix: framing, not content. */
        frame: Schema.optionalKey(Schema.Literal(true))
      })
    )
  ),
  /**
   * The labelled blocks around the parts (a card's wrapped field, the characters' definitions, a
   * preset prompt that read cards through a macro, a lorebook block), same offsets, nested ones
   * inside their outer ones; text in a group outside its parts is its framing. Absent in older
   * captures and when no part sits in a block.
   */
  groups: Schema.optionalKey(Schema.Array(Schema.Struct({ start: Schema.Int, end: Schema.Int, source: Schema.Int }))),
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
  usageSource: UsageSource
})
export type RequestFigures = typeof RequestFigures.Type

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
  /** Sum of the ended requests' streaming time (first token to end), for tokens/second; null without any. */
  streamingMs: Schema.NullOr(Schema.Number),
  /** Output tokens of the ended requests that have a count; reasoning tokens are part of them. */
  output: Schema.Int,
  reasoning: Schema.NullOr(Schema.Int),
  /** Ended requests without an output count: `output` leaves them out. */
  outputUnknown: Schema.Int,
  /** Some count is the app's estimate, not the provider's. */
  estimated: Schema.Boolean,
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
    streamingMs: sum(ended.flatMap((r) => (r.firstTokenAt === null ? [] : [r.endedAt! - r.firstTokenAt]))),
    output: counted.reduce((total, r) => total + r.output!, 0),
    reasoning: sum(ended.flatMap((r) => (r.reasoning === null ? [] : [r.reasoning]))),
    outputUnknown: ended.length - counted.length,
    estimated: counted.some((r) => r.usageSource === "estimated"),
    last
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

/** One generation's request as it was sent, and what the provider reported for it. */
export class RunContext extends Schema.Class<RunContext>("RunContext")({
  chatId: ChatId,
  slotId: SlotId,
  versionId: VersionId,
  builtAt: Schema.Number,
  /** The rollout's status: running, completed, stopped, failed, interrupted. */
  status: Schema.String,
  type: Schema.Literals(["normal", "swipe", "impersonate", "continue", "quiet"]),
  mode: Schema.Literals(["st", "layouts"]),
  capture: Schema.Literals(["captured", "unavailable"]),
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
  lastRequestAt: Schema.Number,
  ttlS: Schema.NullOr(Schema.Int),
  /** Historical expiry, independent of the next model's eligibility and TTL. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** The provider reported reading or writing its cache on that request. */
  verified: Schema.Boolean,
  /** The last request's tokens up to its last breakpoint: what a warm cache holds. */
  prefixTokens: Schema.Int,
  /** First difference in the mapped prefix, and the next prefix's uncached suffix tokens. */
  changed: Schema.NullOr(Schema.Struct({ reason: Schema.String, tokens: Schema.Int }))
})
export type CacheWarmth = typeof CacheWarmth.Type

/** Estimated budget for the next context, with raw history excluded from its fixed cost. */
export const ContextBudget = Schema.Struct({
  /** Effective context window and stepped target, both including the response reserve. */
  maximum: Schema.Int,
  target: Schema.Int,
  responseReserve: Schema.Int,
  /** Estimated tokens for fixed content, examples, summaries and framing, excluding raw history. */
  nonHistoryTokens: Schema.Int
})
export type ContextBudget = typeof ContextBudget.Type

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
    Schema.Struct({ title: Schema.String, placement: Placement, due: Schema.optionalKey(Schema.Boolean) })
  ),
  /**
   * What `{{summary}}` fills in for this chat (DESIGN §8 [P]): the prompts of the preset that hold
   * it, and the summaries when summarization is on and has some, else the switched-on summary notes.
   */
  summary: Schema.optionalKey(SummaryFill)
})
export type PresetContext = typeof PresetContext.Type

/** The next request boundary, also available before a first send or without a cache TTL. */
export const NextContext = Schema.Struct({
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
        builtinPreset: Schema.Boolean
      })
    )
  ),
  warmth: Schema.NullOr(CacheWarmth),
  leafSlotId: Schema.NullOr(Schema.String),
  historyStart: Schema.NullOr(Schema.Struct({ slotId: Schema.NullOr(Schema.String), depth: Schema.Int })),
  summarizedThrough: Schema.NullOr(Schema.Int)
})
export type NextContext = typeof NextContext.Type

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
