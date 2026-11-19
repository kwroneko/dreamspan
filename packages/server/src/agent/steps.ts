import { forkStart, isNudge } from "./messages.ts"
// A transcript as the steps a version shows (spec/AGENTIC.md §5.1): the same projection live,
// as the loop runs, and afterwards from the stored transcript.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ApprovalPrompt, RolloutStep, SubagentRow } from "@dreamspan/shared/agent.ts"
import type { FrozenTool } from "./tools.ts"

type Presentation = NonNullable<ApprovalPrompt["presentation"]>

/** The contract's own tool: the message itself, never a step. */
export const SEND_MESSAGE = "send_message"

/** A story reply's pass (spec/REPLY-CONTRACT.md §3.1): the ending itself, never a step. */
export const NO_REPLY = "no_reply"

/** The calls that end the reply: the message, or the pass. */
const endsReply = (name: string) => name === SEND_MESSAGE || name === NO_REPLY

const resultText = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((p) => (p.type === "text" && p.text !== undefined ? [p.text] : [])).join("")

const title = (args: unknown, field?: string) => {
  if (args === null || typeof args !== "object") return ""
  if (field) {
    const text = (args as Record<string, unknown>)[field]
    return typeof text === "string" ? (text.length > 80 ? `${text.slice(0, 79)}…` : text) : ""
  }
  const first = Object.values(args as Record<string, unknown>).find(
    (v) => typeof v === "string" || typeof v === "number"
  )
  const text = first === undefined ? "" : String(first)
  return text.length > 80 ? `“${text.slice(0, 79)}…”` : text ? `“${text}”` : ""
}

/**
 * What "N steps" counts: the tool calls a transcript holds, the message's own call (or the pass)
 * left out, and the turns the app asked to be sent (spec/REPLY-CONTRACT.md §3.3), so a run whose
 * stray text was nudged has steps to show. The same count the live steps give (`counted`).
 */
export const countSteps = (messages: ReadonlyArray<AgentMessage>) => counted(stepsOf(messages, [], true))

/** The steps "N steps" counts: tool calls and the turns the app asked to be sent. */
export const counted = (steps: ReadonlyArray<RolloutStep>) =>
  steps.filter((s) => s.kind === "tool" || s.asked === true).length

/**
 * The steps of a transcript. The last assistant turn without tool calls is the message (its
 * reasoning and text are the version's), as is `send_message`'s call; everything before is a
 * step. `final`: the run ended, so a call without a result failed rather than still running.
 */
export const stepsOf = (
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<FrozenTool>,
  final: boolean,
  versionId?: string
): Array<RolloutStep> => placedSteps(messages, tools, final, versionId).map((p) => p.step)

/** A step, with where it is in the transcript: its message and the part of that message. */
export interface PlacedStep {
  readonly step: RolloutStep
  readonly message: number
  readonly part: number
}

/** Stands for a parent's message in a fork's transcript: no step, no message end. */
const PARENT = { role: "rpParent", timestamp: 0 } as unknown as AgentMessage

