// Resuming an agent rollout (spec/AGENTIC.md §4.2, §4.4; DESIGN §7.5): what of a stored
// transcript a new rollout carries on from, so the model is sent the same prefix and the same
// turns and can't tell it was stopped. A delta from reference-harness's recovery.ts: its strip of the
// failed tail, plus the interruption policies and editing a step first. Pure: the API reads the
// transcript and writes the new version; the agent session runs what this keeps.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  validateToolArguments,
  type AssistantMessage,
  type Tool,
  type ToolCall,
  type ToolResultMessage
} from "@earendil-works/pi-ai"
import { isDeepStrictEqual } from "node:util"
import { placedSteps } from "./steps.ts"
import type { FrozenTool } from "./tools.ts"

/**
 * How the stopped run is carried on (DESIGN §7.5 [P]). `rerun`: a tool call had no result; it
 * runs again (a receipt answers a chat-state call already written). `resample`: a turn was
 * cut off, inside a tool call or with nothing worth keeping; the model writes it again.
 * `continuation`: a turn was cut off inside its text; the text is sent as the start of the
 * reply. `continue`: the transcript ended cleanly between turns. `fresh`: nothing usable was
 * kept; the run starts over from the frozen request.
 */
type ResumePolicy = "rerun" | "resample" | "continuation" | "continue" | "fresh"

export interface ResumePlan {
  readonly policy: ResumePolicy
  /** What the new rollout starts from: the kept transcript, the `rpRequest` kickoff first. */
  readonly transcript: ReadonlyArray<AgentMessage>
  /** `continuation`: the text cut off, which the first request sends as the reply's start. */
  readonly continuation?: string
  /** The discarded tail as it was stored, for `rollout_branches`. */
  readonly cut: ReadonlyArray<AgentMessage>
  /** Tool calls the kept transcript holds: their receipts and effects carry over. */
  readonly keptCalls: ReadonlyArray<string>
}

/** A step's change before resuming from it (§4.4). */
export type StepEdit =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "arguments"; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly kind: "result"; readonly text: string }

const kickoff = (): AgentMessage => ({ role: "rpRequest", timestamp: Date.now() })

const parse = (json: string | null): Array<AgentMessage> | null => {
  if (json === null) return null
  try {
    const messages = JSON.parse(json) as unknown
    return Array.isArray(messages) && messages.some((m) => (m as { role?: unknown })?.role === "rpRequest")
      ? (messages as Array<AgentMessage>)
      : null
  } catch {
    return null
  }
}

const isFailedTurn = (m: AgentMessage) =>
  m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")

/** A tool result a stop cut off (session.ts `INTERRUPTED`): the call didn't finish. */
const isInterruptedResult = (m: AgentMessage) =>
  m.role === "toolResult" && (m.details as { interrupted?: unknown } | null | undefined)?.interrupted === true

const callsOf = (messages: ReadonlyArray<AgentMessage>) => [
  ...new Set(
    messages.flatMap((m) =>
      m.role === "assistant" ? m.content.flatMap((p) => (p.type === "toolCall" ? [p.id] : [])) : []
    )
  )
]

/** The last assistant turn's tool calls that no result answers: what a resume runs first. */
export const danglingCalls = (messages: ReadonlyArray<AgentMessage>) => {
  const last = messages.findLastIndex((m) => m.role === "assistant")
  if (last < 0) return []
  const turn = messages[last] as AssistantMessage
  const answered = new Set(messages.slice(last + 1).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])))
  return turn.content.flatMap((p) => (p.type === "toolCall" && !answered.has(p.id) ? [p] : []))
}

const fresh = (cut: ReadonlyArray<AgentMessage>): ResumePlan => ({
  policy: "fresh",
  transcript: [kickoff()],
  cut,
  keptCalls: []
})

/**
 * Resume a stopped, failed or interrupted run (§4.2). `prefill`: the model takes the start of
 * its reply (`ModelInput.prefill` is `assistant`), so text cut off can be carried on.
 */
