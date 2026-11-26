import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { TextBlock, VersionBlock } from "@dreamspan/shared/chat.ts"
import { counted, messageBounds, placedSteps, SEND_MESSAGE } from "./steps.ts"
import type { FrozenTool } from "./tools.ts"

export const workshopBlocks = (
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<FrozenTool>,
  final: boolean,
  versionId: string,
  steps = placedSteps(messages, tools, final, versionId)
): Array<VersionBlock> => {
  const { after, through } = messageBounds(messages, versionId, final)
  const sendOnly = messages.find((m) => m.role === "rpRequest")?.contract === "send_message"
  const prose: Array<TextBlock> = []
  const add = (message: number, part: number, text: string) =>
    prose.push({ kind: "text", id: `text:${message}:${part}`, message, part, text })
  for (let i = after + 1; i <= through && i < messages.length; i++) {
    const turn = messages[i]!
    if (turn.role !== "assistant") continue
    const placed = steps.some((step) => step.message === i)
    turn.content.forEach((part, at) => {
      if (part.type === "text" && !sendOnly && (final || placed)) add(i, at, part.text)
      if (
        !final ||
        part.type !== "toolCall" ||
        part.name !== SEND_MESSAGE ||
        typeof part.arguments.message !== "string"
      )
        return
      for (let next = i + 1; next <= through && messages[next]?.role === "toolResult"; next++) {
        const result = messages[next]!
        if (result.role === "toolResult" && result.toolCallId === part.id && !result.isError) {
          add(i, at, part.arguments.message)
          break
        }
      }
    })
  }
  const blocks: Array<VersionBlock> = []
  let cursor = 0
  let start = 0
  const trace = (end: number) => {
    if (end <= start) return
    const first = steps[start]!
    blocks.push({
      kind: "trace",
      id: `trace:${first.message}:${first.part}`,
      start,
      end,
      count: counted(steps.slice(start, end).map(({ step }) => step))
    })
  }
  for (const block of prose) {
    while (cursor < steps.length) {
      const step = steps[cursor]!
      if (step.message > block.message || (step.message === block.message && step.part >= block.part)) break
      cursor++
    }
    trace(cursor)
    blocks.push(block)
    const same = steps[cursor]
    if (same?.message === block.message && same.part === block.part && same.step.kind === "text") cursor++
    start = cursor
  }
  trace(steps.length)
  return blocks
}

/** Apply only coordinates that were actually presented as editable prose. */
export function editWorkshopBlocks(
  messages: Array<AgentMessage>,
  blocks: ReadonlyArray<VersionBlock>,
  edits: import("@dreamspan/shared/chatApi.ts").BlockEdits,
  source: string,
  target: string
) {
  const visible = new Map(blocks.flatMap((block) => (block.kind === "text" ? [[block.id, block] as const] : [])))
  const text = new Map<string, string>()
  let changedAt = messages.length
  for (const edit of edits) {
    const key = `text:${edit.message}:${edit.part}`
    const block = visible.get(key)
    if (!block || text.has(key)) return null
    text.set(key, edit.text)
    if (block.text === edit.text) continue
    const turn = messages[edit.message]
    if (turn?.role !== "assistant") return null
    const part = turn.content[edit.part]
    if (part?.type === "text") turn.content[edit.part] = { type: "text", text: edit.text }
    else if (part?.type === "toolCall" && part.name === SEND_MESSAGE)
      turn.content[edit.part] = { ...part, arguments: { ...part.arguments, message: edit.text } }
    else return null
    changedAt = Math.min(changedAt, edit.message)
  }
  for (const [i, message] of messages.entries()) {
    if (message.role === "assistant" && i >= changedAt) {
      message.content = message.content.map((part) => {
        if (part.type === "thinking") {
          const { thinkingSignature: _signature, ...plain } = part
          return plain
        }
        if (part.type === "text") return { type: "text", text: part.text }
        const { thoughtSignature: _signature, ...call } = part
        return call
      })
    }
    if (source === target) continue
    if (message.role === "rpPosted" && message.versionId === source)
      messages[i] = { ...message, versionId: target as typeof message.versionId }
    if (message.role === "toolResult" && message.toolName === SEND_MESSAGE) {
      const details = message.details as { versionId?: string } | null
      if (details?.versionId === source) messages[i] = { ...message, details: { ...details, versionId: target } }
    }
  }
  return blocks.map((block) => (block.kind === "text" ? { ...block, text: text.get(block.id) ?? block.text } : block))
}
