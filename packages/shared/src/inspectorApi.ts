// The request inspector and the cache-warmth estimate (DESIGN §5.5, §7.4), merged into AppApi.
import { SelectiveLogic } from "./docs/lorebook.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, ContextIssue, SlotId, VersionId } from "./chat.ts"
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
      Schema.Struct({
        kind: Schema.Literal("keys"),
        primaryKey: Schema.String,
        secondaryKeys: Schema.Array(Schema.String),
        logic: Schema.optionalKey(SelectiveLogic)
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
    interval: Schema.NullOr(Schema.Int),
    userMessages: Schema.NullOr(Schema.Int),
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
  kind: Schema.Literals(["preset", "card", "lorebook", "note", "summary", "message", "direction", "assembler"]),
  /** Stable identity from source references and revisions, independent of display text. */
  id: Schema.String,
  label: Schema.String,
  activation: Schema.NullOr(SourceActivation),
  /** A message of the chat, to link to. */
  slotId: Schema.NullOr(SlotId)
})
export type ContextSource = typeof ContextSource.Type

/** Why a cache breakpoint follows a message: the end of the preset's prefix, or of the stable history. */
const BreakpointReason = Schema.Literals(["prefix", "summary", "history"])

export const ContextMessage = Schema.Struct({
  role: Schema.Literals(["system", "developer", "user", "assistant", "model"]),
  name: Schema.NullOr(Schema.String),
  content: Schema.String,
  /** The assembler's estimate: a token per four characters, plus three per message. */
  tokens: Schema.Int,
  sources: Schema.Array(ContextSource),
  breakpoint: Schema.NullOr(BreakpointReason)
})
export type ContextMessage = typeof ContextMessage.Type

/** Only the usage fields the inspector displays; provider metadata never crosses this boundary. */
export const InspectorUsage = Schema.Struct({
  id: LlmRequestId,
  status: RequestStatus,
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
  issues: Schema.Array(ContextIssue)
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
  type: Schema.Literals(["normal", "swipe", "impersonate", "quiet"]),
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

/** The next request boundary, also available before a first send or without a cache TTL. */
export const NextContext = Schema.Struct({
  warmth: Schema.NullOr(CacheWarmth),
  leafSlotId: Schema.NullOr(Schema.String),
  historyStart: Schema.NullOr(Schema.Struct({ slotId: Schema.NullOr(Schema.String), depth: Schema.Int }))
})
export type NextContext = typeof NextContext.Type

export class InspectorApi extends RpcGroup.make(
  /** The context a version was generated from, as sent; NotFound without one. */
  Rpc.make("GetRunContext", {
    payload: { versionId: VersionId },
    success: RunContext,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
