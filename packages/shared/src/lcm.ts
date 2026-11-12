import { ContextDisplay } from "./inspectorApi.ts"
import { LlmRequest } from "./usage.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, ForkId, SlotId, VersionId } from "./chat.ts"
import { TextTooLong } from "./composerApi.ts"
import { ObservedDeletion, Draft, DraftHistoryPolicy, DraftRestore, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { idSchema } from "./id.ts"
import { LcmDefaults, LcmSettings, LcmSettingsChange, LcmWhen, ModelChoice, SummaryPreset } from "./lcmSettings.ts"
import { RefId } from "./library.ts"
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
  rolloutId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  content: Schema.String,
  tokens: Schema.Int,
  origin: Schema.Literals(["generated", "user", "changeset", "imported"]),
  status: Schema.Literals(["complete", "truncated", "superseded", "failed"]),
  error: Schema.NullOr(Schema.String),
  batchId: Schema.NullOr(Schema.String),
  rowVersion: Schema.Int,
  fresh: Schema.Boolean,
  inputs: Schema.Array(SummaryInput),
  children: Schema.Array(SummaryChild),
  /** A separate context's own summary (spec/CHARACTER-CONTEXT.md §2.3): its character's identities. Absent: the whole path. */
  audience: Schema.optionalKey(Schema.Array(Schema.String))
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
  children: Schema.Array(SummaryId),
  /** A separate context's own summary: the identities of the character it was written for. Absent: shared. */
  audience: Schema.optionalKey(Schema.Array(Schema.String))
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
  rerun: Schema.Boolean,
  /** A separate context's own work: its character's identities, as `LcmSummary.audience`. Absent: shared. */
  audience: Schema.optionalKey(Schema.Array(Schema.String))
})
export type LcmJob = typeof LcmJob.Type

/**
 * What stands in for older history on the path to a leaf (DESIGN §8): the layer in use,
 * in path order; failed summaries and jobs on the path; and the cursor, the last message the
 * layer covers: its slot, its position on the fork's display path (spec/MESSAGE-INSERT.md §3.4)
 * and its depth (-1: none). Summaries' and jobs' `from` and `to` are one-based positions.
 */
export class LcmState extends Schema.Class<LcmState>("LcmState")({
  chatId: ChatId,
  leafSlotId: SlotId,
  enabled: Schema.Boolean,
  layer: Schema.Array(LcmSummary),
  failed: Schema.Array(LcmSummary),
  jobs: Schema.Array(LcmJob),
  cursorDepth: Schema.Int,
  cursorSlotId: Schema.optionalKey(Schema.NullOr(SlotId)),
  /** The cursor's position on the display path; its depth in a fork without insertions. */
  cursorPosition: Schema.optionalKey(Schema.Int)
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
  selected: Schema.Boolean,
  rolloutId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  requests: Schema.optionalKey(Schema.Array(LlmRequest))
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
  seconds: Schema.NullOr(Schema.Int),
  /**
   * In a chat set to separate contexts, the characters that get summaries of their own (each
   * missed something), with the part of the totals above that is theirs: the messages they knew
   * after they diverged, and the requests those come to. The shared pass is the rest.
   */
  views: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ entity: EntityId, messages: Schema.Int, l1Jobs: Schema.Int, condensations: Schema.Int })
    )
  )
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

const Source = Schema.Literals(["chat", "account", "builtin"])
const Pair = Schema.Struct({ target: Schema.Int, maximum: Schema.Int, clamped: Schema.Boolean })

