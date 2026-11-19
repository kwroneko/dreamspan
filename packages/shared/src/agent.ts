// What an agent rollout shows of its work (spec/AGENTIC.md §5.1): its steps, live while it runs
// and afterwards from its transcript.
import { Schema } from "effect"
import { StoryAtField } from "./chatPosition.ts"

const EffectClass = Schema.Literals(["read", "chat_state", "external", "library", "setup", "outside", "mcp", "files"])

/**
 * What a tool call waiting for the user will do, as the server describes it from the call's real
 * arguments and the items they name (spec/WORKSHOP.md §3.4): never the model's own wording of it.
 */
const StepPresentation = Schema.Struct({ title: Schema.String, subtitle: Schema.optionalKey(Schema.String) })

export const ApprovalPrompt = Schema.Struct({
  presentation: Schema.optionalKey(StepPresentation),
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
  /**
   * Set where "Allow in this workshop" is remembered for this exact content only (a card's own
   * skill as shown): its digest. Changed content asks again.
   */
  grantTarget: Schema.optionalKey(Schema.String),
  /** What it will do, in a line: "Create the card “Mara Quill”". */
  title: Schema.String,
  /** The values it will write, as the arguments give them. */
  rows: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  /** An edit's fields as they are and as they would be. */
  changes: Schema.optionalKey(
    Schema.Array(Schema.Struct({ field: Schema.String, before: Schema.String, after: Schema.String }))
  ),
  /** Only this one call can be allowed: no "Allow in this workshop" (a server plugin's commit from Files). */
  once: Schema.optionalKey(Schema.Boolean),
  /** The app stopped while it may have been running: it may already have happened. */
  uncertain: Schema.Boolean,
  /**
   * An interrupted call to an MCP server (spec/MCP.md §8.3), asked as "Run it again" or "Don't
   * run it", with what the app's ledger knows: when it last sent the call to the server, if it did.
   */
  rerun: Schema.optionalKey(
    Schema.Struct({
      connectionId: Schema.String,
      /** The server's name, as the user gave it. */
      connection: Schema.String,
      host: Schema.String,
      /** When the app last sent it; null: it was never sent. */
      sentAt: Schema.NullOr(Schema.Number),
      /** That request's ledger status: running, interrupted, cancelled, timeout or failed. */
      status: Schema.NullOr(Schema.String)
    })
  ),
  /**
   * A subagent whose run couldn't be resumed (spec/SUBAGENTS.md §8), asked as "Start the task
   * again" or "Leave it", with the changes its first attempt made.
   */
  restart: Schema.optionalKey(Schema.Struct({ handle: Schema.String, effects: Schema.Array(Schema.String) }))
})
export type ApprovalPrompt = typeof ApprovalPrompt.Type

const ThoughtStep = Schema.Struct({
  kind: Schema.Literals(["thinking", "text"]),
  text: Schema.String,
  /**
   * The app asked for this turn's reply to be sent after it (spec/REPLY-CONTRACT.md §3.3): on the
   * turn's last step. Counted in "N steps" as a tool call is.
   */
  asked: Schema.optionalKey(Schema.Literal(true))
})

const ToolStepFields = {
  kind: Schema.Literal("tool"),
  /** The call's id in the transcript. */
  id: Schema.String,
  tool: Schema.String,
  /** Short and user-facing: "Searched the chat". */
  label: Schema.String,
  /** What it was called with, in a line: “lighthouse”. */
  title: Schema.String,
  subtitle: Schema.optionalKey(Schema.String),
  args: Schema.Unknown,
  /** `waiting`: the call asks the user first (`approval` says what it will do). */
  status: Schema.Literals(["running", "waiting", "done", "error"]),
  result: Schema.optionalKey(Schema.String),
  approval: Schema.optionalKey(ApprovalPrompt),
  /** Existing steps render these three display classes. */
  effect: Schema.Literals(["read", "chat_state", "external"]),
  /** The refined execution class, when it differs from the display class. */
  effectClass: Schema.optionalKey(EffectClass),
  /**
   * While it runs, how far the tool says it got (an MCP server's progress, spec/MCP.md §7.3):
   * "Working… 40%" or the server's own words. Live only, never stored.
   */
  progress: Schema.optionalKey(Schema.String)
}

/** A subagent's own step, one level deep: never a subagent of its own (spec/SUBAGENTS.md §6.1). */
export const ChildStep = Schema.Union([ThoughtStep, Schema.Struct(ToolStepFields)])
export type ChildStep = typeof ChildStep.Type

/** How a subagent stands: `waiting` while one of its calls asks the user first. */
/** `queued`: waiting for a free place (spec/SUBAGENTS.md §6.3); `limit`: stopped at one of its limits (§6.2). */
export const SubagentStatus = Schema.Literals(["queued", "running", "waiting", "done", "stopped", "limit", "failed"])
export type SubagentStatus = typeof SubagentStatus.Type

