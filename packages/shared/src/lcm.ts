import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, SlotId, VersionId } from "./chat.ts"
import { TextTooLong } from "./composerApi.ts"
import { Draft, DraftRestore, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { idSchema } from "./id.ts"
import { ModelChoice } from "./lcmSettings.ts"
import { ConnectionId, ModelId } from "./providers.ts"

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

/**
 * What summarizing a chat's older history will take, by the formula in spec/LCM.md §2.11:
 * counts of what is sent and returned. The money comes from the summarizer's cost formulas,
 * which only the main thread has (`BackfillEstimate`).
 */
export const BackfillCounts = Schema.Struct({
  plannedRequests: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ uncachedInput: Schema.Int, cachedInput: Schema.Int, cacheWrite: Schema.Int, output: Schema.Int })
    )
  ),
  /** Messages and estimated tokens before the window that no summary covers yet. */
  messages: Schema.Int,
  tokens: Schema.Int,
  /** Level-1 summaries and the condensations over them that the work comes to. */
  l1Jobs: Schema.Int,
  condensations: Schema.Int,
  uncachedInput: Schema.Int,
  cachedInput: Schema.Int,
  cacheWrite: Schema.Int,
  output: Schema.Int,
  /** The model has a cache lifetime, so the preset and the summaries so far are counted as cache reads. */
  cached: Schema.Boolean,
  /** The summarizer's model; null when none is chosen, and then nothing can be summarized. */
  model: Schema.NullOr(
    Schema.Struct({ connection: ConnectionId, model: ModelId, name: Schema.String, sharesCache: Schema.Boolean })
  ),
  /** Why nothing can be summarized: no model, or a context too small for two chunks between the window's ends. */
  blocked: Schema.NullOr(Schema.Literals(["no_model", "runway"])),
  /** From the model's recent output speed; null without a history of requests. */
  seconds: Schema.NullOr(Schema.Int)
})
export type BackfillCounts = typeof BackfillCounts.Type

/** The counts, and what they come to through the user's cost formulas; null when none prices this model. */
export const BackfillEstimate = Schema.Struct({
  ...BackfillCounts.fields,
  cost: Schema.NullOr(Schema.Struct({ amount: Schema.Number, currency: Schema.String }))
})
export type BackfillEstimate = typeof BackfillEstimate.Type

export class LcmEstimateChanged extends Schema.TaggedError<LcmEstimateChanged>()("LcmEstimateChanged", {
  message: Schema.String,
  estimate: BackfillEstimate
}) {}

/** An ST summary the chat can adopt as the first level over the run it covers (DESIGN §8.1). */
const ImportedSummaryOffer = Schema.Struct({
  /** Messages 1 to `to`. */
  to: Schema.Int,
  tokens: Schema.Int,
  /** Of those messages, how many are hidden now; adopting shows them, as the summary stands in. */
  hidden: Schema.Int,
  preview: Schema.String
})

/** What the reader measures for enabling and for the backfill panel: priced on the main thread. */
export const BackfillBasis = Schema.Struct({
  enabled: Schema.Boolean,
  imported: Schema.NullOr(ImportedSummaryOffer),
  /** The work from the first message (or from the summaries' cursor), with the imported run shown. */
  fromScratch: BackfillCounts,
  adopted: Schema.NullOr(BackfillCounts)
})
export type BackfillBasis = typeof BackfillBasis.Type

const BackfillState = Schema.Literals(["waiting", "running", "paused", "capped", "done"])

/** What the writer needs of an estimate to hold the work to it: its billed tokens and money, and its jobs. */
export const BackfillApproval = Schema.Struct({
  jobs: Schema.Int,
  tokens: Schema.Int,
  cost: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String)
})
export type BackfillApproval = typeof BackfillApproval.Type

