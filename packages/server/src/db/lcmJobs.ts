import { ChatId, SlotId } from "@rp/shared/chat.ts"
import { UserId } from "@rp/shared/domain.ts"
import { SummaryId, SummaryInput } from "@rp/shared/lcm.ts"
import { ModelChoice } from "@rp/shared/lcmSettings.ts"
import { Schema } from "effect"

export const SummaryJob = Schema.Struct({
  id: Schema.String,
  chatId: ChatId,
  userId: UserId,
  firstSlotId: SlotId,
  lastSlotId: SlotId,
  leafSlotId: SlotId,
  clipTokens: Schema.Int,
  epoch: Schema.Int,
  level: Schema.Int,
  target: Schema.Int,
  attempts: Schema.Int,
  requestClass: Schema.Literals(["interactive", "idle", "background"]),
  /** The model chosen for this job (Retry with…, or the fallback), as JSON; null follows the chat's bindings. */
  modelJson: Schema.NullOr(Schema.String),
  fallbackUsed: Schema.Int,
  maxRetries: Schema.Int,
  batchId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "processing", "complete", "failed"])
})
export type SummaryJob = typeof SummaryJob.Type
export const SummaryChunk = Schema.Struct({
  inputs: Schema.Array(SummaryInput),
  target: Schema.Int,
  clipTokens: Schema.optionalKey(Schema.Int),
  /** Writes a stale summary's range again: an overlapping completed range does not make it redundant. */
  refresh: Schema.optionalKey(Schema.Boolean),
  /** Rerun requests this chunk answers; the enqueue withdraws them, whether it makes the job or finds one. */
  rerunIds: Schema.optionalKey(Schema.Array(Schema.String)),
  explicitRequested: Schema.optionalKey(Schema.Boolean),
  sourceSummaryId: Schema.optionalKey(SummaryId),
  sourceRevisionId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(ModelChoice)
})
/** A condensation to enqueue: its parts in order, the level it makes, and the parent it absorbs into, if any. */
export const PlannedJob = Schema.Struct({
  level: Schema.Int,
  children: Schema.Array(SummaryId),
  target: Schema.Int,
  eager: Schema.Boolean,
  absorbedParentId: Schema.optionalKey(SummaryId),
  rerunIds: Schema.optionalKey(Schema.Array(Schema.String)),
  explicitRequested: Schema.optionalKey(Schema.Boolean),
  sourceSummaryId: Schema.optionalKey(SummaryId),
  sourceRevisionId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(ModelChoice)
})
export type PlannedJob = typeof PlannedJob.Type
export const SummaryPlan = Schema.Struct({
  chunks: Schema.Array(SummaryChunk),
  maintenancePins: Schema.optionalKey(Schema.String),
  /** Stale level-1 summaries to write again, as chunks; only a reply plans them. */
  refresh: Schema.Array(SummaryChunk),
  condensations: Schema.Array(PlannedJob),
  /** Used summaries that are stale but left to the user: hand-written, or built over one. */
  flagged: Schema.Array(SummaryId),
  enabled: Schema.Boolean,
  over: Schema.Boolean,
  partialBatch: Schema.Boolean,
  windowMax: Schema.Int,
  jobs: Schema.Array(SummaryJob),
  spendAhead: Schema.Boolean,
  /** Why nothing is planned although LCM is on: no model is chosen to summarize with. */
  blocked: Schema.NullOr(Schema.Literal("no_model")),
  /** Jobs pending or processing on the path being planned, whatever their range. */
  liveJobs: Schema.Int,
  /**
   * The chat's live backfill (spec/LCM.md §2.11): `armed` until a reply or "Summarize now" begins
   * it, `held` while it is paused or at its cap, `drive` once the user asked to go on at once, and
   * `settled` when this pass found nothing more to plan and nothing live.
   */
  backfill: Schema.NullOr(
    Schema.Struct({ armed: Schema.Boolean, held: Schema.Boolean, drive: Schema.Boolean, settled: Schema.Boolean })
  )
})
// Storage permits a missing planning leaf; the range endpoint is always an
// owned slot and gives such a job a valid path for its completion pass.
export const jobColumns = `j.id, j.chat_id AS chatId, c.owner_user_id AS userId,
 j.first_slot_id AS firstSlotId, j.last_slot_id AS lastSlotId, coalesce(j.leaf_slot_id, j.last_slot_id) AS leafSlotId,
 j.clip_tokens AS clipTokens, j.claim_epoch AS epoch, j.level, j.target_token_count AS target, j.attempts, j.request_class AS requestClass,
 j.model_json AS modelJson, j.fallback_used AS fallbackUsed, j.max_retries AS maxRetries,
 j.batch_id AS batchId, j.status`