/** A chat's summarization settings (DESIGN §8): what it stores, what applies, and how that fits the model. */
export const LcmSettingsView = Schema.Struct({
  /** The chat's own `lcm.settings`; null for a chat from before they existed. */
  stored: Schema.NullOr(LcmSettings),
  /** What applies, each field from the chat, the account default or the built-in. */
  resolved: Schema.Struct({
    enabled: Schema.Boolean,
    withPreset: SummaryPreset,
    preset: Schema.NullOr(RefId),
    withNotes: Schema.Boolean,
    tail: Schema.NullOr(Schema.String),
    recentTarget: Schema.Int,
    recentMax: Schema.Int,
    layerTarget: Schema.Int,
    layerMax: Schema.Int,
    when: LcmWhen,
    style: Schema.String,
    leafInput: Schema.NullOr(Schema.Int),
    leafTarget: Schema.Int,
    from: Schema.Record(Schema.String, Source)
  }),
  /** The account default, for "Reset to account default". */
  account: Schema.NullOr(LcmDefaults),
  /** The pairs as assembly uses them, scaled to what the model leaves, and the chunk; null without a model. */
  fitted: Schema.NullOr(Schema.Struct({ recent: Pair, layer: Pair, chunk: Schema.Int })),
  /** The model's room: its context, the fixed part (preset, cards, notes) and the reply reserve. */
  room: Schema.NullOr(Schema.Struct({ context: Schema.Int, fixed: Schema.Int, reply: Schema.Int })),
  /** The current figures of the next context: recent messages kept as written and the summary block. */
  now: Schema.NullOr(Schema.Struct({ recent: Schema.Int, layer: Schema.Int })),
  /** One sentence per setting that doesn't fit, under the field it is about. */
  fit: Schema.Array(
    Schema.Struct({
      field: Schema.Literals(["recentMax", "recentTarget", "layerMax", "layerTarget", "leafInput"]),
      message: Schema.String
    })
  )
})
export type LcmSettingsView = typeof LcmSettingsView.Type