/** A chat's backfill as stored, with what the ledger shows spent against it. */
export const BackfillStatus = Schema.Struct({
  state: BackfillState,
  choice: Schema.Literals(["adopt", "scratch"]),
  startedAt: Schema.Number,
  armed: Schema.Boolean,
  paused: Schema.Boolean,
  capped: Schema.Boolean,
  drive: Schema.Boolean,
  spentTokens: Schema.Int,
  spentCost: Schema.NullOr(Schema.Number),
  capTokens: Schema.Int,
  capCost: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String)
})
export type BackfillStatus = typeof BackfillStatus.Type

/** What the enable dialog shows: the imported summary if one can be adopted, and each choice's estimate. */
export class LcmEnableOffer extends Schema.Class<LcmEnableOffer>("LcmEnableOffer")({
  chatId: ChatId,
  leafSlotId: SlotId,
  enabled: Schema.Boolean,
  imported: Schema.NullOr(ImportedSummaryOffer),
  fromScratch: BackfillEstimate,
  /** What is left after the imported summary stands in for its run; null without an offer. */
  adopted: Schema.NullOr(BackfillEstimate)
}) {}

export const EnableChoice = Schema.Literals(["adopt", "scratch"])
export type EnableChoice = typeof EnableChoice.Type

/**
 * The backfill of a chat that LCM was enabled on (spec/LCM.md §2.11): its state, what was
 * approved and what has been spent against it, and what is left.
 */
export class LcmBackfill extends Schema.Class<LcmBackfill>("LcmBackfill")({
  chatId: ChatId,
  /**
   * waiting: started by the next reply or "Summarize now"; running; paused by the user;
   * capped: spending reached 150% of the estimate and waits for Continue; done.
   */
  state: BackfillState,
  choice: EnableChoice,
  startedAt: Schema.Number,
  /** Billed tokens (input, cache and output) and money the summaries since have used, from the ledger. */
  spentTokens: Schema.Int,
  spentCost: Schema.NullOr(Schema.Number),
  /** Where spending stops until the user continues: 150% of the estimate. */
  capTokens: Schema.Int,
  capCost: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
  /** What is left to do now. */
  remaining: BackfillEstimate
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
  /** What enabling LCM on this chat would do and cost, for the dialog. Reads only. */
  Rpc.make("GetLcmEnableOffer", {
    payload: { chatId: ChatId, leafSlotId: SlotId },
    success: LcmEnableOffer,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Turns LCM on with the user's choice (spec/LCM.md §2.7): `adopt` makes the imported
   * summary the level-1 summary over the run it covers, `scratch` summarizes from the first
   * message. Either way the run is shown again, the imported summary stays in its own note,
   * and nothing is generated until the next reply or "Summarize now".
   */
  Rpc.make("EnableLcm", {
    payload: {
      chatId: ChatId,
      leafSlotId: SlotId,
      choice: EnableChoice,
      approved: Schema.optionalKey(BackfillEstimate)
    },
    /** The backfill it started; null when there was nothing to summarize beyond the window. */
    success: Schema.NullOr(LcmBackfill),
    error: Schema.Union([NotFound, ServerError, LcmEstimateChanged])
  }),
  /** The chat's backfill, if it has one: its state, spending and what is left. */
  Rpc.make("GetLcmBackfill", {
    payload: { chatId: ChatId, leafSlotId: SlotId },
    success: Schema.NullOr(LcmBackfill),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Pause, continue past the spending cap (with a new cap of 150% of what is left), or start
   * now instead of waiting for the next reply. "Summarize now" is the one click that plans.
   */
  Rpc.make("SetLcmBackfill", {
    payload: {
      chatId: ChatId,
      leafSlotId: SlotId,
      action: Schema.Literals(["pause", "continue", "summarizeNow"]),
      approved: Schema.optionalKey(BackfillEstimate)
    },
    success: Schema.NullOr(LcmBackfill),
    error: Schema.Union([NotFound, ServerError, LcmEstimateChanged])
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
