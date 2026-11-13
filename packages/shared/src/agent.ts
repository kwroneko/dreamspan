// What an agent rollout shows of its work (spec/AGENTIC.md §5.1): its steps, live while it runs
// and afterwards from its transcript.
import { Schema } from "effect"
import { StoryAtField } from "./chatPosition.ts"

const EffectClass = Schema.Literals(["read", "chat_state", "external", "library", "setup", "outside"])

/**
 * What a tool call waiting for the user will do, as the server describes it from the call's real
 * arguments and the items they name (spec/WORKSHOP.md §3.4): never the model's own wording of it.
 */
export const ApprovalPrompt = Schema.Struct({
  plugin: Schema.optionalKey(Schema.Struct({ id: Schema.String, commit: Schema.String })),
  storyAt: StoryAtField,
  storyScope: Schema.optionalKey(
    Schema.Struct({
      branch: Schema.Struct({
        name: Schema.NullOr(Schema.String),
        original: Schema.Boolean,
        split: Schema.optional(Schema.NullOr(Schema.Struct({ at: Schema.Number, after: Schema.Number }))),
        createdAt: Schema.optional(Schema.Number)
      }),
      first: Schema.Number,
      last: Schema.Number,
      from: Schema.optionalKey(Schema.Boolean)
    })
  ),
  rolloutId: Schema.String,
  toolCallId: Schema.String,
  /** The arguments' digest: an answer names it, so it holds only for this exact call. */
  digest: Schema.String,
  capability: Schema.String,
  /** The capability's own label: "Create and edit library items". */
  capabilityLabel: Schema.String,
  /** What it will do, in a line: "Create the card “Mara Quill”". */
  title: Schema.String,
  /** The values it will write, as the arguments give them. */
  rows: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  /** An edit's fields as they are and as they would be. */
  changes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ field: Schema.String, before: Schema.String, after: Schema.String }))
  ),
  /** The app stopped while it may have been running: it may already have happened. */
  uncertain: Schema.Boolean
})
export type ApprovalPrompt = typeof ApprovalPrompt.Type

/**
 * A step: thinking or intermediate text from a turn that went on to call a tool, or one tool
 * call with its result. The final turn's reasoning and text are the version's own.
 */
export const RolloutStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["thinking", "text"]), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    /** The call's id in the transcript. */
    id: Schema.String,
    tool: Schema.String,
    /** Short and user-facing: "Searched the chat". */
    label: Schema.String,
    /** What it was called with, in a line: “lighthouse”. */
    title: Schema.String,
    args: Schema.Unknown,
    /** `waiting`: the call asks the user first (`approval` says what it will do). */
    status: Schema.Literals(["running", "waiting", "done", "error"]),
    result: Schema.optionalKey(Schema.String),
    approval: Schema.optionalKey(ApprovalPrompt),
    /** Existing steps render these three display classes. */
    effect: Schema.Literals(["read", "chat_state", "external"]),
    /** The refined execution class, when it differs from the display class. */
    effectClass: Schema.optionalKey(EffectClass)
  })
])

/** A version's steps at a glance, for its header badge: tool calls and how long the run took. */
export type RolloutStep = typeof RolloutStep.Type

export const StepsSummary = Schema.Struct({ count: Schema.Int, ms: Schema.NullOr(Schema.Int) })
export type StepsSummary = typeof StepsSummary.Type

/**
 * Why an agent reply can't be resumed (spec/AGENTIC.md §4.2): it isn't an agent reply, it's
 * still being written or resumed, it finished, or the step named can't be carried on from.
 */
export class NotResumable extends Schema.TaggedError<NotResumable>()("NotResumable", {
  versionId: Schema.String,
  message: Schema.String,
  /**
   * The chat's context can't be built now (a deleted lorebook, say), but the stopped run's own
   * request is still stored: the user may send it unchanged (`ResumeVersion`'s `saved`).
   */
  savedRequest: Schema.optionalKey(Schema.Boolean)
}) {}

/**
 * A step's change before resuming from it (§4.4): new text for a thinking or text step, new
 * arguments for a tool call (it runs again), or a new result for one.
 */
export const StepEdit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("arguments"), arguments: Schema.Record(Schema.String, Schema.Unknown) }),
  Schema.Struct({ kind: Schema.Literal("result"), text: Schema.String })
])
export type StepEdit = typeof StepEdit.Type
/** One tool the run was offered, as frozen into its snapshot: exactly what the model saw. */
export const OfferedTool = Schema.Struct({
  capability: Schema.optionalKey(Schema.String),
  titleField: Schema.optionalKey(Schema.String),
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
  effect: EffectClass,
  /** The definition's size in tokens, counted with the run's model's tokenizer where the app has one. */
  tokens: Schema.optionalKey(Schema.Int),
  /** Declared but not sent from the start: a loading call made it callable (spec/TOOL-LOADING.md). */
  deferred: Schema.optionalKey(Schema.Boolean),
  /** The loading call that loaded it in this run, when one did. */
  loadedBy: Schema.optionalKey(Schema.String)
})
export type OfferedTool = typeof OfferedTool.Type

