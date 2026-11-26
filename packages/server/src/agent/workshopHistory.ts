import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import { isNudge } from "./messages.ts"
import { messageBounds, NO_REPLY, SEND_MESSAGE } from "./steps.ts"

export type WorkshopMessage = AssistantMessage | ToolResultMessage | UserMessage

/** A selected reply's own trace, including legacy versions posted by a multi-message run. */
export const workshopHistory = (
  transcript: ReadonlyArray<AgentMessage>,
  versionId: string
): ReadonlyArray<WorkshopMessage> => {
  const { after, through } = messageBounds(transcript, versionId, true)
  const output: Array<WorkshopMessage> = []
  for (let i = Math.max(0, after); i <= through && i < transcript.length; i++) {
    const turn = transcript[i]!
    if (turn.role === "rpApp" && i > after && turn.report) {
      output.push({ role: "user", content: turn.content, timestamp: 0 })
      continue
    }
    if (turn.role !== "assistant" || isNudge(transcript[i + 1])) continue
    const results = new Map<string, ToolResultMessage>()
    for (let next = i + 1; next <= through && next < transcript.length; next++) {
      const result = transcript[next]!
      if (result.role !== "toolResult") break
      if (next > after) results.set(result.toolCallId, result)
    }
    const boundary = turn.content.some(
      (part) => part.type === "toolCall" && (part.name === SEND_MESSAGE || part.name === NO_REPLY)
    )
    const calls = new Set<string>()
    const content = turn.content.flatMap((part): AssistantMessage["content"] => {
      if (part.type === "thinking" && (boundary || (turn.api !== "openai-completions" && !part.thinkingSignature)))
        return []
      if (part.type !== "toolCall") return i > after ? [part] : []
      const result = results.get(part.id)
      if (part.name === SEND_MESSAGE || part.name === NO_REPLY) {
        if (part.name === SEND_MESSAGE && result && !result.isError && typeof part.arguments.message === "string")
          return [{ type: "text", text: part.arguments.message }]
        return []
      }
      if (i <= after && !result) return []
      calls.add(part.id)
      return [part]
    })
    if (content.length === 0) continue
    output.push({
      role: "assistant",
      api: turn.api,
      provider: turn.provider,
      model: turn.model,
      usage: turn.usage,
      content,
      // pi-ai skips failed turns, which can still contain a text step or tool call worth replaying.
      stopReason: calls.size ? "toolUse" : "stop",
      timestamp: 0,
      ...(turn.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: turn.providerThinkingLevel })
    })
    for (const result of results.values()) {
      if (!calls.has(result.toolCallId)) continue
      const { details: _details, ...message } = result
      output.push({ ...message, timestamp: 0 })
    }
    for (const part of content) {
      if (part.type !== "toolCall" || results.has(part.id)) continue
      output.push({
        role: "toolResult",
        toolCallId: part.id,
        toolName: part.name,
        content: [{ type: "text", text: "This tool call had no recorded result." }],
        isError: true,
        timestamp: 0
      })
    }
  }
  return output
}

export const workshopMessageText = (message: WorkshopMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

/** Include the call arguments in the budget even on assistant turns with no prose. */
export const workshopMessageCost = (message: WorkshopMessage, count: (text: string) => number): number =>
  3 +
  (typeof message.content === "string"
    ? count(message.content)
    : message.content.reduce(
        (tokens, part) =>
          tokens +
          (part.type === "text"
            ? count(part.text)
            : part.type === "toolCall"
              ? count(part.name + JSON.stringify(part.arguments))
              : part.type === "thinking"
                ? count(part.thinking)
                : 0),
        0
      ))
