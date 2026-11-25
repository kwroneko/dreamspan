// What an agent reply's steps element and header badge show (spec/AGENTIC.md §5.1), apart from
// React so it's tested on its own: the live steps while the reply is written, the version's
// summary (`Version.steps`) once it's done.
import type { RolloutStep, StepsSummary, TranscriptEntry } from "@dreamspan/shared/agent.ts"
import { Atom } from "effect/reactivity"
import type { VersionId } from "@dreamspan/shared/chat.ts"

/**
 * What "N steps" counts: tool calls, and the turns the app asked to be sent (spec/REPLY-CONTRACT.md
 * §3.3). Other thinking and text between them are shown, not counted.
 */
export const toolCount = (steps: ReadonlyArray<RolloutStep>) =>
  steps.filter((s) => s.kind === "tool" || s.asked === true).length

/** "14 s", "2 min 5 s". */
export const durationText = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`
}

/** "3 steps · 14 s"; without a time, "3 steps". */
export const stepsText = (count: number, ms: number | null) =>
  `${count === 1 ? "1 step" : `${count.toLocaleString()} steps`}${ms === null ? "" : ` · ${durationText(ms)}`}`

export interface StepsView {
  /** Steps are still coming. */
  readonly running: boolean
  readonly count: number
  readonly ms: number | null
  /** The steps as streamed; null once the reply is done (read from its transcript on opening). */
  readonly live: ReadonlyArray<RolloutStep> | null
  /** Background subagents the reply waits for (spec/SUBAGENTS.md §3.2); 0: none. */
  readonly waitingFor: number
}

/**
 * A finished message's steps as its run still changes them: a background subagent started there
 * goes on after the message was posted (spec/SUBAGENTS.md §3.2). Null: none came after it ended.
 */
export const postedSteps = Atom.family((_id: VersionId) => Atom.make<ReadonlyArray<RolloutStep> | null>(null))

/** Finished replies' steps by version, read once a page; dropped when their run changes them (`postedSteps`). */
export const storedStepReads = new Map<string, Promise<unknown>>()

/** "Waiting for 2 subagents". */
export const subagentsWaitText = (n: number) => `Waiting for ${n === 1 ? "1 subagent" : `${n} subagents`}`

/**
 * What to show for a version, or null for nothing. While generating, its live steps once it has
 * any; afterwards, only a version whose run made tool calls (a plain reply shows nothing).
 */
export const stepsView = (
  live: ReadonlyArray<RolloutStep> | null,
  summary: StepsSummary | undefined,
  generating: boolean,
  waitingFor = 0
): StepsView | null => {
  if (generating && ((live !== null && live.length > 0) || waitingFor > 0))
    return { running: true, count: toolCount(live ?? []), ms: null, live: live ?? [], waitingFor }
  if (generating) return null
  if (!summary || summary.count === 0) return null
  return { running: false, count: summary.count, ms: summary.ms, live: null, waitingFor: 0 }
}

/** One tool step's state as an icon and words, for its row. */
export const statusText = { running: "Running", waiting: "Waiting for you", done: "Done", error: "Failed" } as const

/**
 * Whether the element is open: what the user chose for this version, while that choice is for the
 * same phase (streaming or done); otherwise `auto`, which opens a streaming element once it has run a
 * while and folds it a while after the reply is done (useAutoOpen).
 */
export const isOpen = (
  chosen: { readonly open: boolean; readonly streaming: boolean } | null,
  streaming: boolean,
  auto: boolean
) => (chosen !== null && chosen.streaming === streaming ? chosen.open : auto)

/** Whether a version's steps are open on their own account (useAutoOpen), shared by the element and its badge. */
export const stepsAutoOpen = Atom.family((_id: VersionId) => Atom.make(false))

/** The user's choice for one version's steps, shared by the element and the header badge that opens it. */
export const stepsChoice = Atom.family((_id: VersionId) =>
  Atom.make<{ readonly open: boolean; readonly streaming: boolean } | null>(null)
)

/** The first line of a step's text, cut for its row. */
export const excerpt = (text: string, max = 120) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export interface Turn {
  /** What was added to the context before this request. */
  readonly added: ReadonlyArray<Exclude<TranscriptEntry, { role: "assistant" }>>
  readonly answer: Extract<TranscriptEntry, { role: "assistant" }> | null
}

/** The transcript as requests: what each added to the context, and the turn it got back. */
export const turnsOf = (entries: ReadonlyArray<TranscriptEntry>): Array<Turn> => {
  const turns: Array<Turn> = []
  let added: Array<Exclude<TranscriptEntry, { role: "assistant" }>> = []
  for (const entry of entries) {
    if (entry.role === "assistant") {
      turns.push({ added, answer: entry })
      added = []
    } else added.push(entry)
  }
  // Results with no answer after them: the run stopped before its next request.
  if (added.length > 0) turns.push({ added, answer: null })
  return turns
}