export const planResume = (
  json: string | null,
  options: { readonly prefill: boolean; readonly historical?: number }
): ResumePlan => {
  const messages = parse(json)
  if (messages === null) return fresh([])
  const kept = messages.slice()
  const stripped: Array<AgentMessage> = []
  // The failed tail (reference-harness stripFailedTail), and results a stop cut short.
  while (kept.length > 0 && (isFailedTurn(kept.at(-1)!) || isInterruptedResult(kept.at(-1)!)))
    stripped.unshift(kept.pop()!)
  const partial = stripped.filter((m): m is AssistantMessage => m.role === "assistant")
  const parts = partial.flatMap((m) => m.content)
  const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
  let cut: Array<AgentMessage> = stripped.filter((m) => !isInterruptedResult(m))
  let policy: ResumePolicy = "continue"
  let continuation: string | undefined
  if (parts.some((p) => p.type === "toolCall")) policy = "resample"
  else if (text.trim() && options.prefill) {
    policy = "continuation"
    continuation = text
  } else if (partial.length > 0) policy = "resample"
  // A finished plain turn at the end (a reply a later check refused, say) is written again.
  const last = kept.at(-1)
  if (last?.role === "assistant" && !last.content.some((p) => p.type === "toolCall")) {
    cut = [kept.pop()!, ...cut]
    policy = continuation === undefined ? "resample" : policy
  }
  if (danglingCalls(kept).length > 0 && continuation === undefined) policy = "rerun"
  if (!kept.some((m) => m.role === "rpRequest")) return fresh(messages)
  // Nothing of the run is kept: it starts over from the frozen request.
  if (kept.at(-1)?.role === "rpRequest" && continuation === undefined) policy = "fresh"
  return {
    policy,
    transcript: kept,
    ...(continuation === undefined ? {} : { continuation }),
    cut,
    keptCalls: callsOf(kept.slice(options.historical ?? 0))
  }
}

/**
 * The run's thinking taken out of a kept transcript, from message `historical` on (earlier
 * runs' messages a workshop carries stay as they are): the user hid this reply's reasoning
 * from the model, so a resumed run doesn't send it. Signed blocks after the gap are then
 * dropped wire-side too (providers/thinkingBinding.ts). A turn left empty is taken out.
 */
export const withoutThinking = (
  transcript: ReadonlyArray<AgentMessage>,
  historical = 0,
  manualThinking = false
): Array<AgentMessage> => {
  const last = transcript.findLast((m) => m.role === "assistant")
  // Manual thinking requires the current tool turn's original blocks. Defer the choice
  // until that turn finishes; never restore an unsafe block after a provider refusal.
  if (manualThinking && last?.role === "assistant" && last.content.some((p) => p.type === "toolCall"))
    return [...transcript]
  return transcript.flatMap((m, at) => {
    if (at < historical || m.role !== "assistant" || !m.content.some((p) => p.type === "thinking")) return [m]
    const content = m.content.filter((p) => p.type !== "thinking")
    return content.length === 0 ? [] : [{ ...m, content }]
  })
}

/** Why a step can't be resumed from, said to the user. */