/** A change would leave a target at or above its maximum in the chat's own settings. */
export class LcmSettingsInvalid extends Schema.TaggedError<LcmSettingsInvalid>()("LcmSettingsInvalid", {
  message: Schema.String
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
  adopted: Schema.NullOr(BackfillCounts),
  /** The chat's imported summary notes switched on at the leaf: enabling switches them off in the same write. */
  summaryNotesOn: Schema.optionalKey(Schema.Array(EntityId))
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
  adopted: Schema.NullOr(BackfillEstimate),
  /** The imported summary note is switched on: enabling switches it off (DESIGN §8 [P], Q4). */
  summaryNoteOn: Schema.optionalKey(Schema.Boolean)
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

/**
 * Text typed into a summary's edit: the draft it was typed into as the client last had it,
 * and the text now. Also what a browser copy replays (`summaries` in `POST /library/drafts`).
 */
export const SummaryDraftSave = Schema.Struct({
  forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
  summaryId: SummaryId,
  observedDeletion: Schema.optionalKey(ObservedDeletion),
  draftId: Schema.NullOr(Schema.String),
  content: Schema.String,
  expectedRowVersion: Schema.NullOr(Schema.Int),
  expectedSession: Schema.NullOr(Schema.Int),
  /** The revision the text started from. */
  baseRevisionId: Schema.NullOr(SummaryRevisionId)
})
export class SummaryAttempt extends Schema.Class<SummaryAttempt>("SummaryAttempt")({
  rolloutId: Schema.String,
  request: Schema.NullOr(ContextDisplay),
  requests: Schema.Array(LlmRequest),
  responses: Schema.Array(Schema.Struct({ requestId: Schema.String, response: Schema.String }))
}) {}

/** Stored provenance of the generation, even when the selected text was edited later. */
export class SummaryDetails extends Schema.Class<SummaryDetails>("SummaryDetails")({
  chatId: ChatId,
  forkId: Schema.NullOr(ForkId),
  jobId: Schema.NullOr(Schema.String),
  attempts: Schema.NullOr(Schema.Int),
  /** How many summaries it condenses; 0 at level 1. Its Details say "Condensing 5 summaries". */
  parts: Schema.Int,
  model: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  requests: Schema.Array(LlmRequest),
  request: Schema.NullOr(ContextDisplay),
  generations: Schema.optionalKey(Schema.Array(SummaryAttempt))
}) {}

export class SummaryRequestApi extends RpcGroup.make(
  Rpc.make("GetSummaryRevisionRequest", {
    payload: { revisionId: SummaryRevisionId },
    success: SummaryDetails,
    error: Schema.Union([NotFound, ServerError])
  })
) {}

export class LcmApi extends RpcGroup.make(
  Rpc.make("GetSummaryDetails", {
    payload: { summaryId: SummaryId },
    success: SummaryDetails,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("GetSummary", {
    payload: { forkId: Schema.optionalKey(Schema.NullOr(ForkId)), summaryId: SummaryId },
    success: Summary,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("EditSummary", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      summaryId: SummaryId,
      content: Schema.String,
      expectedRowVersion: Schema.Int,
      commitDraft: Schema.NullOr(Schema.Struct({ draftId: Schema.String, session: Schema.Int }))
    },
    success: SummaryChange,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  Rpc.make("SelectSummaryRevision", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      summaryId: SummaryId,
      revisionId: SummaryRevisionId,
      expectedRowVersion: Schema.Int
    },
    success: Summary,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  Rpc.make("GetLcmState", {
    payload: {
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      leafSlotId: SlotId,
      /** A character whose separate context to read: the shared summaries and its own (unit C7). */
      viewer: Schema.optionalKey(EntityId)
    },
    success: LcmState,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Summaries overlapping message positions `fromPosition`..`toPosition` on the fork's display
   * path, outermost levels included. Without them, `fromDepth`..`toDepth` are read as positions
   * (the same numbers in a fork without insertions).
   */
  Rpc.make("GetLcmCoverage", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      chatId: ChatId,
      leafSlotId: SlotId,
      includeResolved: Schema.optionalKey(Schema.Boolean),
      fromDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      toDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      fromPosition: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      toPosition: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      /** As GetLcmState's. */
      viewer: Schema.optionalKey(EntityId)
    },
    success: LcmCoverage,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("ListSummaryRevisions", {
    payload: { forkId: Schema.optionalKey(Schema.NullOr(ForkId)), summaryId: SummaryId },
    success: Schema.Array(SummaryRevision),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Asks for a summary to be made again with the next reply, or takes the ask back. Nothing
   * is generated now: the request waits for the planner, which no click ever runs.
   */
  Rpc.make("SetSummaryRerun", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      chatId: ChatId,
      target: RerunTarget,
      requested: Schema.Boolean,
      /** Optional rerun model override; otherwise the chat's summarizer. */
      model: Schema.optionalKey(ModelChoice)
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** What enabling LCM on this chat would do and cost, for the dialog. Reads only. */
  Rpc.make("GetLcmEnableOffer", {
    payload: { chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), leafSlotId: SlotId },
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
    payload: { forkId: Schema.optionalKey(Schema.NullOr(ForkId)), chatId: ChatId, leafSlotId: SlotId },
    success: Schema.NullOr(LcmBackfill),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Pause, continue past the spending cap (with a new cap of 150% of what is left), or start
   * now instead of waiting for the next reply. "Summarize now" is the one click that plans.
   */
  Rpc.make("SetLcmBackfill", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      chatId: ChatId,
      leafSlotId: SlotId,
      action: Schema.Literals(["pause", "continue", "summarizeNow"]),
      approved: Schema.optionalKey(BackfillEstimate)
    },
    success: Schema.NullOr(LcmBackfill),
    error: Schema.Union([NotFound, ServerError, LcmEstimateChanged])
  }),
  /** The chat's summarization settings, at the leaf whose next context they are measured against. */
  Rpc.make("GetLcmSettings", {
    payload: { chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), leafSlotId: Schema.NullOr(SlotId) },
    success: LcmSettingsView,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Changes the chat's settings, the others kept; null makes a field follow the account default
   * again. Turning summarizing on for a chat with messages goes through `EnableLcm`.
   */
  Rpc.make("ChangeLcmSettings", {
    payload: { chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), change: LcmSettingsChange },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError, LcmSettingsInvalid])
  }),
  /** Turns LCM on or off for the whole chat; it keeps its other settings. `ChangeLcmSettings` with `enabled` only. */
  Rpc.make("SetLcmEnabled", {
    payload: { chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), enabled: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  // --- The edit of a summary goes through a draft like any text field (ARCHITECTURE §3.10).
  Rpc.make("GetSummaryDraft", {
    payload: { forkId: Schema.optionalKey(Schema.NullOr(ForkId)), summaryId: SummaryId },
    success: Schema.NullOr(Draft),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("SaveSummaryDraft", {
    payload: SummaryDraftSave.fields,
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, TextTooLong, ServerError])
  }),
  Rpc.make("SummaryDraftHistory", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      summaryId: SummaryId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DraftHistoryPolicy.maxEntries + 1 })),
      /** Pages on to the states before this seq: an edit's history outlives its saves (owner, 2026-11-02). */
      before: Schema.optionalKey(Schema.Int)
    },
    success: Schema.Array(DraftState),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("RestoreSummaryDraft", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      summaryId: SummaryId,
      draftId: Schema.String,
      ...DraftRestore
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /** Ends the edit unsaved: the draft goes back to the saved text as a state of its history, the text cancelled one step back. */
  Rpc.make("DiscardSummaryDraft", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      summaryId: SummaryId,
      draftId: Schema.String,
      expectedRowVersion: Schema.Int
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  })
) {}
