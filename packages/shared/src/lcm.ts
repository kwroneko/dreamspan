import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, SlotId, VersionId } from "./chat.ts"
import { TextTooLong } from "./composerApi.ts"
import { Draft, DraftRestore, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { idSchema } from "./id.ts"
import { ModelChoice } from "./lcmSettings.ts"

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
const SummaryStatus = Schema.Literals(["complete", "truncated", "superseded", "failed"])
const SummaryOrigin = Schema.Literals(["generated", "user", "changeset", "imported"])

/**
 * A summary as the UI lists it: where it sits (`from`..`to` are message numbers on the
 * path, one-based), its state, and whether the user asked for it to be done again with the
 * next reply. `content` is null in coverage reads, which only draw bars.
 */
export const LcmSummary = Schema.Struct({
  id: SummaryId,
  level: Schema.Int,
  firstSlotId: SlotId,
  lastSlotId: SlotId,
  from: Schema.Int,
  to: Schema.Int,
  slotCount: Schema.Int,
  status: SummaryStatus,
  error: Schema.NullOr(Schema.String),
  fresh: Schema.Boolean,
  tokens: Schema.Int,
  origin: SummaryOrigin,
  revisionNumber: Schema.Int,
  revisionCount: Schema.Int,
  rowVersion: Schema.Int,
  revisionId: SummaryRevisionId,
  /** Asked to be summarized again with the next reply (SetSummaryRerun). */
  rerun: Schema.Boolean,
  replacementAvailable: Schema.optionalKey(Schema.Boolean),
  resolved: Schema.optionalKey(Schema.Boolean),
  content: Schema.NullOr(Schema.String),
  /** The summaries this one condenses, in order; empty at level 1. */
  children: Schema.Array(SummaryId)
})
export type LcmSummary = typeof LcmSummary.Type

/** Work on the path that hasn't produced a summary: queued, running, or given up on. */
export const LcmJob = Schema.Struct({
  id: Schema.String,
  level: Schema.Int,
  from: Schema.Int,
  to: Schema.Int,
  firstSlotId: SlotId,
  status: Schema.Literals(["pending", "processing", "failed"]),
  error: Schema.NullOr(Schema.String),
  /** Asked to be tried again with the next reply (SetSummaryRerun). */
  rerun: Schema.Boolean
})
export type LcmJob = typeof LcmJob.Type

/**
 * What stands in for older history on the path to a leaf (DESIGN §8): the layer in use,
 * in path order; failed summaries and jobs on the path; and the cursor, the depth of the last
 * message the layer covers (-1: none).
 */
export class LcmState extends Schema.Class<LcmState>("LcmState")({
  chatId: ChatId,
  leafSlotId: SlotId,
  enabled: Schema.Boolean,
  layer: Schema.Array(LcmSummary),
  failed: Schema.Array(LcmSummary),
  jobs: Schema.Array(LcmJob),
  cursorDepth: Schema.Int
}) {}

/** Every summary on the path overlapping a range of message depths, for the coverage rail. */
export class LcmCoverage extends Schema.Class<LcmCoverage>("LcmCoverage")({
  leafSlotId: SlotId,
  summaries: Schema.Array(LcmSummary)
}) {}

export const SummaryRevision = Schema.Struct({
  id: SummaryRevisionId,
  number: Schema.Int,
  origin: SummaryOrigin,
  tokens: Schema.Int,
  content: Schema.String,
  createdAt: Schema.Number,
  selected: Schema.Boolean
})
export type SummaryRevision = typeof SummaryRevision.Type

/** What is asked to be done again: a summary (stale, edited, failed) or a job that failed. */
export const RerunTarget = Schema.Union([
  Schema.TaggedStruct("Summary", { summaryId: SummaryId }),
  Schema.TaggedStruct("Job", { jobId: Schema.String })
])
export type RerunTarget = typeof RerunTarget.Type

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
  }),
  Rpc.make("GetLcmState", {
    payload: { chatId: ChatId, leafSlotId: SlotId },
    success: LcmState,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Summaries overlapping message depths `fromDepth`..`toDepth` on the path, outermost levels included. */
  Rpc.make("GetLcmCoverage", {
    payload: {
      chatId: ChatId,
      leafSlotId: SlotId,
      includeResolved: Schema.optionalKey(Schema.Boolean),
      fromDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      toDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    },
    success: LcmCoverage,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("ListSummaryRevisions", {
    payload: { summaryId: SummaryId },
    success: Schema.Array(SummaryRevision),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Asks for a summary to be made again with the next reply, or takes the ask back. Nothing
   * is generated now: the request waits for the planner, which no click ever runs.
   */
  Rpc.make("SetSummaryRerun", {
    payload: {
      chatId: ChatId,
      target: RerunTarget,
      requested: Schema.Boolean,
      /** "Retry with…": the model that does it again; otherwise the chat's summarizer. */
      model: Schema.optionalKey(ModelChoice)
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Turns LCM on or off for the whole chat; it keeps its other settings. */
  Rpc.make("SetLcmEnabled", {
    payload: { chatId: ChatId, enabled: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  // --- The edit of a summary goes through a draft like any text field (ARCHITECTURE §3.10).
  Rpc.make("GetSummaryDraft", {
    payload: { summaryId: SummaryId },
    success: Schema.NullOr(Draft),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("SaveSummaryDraft", {
    payload: {
      summaryId: SummaryId,
      draftId: Schema.NullOr(Schema.String),
      content: Schema.String,
      expectedRowVersion: Schema.NullOr(Schema.Int),
      expectedSession: Schema.NullOr(Schema.Int),
      /** The revision the text started from. */
      baseRevisionId: Schema.NullOr(SummaryRevisionId)
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, TextTooLong, ServerError])
  }),
  Rpc.make("SummaryDraftHistory", {
    payload: { summaryId: SummaryId, limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })) },
    success: Schema.Array(DraftState),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("RestoreSummaryDraft", {
    payload: { summaryId: SummaryId, draftId: Schema.String, ...DraftRestore },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /** Ends the edit unsaved; its text goes to the bin's recovered texts. */
  Rpc.make("DiscardSummaryDraft", {
    payload: { summaryId: SummaryId, draftId: Schema.String, expectedRowVersion: Schema.Int },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  })
) {}
