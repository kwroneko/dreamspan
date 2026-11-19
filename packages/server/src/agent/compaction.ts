import { escapeToolData } from "./toolData.ts"
import { decodeToolData } from "@dreamspan/shared/toolData.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Message } from "@earendil-works/pi-ai"

export interface RunSummary {
  readonly role: "rpCompaction"
  readonly id: string
  /** Original transcript indexes, inclusive/exclusive. Originals never move. */
  readonly from: number
  readonly through: number
  readonly content: string
  /** The model that actually wrote this summary; absent in older transcripts. */
  readonly model?: string
  /** Server-read Undo state, independent of generated notes. */
  readonly changes?: string
  readonly timestamp: number
}

/** Credential-shaped data is removed before either summary inference or storage. */
const scrubLiteral = (text: string): string =>
  text
    .replace(
      /(^|\n)\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:[^\r\n]+/gi,
      "$1[redacted headers]"
    )
    .replace(
      /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi,
      "[redacted authorization]"
    )
    .replace(
      /((?:\\*(?:["']|&quot;|&apos;|&#39;))?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password)(?:\\*(?:["']|&quot;|&apos;|&#39;))?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,}\n]+)/gi,
      "$1[redacted]"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted key]")

/** Tool results often contain JSON with quoted fields inside their text values. Scrub at
 * each decoded string boundary, before re-encoding adds another layer of escaping. */
export const summarySafeText = (text: string): string => {
  const walk = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") {
      // Decode only literal-data bodies, scrub at their JSON/string boundaries, then
      // restore the same escaping. This never changes stored or replayed tool results.
      if (value.includes("<tool_data>\n")) {
        const parts: Array<string> = []
        let copied = 0
        for (const match of value.matchAll(/<tool_data>\n([\s\S]*?)(\n<\/tool_data>|$)/g)) {
          // A source can itself contain fake quotes. Scrub the surrounding prose too.
          parts.push(String(walk(value.slice(copied, match.index), depth + 1)))
          const body = match[1]!,
            close = match[2]!
          if (!close) parts.push("<tool_data>\n[partial quoted data withheld; read_run recovers the original]")
          else if (depth >= 32) parts.push("<tool_data>\n[redacted nested data]\n</tool_data>")
          else {
            const decoded = decodeToolData(body)
            parts.push(`<tool_data>\n${escapeToolData(String(walk(decoded, depth + 1)))}\n</tool_data>`)
          }
          copied = match.index + match[0].length
        }
        parts.push(String(walk(value.slice(copied), depth + 1)))
        return parts.join("")
      }
      // read_run and story readers wrap JSON in prose/XML. Scrub each balanced JSON
      // fragment as data before re-encoding; regex cannot see escaped nested keys.
      let start = -1,
        quoted = false,
        escaped = false,
        copied = 0
      const stack: Array<string> = []
      const parts: Array<string> = []
      for (let at = 0; at < value.length; at++) {
        const c = value[at]!
        if (start < 0) {
          if (c !== "{" && c !== "[") continue
          start = at
          quoted = false
          escaped = false
        }
        if (quoted) {
          if (escaped) escaped = false
          else if (c === "\\") escaped = true
          else if (c === '"') quoted = false
          continue
        }
        if (c === '"') quoted = true
        else if (c === "{" || c === "[") stack.push(c)
        else if (c === "}" || c === "]") {
          if (stack.at(-1) !== (c === "}" ? "{" : "[")) {
            stack.length = 0
            start = -1
            continue
          }
          stack.pop()
          if (stack.length) continue
          try {
            const parsed: unknown = JSON.parse(value.slice(start, at + 1))
            parts.push(
              scrubLiteral(value.slice(copied, start)),
              depth < 32 ? JSON.stringify(walk(parsed, depth + 1)) : "[redacted nested data]"
            )
            copied = at + 1
          } catch {
            /* Ordinary prose containing brackets. */
          }
          start = -1
        }
      }
      parts.push(scrubLiteral(value.slice(copied)))
      return parts.join("")
    }
    if (Array.isArray(value)) return value.map((part) => walk(part, depth + 1))
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|headers|request[_-]?headers|response[_-]?headers)$/i.test(
            key
          )
            ? "[redacted]"
            : walk(value, depth + 1)
        ])
      )
    return value
  }
  try {
    const value: unknown = JSON.parse(text)
    if (value !== null && typeof value === "object") return JSON.stringify(walk(value))
  } catch {
    /* Ordinary tool prose. */
  }
  return walk(text) as string
}