/**
 * A subagent an `agent` call started (spec/SUBAGENTS.md §2, §7): the child run, what it was asked,
 * the model it ran on and how far it got. Shown as one collapsed row under the call's step.
 */
export const SubagentRow = Schema.Struct({
  rolloutId: Schema.String,
  /** The handle the parent names it by: "research-2". */
  handle: Schema.String,
  type: Schema.String,
  /** The type's own label: "Look things up". */
  typeLabel: Schema.String,
  /** What the type does, for the row's hover. */
  typeExplanation: Schema.optionalKey(Schema.String),
  /** The short label the parent gave it, if any. */
  name: Schema.optionalKey(Schema.String),
  task: Schema.String,
  /** The allowed-list alias it ran on (spec/SUBAGENTS.md §5.1), and that model's name. */
  alias: Schema.String,
  model: Schema.String,
  /** The reasoning level its requests asked for ("high"); absent: none, the model's default. */
  effort: Schema.optionalKey(Schema.String),
  status: SubagentStatus,
  /** Its steps, as its own transcript holds them (absent where they weren't read). */
  steps: Schema.optionalKey(Schema.Array(ChildStep)),
  /** Its tool calls, and how long it ran (null while it runs). */
  count: Schema.Int,
  ms: Schema.NullOr(Schema.Int),
  /** What its requests cost, as the ledger priced them; null when unknown or still running. */
  cost: Schema.NullOr(Schema.Struct({ amount: Schema.Number, currency: Schema.String })),
  /** It was stopped with the reply and carried on where it stopped when the reply was resumed (§8). */
  resumed: Schema.optionalKey(Schema.Boolean),
  /** Its latest `report_progress` line: "Read 12 of 40 files" (spec/SUBAGENTS.md §4). */
  progress: Schema.optionalKey(Schema.String),
  /** It works in the background: the reply goes on, and its report reaches the reply later (§3.2). */
  background: Schema.optionalKey(Schema.Boolean),
  /** It carries a finished subagent on with the assistant's message (`message_agent`, §4). */
  continued: Schema.optionalKey(Schema.Boolean),
  /** It started from the conversation up to its call, then its task (a fork, §2.3). */
  forked: Schema.optionalKey(Schema.Boolean),
  /**
   * Where it works on files (spec/SUBAGENTS.md §3.3): its own copy of the working folder (a git
   * worktree on `branch`, or a file copy). `kept`: it ended with changes, so the copy stays;
   * false: it had none and was removed; absent while it runs.
   */
  copy: Schema.optionalKey(
    Schema.Struct({
      path: Schema.String,
      from: Schema.String,
      branch: Schema.optionalKey(Schema.String),
      kept: Schema.optionalKey(Schema.Boolean)
    })
  ),
  /** Where it works in the reply's own folder (same-folder work): the folder it starts in. */
  folder: Schema.optionalKey(Schema.String)
})
export type SubagentRow = typeof SubagentRow.Type

/**
 * A step: thinking or intermediate text from a turn that went on to call a tool, or one tool
 * call with its result. The final turn's reasoning and text are the version's own. An `agent`
 * call carries the subagent it started (spec/SUBAGENTS.md §7).
 */
export const RolloutStep = Schema.Union([
  ThoughtStep,
  Schema.Struct({ ...ToolStepFields, subagent: Schema.optionalKey(SubagentRow) })
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
  loadedBy: Schema.optionalKey(Schema.String),
  /** An MCP server's tool (spec/MCP.md §10): which server, where, and when its tools were listed. */
  mcp: Schema.optionalKey(
    Schema.Struct({
      connection: Schema.String,
      connectionName: Schema.String,
      host: Schema.String,
      listedAt: Schema.NullOr(Schema.Number)
    })
  )
})
export type OfferedTool = typeof OfferedTool.Type

/**
 * One request of an MCP call as the ledger recorded it (spec/MCP.md §10): every attempt, with
 * when it was sent, how long it took and how much came back. Never its arguments or result.
 */
export const McpCallLine = Schema.Struct({
  toolCallId: Schema.String,
  attempt: Schema.Int,
  status: Schema.Literals(["running", "complete", "error", "failed", "timeout", "cancelled", "interrupted"]),
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  receivedBytes: Schema.NullOr(Schema.Number)
})
export type McpCallLine = typeof McpCallLine.Type

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
    /** What the model was sent of it, when that was a page of the whole result. */
    sent: Schema.optionalKey(Schema.String),
    /** Its call's step, whose result it is. */
    ...StepIndex
  }),
  /**
   * A message the app sent the model (a nudge to send the reply, the turn cap's last word).
   * `nudge`: the run's nth ask to send the reply (spec/REPLY-CONTRACT.md §3.3).
   */
  Schema.Struct({ role: Schema.Literal("app"), text: Schema.String, nudge: Schema.optionalKey(Schema.Int) })
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