/** `stepsOf`, with each step's place (resume.ts edits a step there). */
export const placedSteps = (
  all: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<FrozenTool>,
  final: boolean,
  versionId?: string
): Array<PlacedStep> => {
  // A fork subagent's transcript starts with its parent's conversation: never its steps. Its
  // places keep their indexes, so Resume edits the same messages.
  const own = forkStart(all)
  const messages = own === 0 ? all : all.map((m, i) => (i < own ? PARENT : m))
  const bounds = versionId === undefined ? null : messageBounds(messages, versionId, final)
  const meta = new Map(tools.map((t) => [t.name, t]))
  // IDs may repeat in a later provider turn. A result answers its own assistant turn.
  const results = new Map<
    number,
    Map<
      string,
      {
        readonly text: string
        readonly isError: boolean
        readonly index: number
        readonly presentation?: Presentation
        readonly subagent?: SubagentRow
      }
    >
  >()
  let assistant = -1
  messages.forEach((m, index) => {
    if (m.role === "assistant") {
      assistant = index
      results.set(index, new Map())
    } else if (m.role === "toolResult")
      results.get(assistant)?.set(m.toolCallId, {
        text: resultText(m.content),
        isError: m.isError,
        index,
        ...((m.details as { presentation?: Presentation } | null)?.presentation
          ? {
              presentation: (m.details as { presentation: Presentation }).presentation
            }
          : {}),
        // The subagent an `agent` call started, as it ended (spec/SUBAGENTS.md §7).
        ...((m.details as { subagent?: SubagentRow } | null)?.subagent
          ? { subagent: (m.details as { subagent: SubagentRow }).subagent }
          : {})
      })
  })
  // A turn cut off in its text (a stop, an error) was the message being written: never a step.
  const plain = messages.findLastIndex((m) => m.role === "assistant" && !m.content.some((p) => p.type === "toolCall"))
  const sent = messages.findLastIndex(
    (m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && endsReply(p.name))
  )
  // Under the send tool, text after the app asked for the reply to be sent is never the message,
  // except the answer to the request cap's "write now" (spec/REPLY-CONTRACT.md §3.2, §3.5).
  // A run under the send tool alone says so on its frozen request (`rpRequest.contract`): there no
  // plain turn is the message, nudged or not (one stopped or failed before any nudge too), but the
  // answer to the cap's "write now".
  const sendOnly = (messages.find((m) => m.role === "rpRequest") as { contract?: string } | undefined)?.contract
  const writeNowAnswer = messages[plain - 1]?.role === "rpApp" && !isNudge(messages[plain - 1])
  const stray =
    plain >= 0 && !writeNowAnswer && (sendOnly === "send_message" || messages.slice(0, plain).some((m) => isNudge(m)))
  // A message sent after a plain turn (one the app asked to be sent) makes that turn a step.
  const noFinalText =
    messages.some((m) => m.role === "toolResult" && (m.details as { versionId?: string } | null)?.versionId) &&
    plain >= 0 &&
    !(messages[plain] as import("@earendil-works/pi-ai").AssistantMessage).content.some(
      (p) => p.type === "text" && p.text.trim()
    )
  const lastPlain = sent > plain || noFinalText || stray ? -1 : plain
  const steps: Array<PlacedStep> = []
  messages.forEach((m, index) => {
    if (m.role !== "assistant" || index === lastPlain) return
    // A plain turn posted as its own message while the run waited (spec/SUBAGENTS.md §3.2).
    if (messages[index + 1]?.role === "rpPosted" && !m.content.some((p) => p.type === "toolCall")) return
    // A turn that sends the message first, with no text, keeps its thinking as the message's.
    const first = m.content.find((p) => p.type === "toolCall")
    const reasoningOfMessage =
      first !== undefined && endsReply(first.name) && !m.content.some((p) => p.type === "text" && p.text.trim())
    m.content.forEach((part, at) => {
      const result = part.type === "toolCall" ? results.get(index)?.get(part.id) : undefined
      const place = (step: RolloutStep) => {
        const sentBefore = m.content.slice(0, at).flatMap((p) => {
          const posted =
            p.type === "toolCall" && p.name === SEND_MESSAGE ? results.get(index)?.get(p.id)?.index : undefined
          return posted === undefined ? [] : [posted + 0.5]
        })
        const position = part.type === "toolCall" ? (result?.index ?? Math.max(index, ...sentBefore)) : index
        if (bounds && (position <= bounds.after || position > bounds.through)) return
        steps.push({ step, message: index, part: at })
      }
      if (part.type === "thinking" && part.thinking.trim() && !reasoningOfMessage)
        place({ kind: "thinking", text: part.thinking })
      else if (part.type === "text" && part.text.trim()) place({ kind: "text", text: part.text })
      else if (part.type === "toolCall" && !endsReply(part.name)) {
        const tool = meta.get(part.name)
        const effect = tool?.effect ?? "read"
        const displayEffect = effect === "read" || effect === "chat_state" ? effect : "external"
        place({
          kind: "tool",
          id: part.id,
          tool: part.name,
          label: tool?.label ?? part.name,
          title: title(part.arguments, tool?.titleField),
          ...result?.presentation,
          args: part.arguments,
          status: result ? (result.isError ? "error" : "done") : final ? "error" : "running",
          ...(result ? { result: result.text } : {}),
          effect: displayEffect,
          ...(effect === displayEffect ? {} : { effectClass: effect }),
          ...(result?.subagent ? { subagent: result.subagent } : {})
        })
      }
    })
  })
  // A turn the app asked to be sent after (a nudge follows it) marks its last step, so the ask is
  // counted where it shows; a turn that wrote nothing shows as an empty text step (part -1: no part).
  messages.forEach((m, index) => {
    if (!isNudge(m) || messages[index - 1]?.role !== "assistant") return
    const turn = index - 1
    if (bounds && (turn <= bounds.after || turn > bounds.through)) return
    const last = steps.findLastIndex((p) => p.message === turn && p.step.kind !== "tool")
    const placed = steps[last]
    if (placed && placed.step.kind !== "tool") steps[last] = { ...placed, step: { ...placed.step, asked: true } }
    else if (!steps.some((p) => p.message === turn)) {
      const after = steps.findIndex((p) => p.message > turn)
      const empty: PlacedStep = { step: { kind: "text", text: "", asked: true }, message: turn, part: -1 }
      if (after < 0) steps.push(empty)
      else steps.splice(after, 0, empty)
    }
  })
  return steps
}

