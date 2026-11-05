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
