import { ChatId, SlotId } from "@rp/shared/chat.ts"
import { UserId } from "@rp/shared/domain.ts"
import { SummaryInput } from "@rp/shared/lcm.ts"
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
  batchId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "processing", "complete", "failed"])
})
export type SummaryJob = typeof SummaryJob.Type
export const SummaryChunk = Schema.Struct({
  inputs: Schema.Array(SummaryInput),
  target: Schema.Int,
  clipTokens: Schema.optionalKey(Schema.Int)
})
export const SummaryPlan = Schema.Struct({
  chunks: Schema.Array(SummaryChunk),
  enabled: Schema.Boolean,
  over: Schema.Boolean,
  partialBatch: Schema.Boolean,
  windowMax: Schema.Int,
  jobs: Schema.Array(SummaryJob),
  spendAhead: Schema.Boolean
})
export const jobColumns = `j.id, j.chat_id AS chatId, c.owner_user_id AS userId,
 j.first_slot_id AS firstSlotId, j.last_slot_id AS lastSlotId, j.leaf_slot_id AS leafSlotId,
 j.clip_tokens AS clipTokens, j.claim_epoch AS epoch, j.level, j.target_token_count AS target, j.attempts, j.request_class AS requestClass,
 j.batch_id AS batchId, j.status`