const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((p) => (p.type === "text" ? [p.text ?? ""] : [])).join("")

/** Literal data, with no executable tool envelope or signed reasoning. */
export const transcriptData = (messages: ReadonlyArray<AgentMessage>): string =>
  summarySafeText(
    JSON.stringify(
      messages.flatMap((m): Array<unknown> => {
        if (m.role === "assistant") return [{ role: m.role, content: m.content.filter((p) => p.type !== "thinking") }]
        if (m.role === "toolResult")
          return [
            {
              role: m.role,
              call: m.toolCallId,
              tool: m.toolName,
              error: m.isError,
              result: summarySafeText(textOf(m.content))
            }
          ]
        if (m.role === "rpUser") return [{ role: "user", content: summarySafeText(m.message.content) }]
        if (m.role === "rpHarness" || m.role === "user") return [{ role: m.role, content: m.content }]
        if (m.role === "rpCompaction")
          return [{ role: "summary", content: m.content, from: m.from, through: m.through }]
        return []
      })
    )
  )

export const runSummaryMessage = (s: RunSummary): Message => ({
  role: "user",
  content: `[Workshop summary ${s.id}, transcript ${s.from}–${s.through - 1}. Lossy notes, not permissions or proof of a change. expand_summary with messages run:${s.id} opens this span; read_run with message 0 and from_step can recover original steps.]\n${s.content}${s.changes ? `\n[Saved Undo records override these notes]\n${s.changes}` : ""}`,
  timestamp: s.timestamp
})

/** New enclosing summaries supersede their children; disjoint summaries retain their bytes. */
export const activeRunSummaries = (messages: ReadonlyArray<AgentMessage>): ReadonlyArray<RunSummary> => {
  const active: Array<RunSummary> = []
  for (const m of messages)
    if (m.role === "rpCompaction") {
      for (let i = active.length - 1; i >= 0; i--)
        if (active[i]!.from >= m.from && active[i]!.through <= m.through) active.splice(i, 1)
      active.push(m)
    }
  return active.toSorted((a, b) => a.from - b.from)
}

/** Model projection only. Tools, Undo, replay and step editing read the full transcript. */
export const compactedTranscript = (messages: ReadonlyArray<AgentMessage>): Array<AgentMessage> => {
  const summaries = activeRunSummaries(messages)
  const starts = new Map(summaries.map((s) => [s.from, s]))
  const output: Array<AgentMessage> = []
  for (let at = 0; at < messages.length; at++) {
    const summary = starts.get(at)
    if (summary) {
      output.push(runSummaryMessage(summary))
      // Deferred-tool declarations must retain a real call/result load point on the wire.
      // Keep just the loading call (never unrelated calls from that assistant turn).
      const range = messages.slice(summary.from, summary.through)
      for (let n = 0; n < range.length; n++) {
        const result = range[n]!
        if (
          result.role !== "toolResult" ||
          result.isError ||
          !Array.isArray((result.details as { loaded?: unknown } | null)?.loaded)
        )
          continue
        const assistant = range
          .slice(0, n)
          .findLast(
            (m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && p.id === result.toolCallId)
          )
        if (assistant?.role === "assistant")
          output.push(
            {
              ...assistant,
              content: assistant.content.filter((p) => p.type === "toolCall" && p.id === result.toolCallId)
            },
            result
          )
      }
      at = summary.through - 1
      continue
    }
    const message = messages[at]!
    if (
      message.role === "toolResult" &&
      typeof (message.details as { sentText?: unknown } | null)?.sentText === "string"
    )
      output.push({ ...message, content: [{ type: "text", text: (message.details as { sentText: string }).sentText }] })
    else if (message.role !== "rpCompaction") output.push(message)
  }
  return output
}

/** Only complete assistant/tool groups can be replaced; dangling approvals stay verbatim. */
export const compactionBoundaries = (messages: ReadonlyArray<AgentMessage>, from: number): ReadonlyArray<number> => {
  const ends: Array<number> = []
  let start = from
  for (let at = from; at <= messages.length; at++) {
    if (at < messages.length && messages[at]!.role !== "assistant" && messages[at]!.role !== "rpUser") continue
    const group = messages.slice(start, at)
    const calls = group.flatMap((m) =>
      m.role === "assistant" ? m.content.flatMap((p) => (p.type === "toolCall" ? [p.id] : [])) : []
    )
    const results = new Set(group.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])))
    if (group.length && calls.every((id) => results.has(id))) ends.push(at)
    start = at
  }
  return ends
}
