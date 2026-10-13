import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, SlotId, VersionId } from "./chat.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { idSchema } from "./id.ts"

export const SummaryId = idSchema("SummaryId", "summaries")
export const SummaryRevisionId = idSchema("SummaryRevisionId", "summary_revisions")
export const SummaryInput = Schema.Struct({
  slotId: SlotId,
  versionId: Schema.NullOr(VersionId),
  amendCount: Schema.Int
})
export const SummaryChild = Schema.Struct({ summaryId: SummaryId, revisionId: SummaryRevisionId })
export class Summary extends Schema.Class<Summary>("Summary")({
  id: SummaryId,
  chatId: ChatId,
  level: Schema.Int,
  firstSlotId: SlotId,
  lastSlotId: SlotId,
  from: Schema.Int,
  to: Schema.Int,
  slotCount: Schema.Int,
  revisionNumber: Schema.Int,
  revisionId: SummaryRevisionId,
  content: Schema.String,
  tokens: Schema.Int,
  origin: Schema.Literals(["generated", "user", "changeset", "imported"]),
  status: Schema.Literals(["complete", "truncated", "superseded", "failed"]),
  error: Schema.NullOr(Schema.String),
  batchId: Schema.NullOr(Schema.String),
  rowVersion: Schema.Int,
  fresh: Schema.Boolean,
  inputs: Schema.Array(SummaryInput),
  children: Schema.Array(SummaryChild)
}) {}
export const SummaryChange = Schema.Struct({ summary: Summary, recovered: Schema.Int })
export class LcmApi extends RpcGroup.make(
  Rpc.make("GetSummary", {
    payload: { summaryId: SummaryId },
    success: Summary,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("EditSummary", {
    payload: {
      summaryId: SummaryId,
      content: Schema.String,
      expectedRowVersion: Schema.Int,
      commitDraft: Schema.NullOr(Schema.Struct({ draftId: Schema.String, session: Schema.Int }))
    },
    success: SummaryChange,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  Rpc.make("SelectSummaryRevision", {
    payload: { summaryId: SummaryId, revisionId: SummaryRevisionId, expectedRowVersion: Schema.Int },
    success: Summary,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  })
) {}
