// A transcript as the steps a version shows (spec/AGENTIC.md §5.1): the same projection live,
// as the loop runs, and afterwards from the stored transcript.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { RolloutStep } from "@rp/shared/agent.ts"
import type { FrozenTool } from "./tools.ts"

/** The contract's own tool: the message itself, never a step. */
export const SEND_MESSAGE = "send_message"

const resultText = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((p) => (p.type === "text" && p.text !== undefined ? [p.text] : [])).join("")

const title = (args: unknown) => {
  if (args === null || typeof args !== "object") return ""
  const first = Object.values(args as Record<string, unknown>).find(
    (v) => typeof v === "string" || typeof v === "number"
  )
  const text = first === undefined ? "" : String(first)
  return text.length > 80 ? `“${text.slice(0, 79)}…”` : text ? `“${text}”` : ""
}

/** Tool calls a transcript holds, the message's own call left out: what "N steps" counts. */
export const countSteps = (messages: ReadonlyArray<AgentMessage>) =>
  messages.reduce(
    (n, m) =>
      n +
      (m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall" && p.name !== SEND_MESSAGE).length : 0),
    0
  )

/**
 * The steps of a transcript. The last assistant turn without tool calls is the message (its
 * reasoning and text are the version's), as is `send_message`'s call; everything before is a
 * step. `final`: the run ended, so a call without a result failed rather than still running.
 */
export const stepsOf = (
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<FrozenTool>,
  final: boolean
): Array<RolloutStep> => {
  const meta = new Map(tools.map((t) => [t.name, t]))
  const results = new Map<string, { readonly text: string; readonly isError: boolean }>()
  for (const m of messages)
    if (m.role === "toolResult") results.set(m.toolCallId, { text: resultText(m.content), isError: m.isError })
  const plain = messages.findLastIndex(
    (m) => m.role === "assistant" && !m.content.some((p) => p.type === "toolCall") && m.stopReason !== "error"
  )
  const sent = messages.findLastIndex(
    (m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && p.name === SEND_MESSAGE)
  )
  // A message sent after a plain turn (one the app asked to be sent) makes that turn a step.
  const lastPlain = sent > plain ? -1 : plain
  const steps: Array<RolloutStep> = []
  messages.forEach((m, index) => {
    if (m.role !== "assistant" || index === lastPlain) return
    // A turn that sends the message first, with no text, keeps its thinking as the message's.
    const first = m.content.find((p) => p.type === "toolCall")
    const reasoningOfMessage =
      first?.name === SEND_MESSAGE && !m.content.some((p) => p.type === "text" && p.text.trim())
    for (const part of m.content) {
      if (part.type === "thinking" && part.thinking.trim() && !reasoningOfMessage)
        steps.push({ kind: "thinking", text: part.thinking })
      else if (part.type === "text" && part.text.trim()) steps.push({ kind: "text", text: part.text })
      else if (part.type === "toolCall" && part.name !== SEND_MESSAGE) {
        const result = results.get(part.id)
        const tool = meta.get(part.name)
        steps.push({
          kind: "tool",
          id: part.id,
          tool: part.name,
          label: tool?.label ?? part.name,
          title: title(part.arguments),
          args: part.arguments,
          status: result ? (result.isError ? "error" : "done") : final ? "error" : "running",
          ...(result ? { result: result.text } : {}),
          effect: tool?.effect ?? "read"
        })
      }
    }
  })
  return steps
}