/**
 * Why a reply attempt under the send tool wasn't the reply (spec/REPLY-CONTRACT.md §3.6), in
 * precedence order: a send the app refused, tool-call markup written as text, the context's own
 * markup copied, plain text, nothing at all.
 */
export const CONTRACT_FAILURES = [
  "invalid_tool_call",
  "textual_tool_call",
  "context_mimicry",
  "text_only",
  "empty"
] as const
export const ContractFailure = Schema.Literals(CONTRACT_FAILURES)
export type ContractFailure = typeof ContractFailure.Type

/**
 * One ending of a run under the send tool: the turn before a nudge, or the run's last. `ending`:
 * `sent` (send_message), `passed` (no_reply), `written` (the answer to the cap's "write now", which
 * is the reply), or `failed`, with `failures` saying why. `cut`: a Resume dropped it.
 */
export const ContractAttempt = Schema.Struct({
  ending: Schema.Literals(["sent", "passed", "written", "failed"]),
  failures: Schema.Array(ContractFailure),
  cut: Schema.Boolean
})
export type ContractAttempt = typeof ContractAttempt.Type

/**
 * How a run met the send tool's contract: `clean` (the first ending was the reply or a pass),
 * `recovered` (sent after nudges), `gave_up` (passed after nudges), `exhausted` (the nudges ran
 * out). A run that ended without a reply for another reason: `stopped` (the user, or the app,
 * stopped it), `failed` (a provider or app error), `capped` (its last request, the request cap's,
 * gave no reply). Null while the run hasn't ended; the transcript alone never says `stopped`,
 * `failed` or `capped`, which only the run's own end records (`runOutcome`).
 */
const CONTRACT_OUTCOMES = ["clean", "recovered", "gave_up", "exhausted", "stopped", "failed", "capped"] as const
export const ContractOutcome = Schema.Literals(CONTRACT_OUTCOMES)
export type ContractOutcome = typeof ContractOutcome.Type

export const ContractRecord = Schema.Struct({
  attempts: Schema.Array(ContractAttempt),
  /** The asks to send, those a Resume cut included. */
  nudges: Schema.Int,
  outcome: Schema.NullOr(ContractOutcome)
})
export type ContractRecord = typeof ContractRecord.Type

/**
 * How one model's story replies under the send tool met its contract (spec/REPLY-CONTRACT.md
 * §3.6, milestone 4), over every reply whose run ended: how many the app had to ask to send, how
 * many then sent, passed after asking, or never sent, and how many were stopped, failed or ran
 * out of requests first.
 */
export const ModelBehaviour = Schema.Struct({
  connectionId: Schema.String,
  connectionName: Schema.String,
  modelId: Schema.String,
  modelKey: Schema.String,
  replies: Schema.Int,
  nudged: Schema.Int,
  recovered: Schema.Int,
  gaveUp: Schema.Int,
  exhausted: Schema.Int,
  /** Stopped before a reply (by the user, or the app shutting down). */
  stopped: Schema.Int,
  /** Ended by a provider or app error before a reply. */
  failed: Schema.Int,
  /** Reached the request cap without a reply. */
  capped: Schema.Int,
  /** The asks to send, all of them. */
  nudges: Schema.Int
})
export type ModelBehaviour = typeof ModelBehaviour.Type

/** An agent run as the inspector shows it: the tools offered and every turn after the request. */
export const RunTranscript = Schema.Struct({
  tools: Schema.Array(OfferedTool),
  entries: Schema.Array(TranscriptEntry),
  /** What resuming dropped of the run it carried on, oldest first. */
  cut: Schema.Array(CutSpan),
  /** The ledger's rows of the run's MCP calls, oldest first (spec/MCP.md §10); absent without any. */
  mcpCalls: Schema.optionalKey(Schema.Array(McpCallLine)),
  /** Its attempts at the send tool's contract; absent for a run under another contract. */
  contract: Schema.optionalKey(ContractRecord)
})
export type RunTranscript = typeof RunTranscript.Type

/** A tool an agent reply may be offered, as the settings list it. */
const ReplyToolInfo = Schema.Struct({
  id: Schema.String,
  /** Short, as a step's row shows it: "Searched the chat". */
  label: Schema.String,
  /** What it lets the model do, for the user, as the settings' checkbox label: "Search the chat's earlier messages". */
  explanation: Schema.String,
  effect: EffectClass,
  /**
   * Its calls start subagents on the chat's subagent models (the story helper): allowing it lets
   * them send what they read there, so the list says so and the subagent model chip shows.
   */
  subagents: Schema.optionalKey(Schema.Boolean)
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
