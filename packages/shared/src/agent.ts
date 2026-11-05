// What an agent rollout shows of its work (spec/AGENTIC.md §5.1): its steps, live while it runs
// and afterwards from its transcript.
import { Schema } from "effect"

const EffectClass = Schema.Literals(["read", "chat_state", "external"])

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
    status: Schema.Literals(["running", "done", "error"]),
    result: Schema.optionalKey(Schema.String),
    effect: EffectClass
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
  message: Schema.String
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
