// The usage ledger (spec/PROVIDERS.md §9): one record per request to a model. Counts are
// null when unknown, never zero.
import { Schema } from "effect"
import { idSchema } from "./id.ts"
import { ChatId, VersionId } from "./chat.ts"
import { ConnectionId, ModelId } from "./providers.ts"

export const LlmRequestId = idSchema("LlmRequestId", "llm_request")
export type LlmRequestId = typeof LlmRequestId.Type

export const RequestPurpose = Schema.Literals([
  "generation",
  "summarize",
  "condense",
  "decision",
  "workshop",
  "idle_job",
  "edit",
  "test"
])
export type RequestPurpose = typeof RequestPurpose.Type

export const RequestStatus = Schema.Literals(["running", "complete", "failed", "aborted", "interrupted"])
export type RequestStatus = typeof RequestStatus.Type

/**
 * Normalized token counts (PROVIDERS §9.2). `inputUncached` is input billed at the base
 * rate; `cacheWriteLong` is the part of `cacheWrite` written with the long TTL;
 * `reasoning` is the part of `output` spent thinking.
 */
export const TokenCounts = Schema.Struct({
  inputUncached: Schema.NullOr(Schema.Int),
  cacheRead: Schema.NullOr(Schema.Int),
  cacheWrite: Schema.NullOr(Schema.Int),
  cacheWriteLong: Schema.NullOr(Schema.Int),
  output: Schema.NullOr(Schema.Int),
  reasoning: Schema.NullOr(Schema.Int)
})
export type TokenCounts = typeof TokenCounts.Type

export const unknownCounts: TokenCounts = {
  inputUncached: null,
  cacheRead: null,
  cacheWrite: null,
  cacheWriteLong: null,
  output: null,
  reasoning: null
}

export const UsageSource = Schema.Literals(["reported", "estimated", "none"])
export type UsageSource = typeof UsageSource.Type

/** A computed cost and what produced it. The currency is only a label. */
export const Cost = Schema.Struct({ amount: Schema.Number, currency: Schema.String, formula: Schema.String })
export type Cost = typeof Cost.Type

/** Follower outcome, proved by reported cache tokens; null means usage was unavailable. */
export const CacheStagger = Schema.Struct({
  leaderRequestId: LlmRequestId,
  release: Schema.Literals(["first-chunk", "complete", "timeout", "leader-ended"]),
  hit: Schema.NullOr(Schema.Boolean)
})

export class LlmRequest extends Schema.Class<LlmRequest>("LlmRequest")({
  id: LlmRequestId,
  connectionId: ConnectionId,
  modelId: Schema.NullOr(ModelId),
  chatId: Schema.NullOr(ChatId),
  versionId: Schema.NullOr(VersionId),
  purpose: RequestPurpose,
  api: Schema.String,
  provider: Schema.String,
  modelKey: Schema.String,
  responseModel: Schema.NullOr(Schema.String),
  upstream: Schema.NullOr(Schema.String),
  status: RequestStatus,
  startedAt: Schema.Number,
  firstTokenAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  cacheStagger: Schema.optionalKey(Schema.NullOr(CacheStagger)),
  counts: TokenCounts,
  usageSource: UsageSource,
  reportedCost: Schema.NullOr(Schema.Number),
  cost: Schema.NullOr(Cost)
}) {}