export class StepNotResumable {
  readonly _tag = "StepNotResumable"
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

/**
 * Edit a step and resume from it, or only resume from it (§4.4). `step` is its index in the
 * version's steps (`stepsOf`). `newCallId`: the id an edited tool call runs again under, so
 * its old receipt can't answer it.
 */
export const planStepResume = (
  json: string | null,
  tools: ReadonlyArray<FrozenTool>,
  step: number,
  edit: StepEdit | undefined,
  newCallId: string,
  versionId?: string,
  historical = 0
): ResumePlan | StepNotResumable => {
  const messages = parse(json)
  if (messages === null) return new StepNotResumable("This reply has no steps to resume from.")
  const placed = placedSteps(messages, tools, true, versionId)[step]
  if (placed === undefined) return new StepNotResumable("That step isn't in this reply.")
  const at = placed.message
  const turn = messages[at] as AssistantMessage
  const part = turn.content[placed.part]!
  const nextTurn = messages.findIndex((m, i) => i > at && m.role === "assistant")
  const resultsAfter = (upTo: (id: string) => boolean) =>
    messages
      .slice(at + 1, nextTurn < 0 ? undefined : nextTurn)
      .filter((m): m is ToolResultMessage => m.role === "toolResult" && upTo(m.toolCallId))
  const calls = turn.content.flatMap((p) => (p.type === "toolCall" ? [p.id] : []))
  let kept: Array<AgentMessage>
  let replayedCalls: ReadonlySet<string> = new Set()
  if (placed.step.kind !== "tool") {
    if (edit !== undefined && edit.kind !== "text") return new StepNotResumable("Only text can replace this step.")
    const content = turn.content.map((p, i) => {
      if (i !== placed.part || edit === undefined) return p
      return p.type === "thinking" ? { ...p, thinking: edit.text } : p.type === "text" ? { ...p, text: edit.text } : p
    })
    kept = [...messages.slice(0, at), { ...turn, content }, ...resultsAfter((id) => calls.includes(id))]
    if (calls.length === 0) {
      // A plain turn the app then asked to be sent: its note comes with it.
      const notes = messages.slice(at + 1).findIndex((m) => m.role !== "rpHarness")
      const following = messages.slice(at + 1, notes < 0 ? undefined : at + 1 + notes)
      if (following.length === 0) return new StepNotResumable("The reply can't be carried on from its own text.")
      kept.push(...following)
    }
  } else {
    if (part.type !== "toolCall") return new StepNotResumable("That step isn't a tool call.")
    const index = calls.indexOf(part.id)
    const before = new Set(calls.slice(0, index))
    if (edit?.kind === "arguments") {
      const tool = tools.find((t) => t.name === part.name)
      if (tool === undefined) return new StepNotResumable("That tool wasn't offered to this reply.")
      try {
        const validated: unknown = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters as Tool["parameters"] },
          { ...part, arguments: edit.arguments as ToolCall["arguments"] }
        )
        // Human edits must fit as written; provider argument coercion must not silently change them.
        if (!isDeepStrictEqual(validated, edit.arguments))
          return new StepNotResumable("The arguments don't fit this tool's parameters.")
      } catch {
        return new StepNotResumable("The arguments don't fit this tool's parameters.")
      }
      // The call runs again with the new arguments, under a new id; later calls of the turn go.
      const content = turn.content.slice(0, placed.part + 1).map((p, i) => {
        if (i !== placed.part || p.type !== "toolCall") return p
        const edited = { ...p, id: newCallId, arguments: edit.arguments as ToolCall["arguments"] }
        delete (edited as ToolCall & { dispatchRefusal?: string }).dispatchRefusal
        return edited
      })
      kept = [...messages.slice(0, at), { ...turn, content }, ...resultsAfter((id) => before.has(id))]
    } else if (edit === undefined || edit.kind === "result") {
      const results = resultsAfter((id) => before.has(id) || id === part.id).map((m) =>
        m.toolCallId === part.id && edit !== undefined
          ? { ...m, content: [{ type: "text" as const, text: edit.text }], isError: false }
          : m
      )
      if (!results.some((m) => m.toolCallId === part.id))
        return new StepNotResumable("That tool call has no result to carry on from.")
      kept = [...messages.slice(0, at), turn, ...results]
      // Later calls remain in the assistant turn to be run again. Their old results,
      // receipts and effects belong to the cut tail, even though their call ids are retained.
      replayedCalls = new Set(calls.slice(index + 1))
    } else return new StepNotResumable("A tool call takes new arguments or a new result.")
  }
  return {
    policy: danglingCalls(kept).length > 0 ? "rerun" : "continue",
    transcript: kept,
    cut: messages.slice(at),
    keptCalls: callsOf(kept.slice(historical)).filter((id) => id !== newCallId && !replayedCalls.has(id))
  }
}

/** A several-message swipe replays the request that wrote this message, retaining all
 * earlier sends. Final text has no send boundary, so only its last assistant turn is cut. */
export const planMessageResume = (
  json: string | null,
  versionId: string,
  historical = 0
): ResumePlan | StepNotResumable => {
  const messages = parse(json)
  if (!messages) return new StepNotResumable("This message has no saved run to carry on.")
  const resultIndex = messages.findIndex(
    (m) => m.role === "toolResult" && (m.details as { versionId?: string } | null)?.versionId === versionId
  )
  const result = messages[resultIndex]
  const callId = result?.role === "toolResult" ? result.toolCallId : undefined
  const at = callId
    ? messages
        .slice(0, resultIndex)
        .findLastIndex((m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && p.id === callId))
    : messages.findLastIndex((m) => m.role === "assistant")
  if (at < 0) return new StepNotResumable("This message has no saved turn to write again.")
  const kept = messages.slice(0, at)
  const turn = messages[at]
  if (callId && turn?.role === "assistant") {
    const part = turn.content.findIndex((p) => p.type === "toolCall" && p.id === callId)
    const content = turn.content.slice(0, part)
    const calls = new Set(content.flatMap((p) => (p.type === "toolCall" ? [p.id] : [])))
    if (calls.size)
      kept.push(
        { ...turn, content },
        ...messages.slice(at + 1, resultIndex).filter((m) => m.role === "toolResult" && calls.has(m.toolCallId))
      )
  }
  return { policy: "continue", transcript: kept, cut: messages.slice(at), keptCalls: callsOf(kept.slice(historical)) }
}