/**
 * The calls a version's message and the run's later messages made, by id, with each one's result
 * text (null without one): the changes listed for that message's steps and its regenerate warning
 * (spec/WORKSHOP.md §3.6). Earlier messages' calls, and a carried run's history before this turn,
 * are left out. A call sits where its result is, else at its turn. Without `versionId`, every call.
 */
export const callsFrom = (messages: ReadonlyArray<AgentMessage>, versionId?: string): Map<string, string | null> => {
  const after = versionId === undefined ? -1 : messageBounds(messages, versionId, true).after
  const calls = new Map<string, string | null>()
  messages.forEach((m, index) => {
    if (m.role !== "assistant") return
    const results = new Map<string, { readonly at: number; readonly text: string }>()
    for (let next = index + 1; next < messages.length && messages[next]!.role !== "assistant"; next++) {
      const r = messages[next]!
      if (r.role === "toolResult") results.set(r.toolCallId, { at: next, text: resultText(r.content) })
    }
    for (const part of m.content) {
      const result = part.type === "toolCall" ? results.get(part.id) : undefined
      if (part.type === "toolCall" && !endsReply(part.name) && (result?.at ?? index) > after)
        calls.set(part.id, result?.text ?? null)
    }
  })
  return calls
}

/** Successful posts mark the version they completed. The unposted tail belongs to the working
 * version, or (when there is no final message) the last posted message. */
export const messageBounds = (messages: ReadonlyArray<AgentMessage>, versionId: string, final: boolean) => {
  const posts = messages.flatMap((m, index) => {
    // A turn's text posted when the run waited for its subagents ends a message too (§3.2).
    const id =
      m.role === "toolResult" && m.toolName === SEND_MESSAGE && !m.isError
        ? (m.details as { versionId?: string } | null)?.versionId
        : m.role === "rpPosted"
          ? m.versionId
          : undefined
    return id ? [{ id, index }] : []
  })
  const at = posts.findIndex((p) => p.id === versionId)
  const lastUser = messages.findLastIndex((m) => m.role === "user" || m.role === "rpUser")
  if (at < 0) return { after: Math.max(lastUser, posts.at(-1)?.index ?? -1), through: messages.length }
  const post = posts[at]!
  const tail = messages.slice(post.index + 1)
  const finalText = tail.some(
    (m) =>
      m.role === "assistant" &&
      !m.content.some((p) => p.type === "toolCall") &&
      m.content.some((p) => p.type === "text" && p.text.trim())
  )
  return {
    after: Math.max(
      messages.slice(0, post.index).findLastIndex((m) => m.role === "user" || m.role === "rpUser"),
      posts[at - 1]?.index ?? -1
    ),
    through: final && at === posts.length - 1 && !finalText && lastUser < post.index ? messages.length : post.index
  }
}
