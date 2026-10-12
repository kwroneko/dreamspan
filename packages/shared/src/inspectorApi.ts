// The request inspector and the cache-warmth estimate (DESIGN §5.5, §7.4), merged into AppApi.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, ContextIssue, SlotId, VersionId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"
import { LlmRequestId, RequestStatus, UsageSource } from "./usage.ts"

/** Where a piece of a request message came from, named for the user. */
export const ContextSource = Schema.Struct({
  kind: Schema.Literals(["preset", "card", "lorebook", "note", "message", "direction", "assembler"]),
  label: Schema.String,
  /** A message of the chat, to link to. */
  slotId: Schema.NullOr(SlotId)
})
export type ContextSource = typeof ContextSource.Type

/** Why a cache breakpoint follows a message: the end of the preset's prefix, or of the stable history. */
const BreakpointReason = Schema.Literals(["prefix", "history"])

export const ContextMessage = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
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

/** One generation's request as it was sent, and what the provider reported for it. */
export class RunContext extends Schema.Class<RunContext>("RunContext")({
  chatId: ChatId,
  slotId: SlotId,
  versionId: VersionId,
  builtAt: Schema.Number,
  /** The rollout's status: running, completed, stopped, failed, interrupted. */
  status: Schema.String,
  type: Schema.Literals(["normal", "swipe", "impersonate"]),
  mode: Schema.Literals(["st", "layouts"]),
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
  ttlS: Schema.Int,
  /** Historical expiry, independent of the next model's eligibility and TTL. */
  expiresAt: Schema.Number,
  /** The provider reported reading or writing its cache on that request. */
  verified: Schema.Boolean,
  /** The last request's tokens up to its last breakpoint: what a warm cache holds. */
  prefixTokens: Schema.Int,
  /** First difference in the mapped prefix, and the next prefix's uncached suffix tokens. */
  changed: Schema.NullOr(Schema.Struct({ reason: Schema.String, tokens: Schema.Int }))
})
export type CacheWarmth = typeof CacheWarmth.Type

export class InspectorApi extends RpcGroup.make(
  /** The context a version was generated from, as sent; NotFound without one. */
  Rpc.make("GetRunContext", {
    payload: { versionId: VersionId },
    success: RunContext,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