/**
 * The step a part of the transcript is, as `ResumeFromStep` names it: its index in the version's
 * steps (`GetRolloutSteps`). Absent for what isn't a step (the message's own turn, `send_message`).
 */
const StepIndex = { step: Schema.optionalKey(Schema.Int) }

/** A part of the model's turn, verbatim. */
export const TurnPart = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["thinking", "text"]), text: Schema.String, ...StepIndex }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    id: Schema.String,
    name: Schema.String,
    args: Schema.Unknown,
    ...StepIndex
  })
])
export type TurnPart = typeof TurnPart.Type

/**
 * What the loop added after the frozen request, in order (spec/AGENTIC.md §5.3): the model's
 * turns, the tools' results and the app's own messages to the model.
 */
export const TranscriptEntry = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("assistant"),
    parts: Schema.Array(TurnPart),
    /** The provider's reason the turn ended: `stop`, `toolUse`, `error`, `aborted`… */
    stopReason: Schema.String,
    /** Whether this request included the run's frozen tools (the capped request does not). */
    toolsOffered: Schema.Boolean,
    error: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    role: Schema.Literal("toolResult"),
    toolCallId: Schema.String,
    tool: Schema.String,
    text: Schema.String,
    isError: Schema.Boolean,
    /** Its call's step, whose result it is. */
    ...StepIndex
  }),
  /** A message the app sent the model (a nudge to send the reply, the turn cap's last word). */
  Schema.Struct({ role: Schema.Literal("app"), text: Schema.String })
])
export type TranscriptEntry = typeof TranscriptEntry.Type

/**
 * What a resume or a step edit dropped from the run it carried on (`rollout_branches`): the
 * stopped run's entries from there, shown folded before `entries[at]` (at the end when `at` is
 * past them).
 */
export const CutSpan = Schema.Struct({
  reason: Schema.Literals(["resume", "edit"]),
  at: Schema.Int,
  entries: Schema.Array(TranscriptEntry)
})
export type CutSpan = typeof CutSpan.Type

/** An agent run as the inspector shows it: the tools offered and every turn after the request. */
export const RunTranscript = Schema.Struct({
  tools: Schema.Array(OfferedTool),
  entries: Schema.Array(TranscriptEntry),
  /** What resuming dropped of the run it carried on, oldest first. */
  cut: Schema.Array(CutSpan)
})
export type RunTranscript = typeof RunTranscript.Type

/** A tool an agent reply may be offered, as the settings list it. */
const ReplyToolInfo = Schema.Struct({
  id: Schema.String,
  /** Short, as a step's row shows it: "Searched the chat". */
  label: Schema.String,
  /** What it lets the model do, for the user, as the settings' checkbox label: "Search the chat's earlier messages". */
  explanation: Schema.String,
  effect: EffectClass
})

export const ReplyTools = Schema.Struct({
  defaultTools: Schema.Array(Schema.String),
  tools: Schema.Array(ReplyToolInfo)
})
export type ReplyTools = typeof ReplyTools.Type

/**
 * Model work in a chat that made no message (spec/AGENTIC.md §5.4): a summary, a condensation,
 * a judgment of a reply. One row a rollout and purpose; counts are null when nobody reported them.
 */
export const ActivityRow = Schema.Struct({
  /** The rollout, or the request when it had none. */
  id: Schema.String,
  kind: Schema.Literals(["summarize", "condense", "decision", "workshop", "idle_job", "edit"]),
  /** As the rollout ended, or as its last request did. */
  status: Schema.String,
  model: Schema.NullOr(Schema.String),
  connection: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  requests: Schema.Int,
  input: Schema.NullOr(Schema.Int),
  cacheRead: Schema.NullOr(Schema.Int),
  cacheWrite: Schema.NullOr(Schema.Int),
  output: Schema.NullOr(Schema.Int),
  cost: Schema.NullOr(Schema.Struct({ amount: Schema.Number, currency: Schema.String })),
  /** Some count is the app's estimate. */
  estimated: Schema.Boolean,
  /** The summary it wrote, whose request the summary's page shows. */
  summaryId: Schema.NullOr(Schema.String),
  /** The generated revision this row paid for, even when another revision is selected. */
  summaryRevisionId: Schema.NullOr(Schema.String),
  /** The reply it was about (a judgment), to open in the chat. */
  slotId: Schema.NullOr(Schema.String)
})
export type ActivityRow = typeof ActivityRow.Type

/** All sort keys are needed: several purposes and rollouts may start in one millisecond. */
export const ActivityCursor = Schema.Struct({ startedAt: Schema.Number, id: Schema.String, kind: Schema.String })
export type ActivityCursor = typeof ActivityCursor.Type

export const ActivityPage = Schema.Struct({
  rows: Schema.Array(ActivityRow),
  /** Pass as `before` for the next older page; null at the end. */
  before: Schema.NullOr(ActivityCursor)
})
export type ActivityPage = typeof ActivityPage.Type

/** Rows one Activity read returns at most. */
export const ACTIVITY_PAGE = 50
