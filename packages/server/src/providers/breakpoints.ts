// Explicit cache breakpoints (spec/PROVIDERS.md §8). The caller names messages of the
// Context it built; this places `cache_control` markers on the wire messages pi-ai
// produced for them, in its onPayload hook.
//
// reference-harness found boundaries by searching the wire text for known tags. Here the
// positions come from the caller, and the wire message for each is found by aligning the
// transcript with the payload in order, by role and text. pi-ai keeps user, assistant
// and tool-result messages in order, but drops empty ones and merges consecutive tool
// results, so a plain index mapping would break.
import type { Message } from "@earendil-works/pi-ai"
import { Predicate } from "effect"

/** Anthropic accepts at most four cache_control markers per request. */
const MAX_ANTHROPIC_BREAKPOINTS = 4

type Block = Record<string, unknown>
type WireMessage = { role: string; content: string | Array<Block> }

const textOf = (message: Message): string => {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
  }
  if (message.role === "assistant") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
  }
  if (message.role === "toolResult") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
  }
  return ""
}

const wireText = (message: WireMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((block) => {
          if (Predicate.isString(block.text)) return block.text
          // Tool results nest their text one level down.
          if (Array.isArray(block.content)) {
            return (block.content as Array<Block>)
              .map((inner) => (Predicate.isString(inner.text) ? inner.text : ""))
              .join("")
          }
          return Predicate.isString(block.content) ? block.content : ""
        })
        .join("")

const wireRole = (message: Message) => (message.role === "assistant" ? "assistant" : "user")

/**
 * For each transcript message, the index of the wire message carrying it, or null if
 * pi-ai dropped it. Matching is in order: a message maps to the next wire message of its
 * role whose text contains its text, so merged tool results share one wire message.
 */
export const alignTranscript = (
  transcript: ReadonlyArray<Message>,
  wire: ReadonlyArray<WireMessage>
): Array<number | null> => {
  const result: Array<number | null> = []
  let cursor = 0
  for (const message of transcript) {
    if (message.role === "system") {
      result.push(null)
      continue
    }
    const text = textOf(message).trim()
    // pi-ai drops user messages with nothing to send.
    const hasImage =
      message.role === "user" && typeof message.content !== "string" && message.content.some((b) => b.type === "image")
    if (message.role === "user" && text === "" && !hasImage) {
      result.push(null)
      continue
    }
    let found: number | null = null
    // A merged tool result stays on the wire message the previous one matched.
    for (let i = Math.max(0, cursor - (message.role === "toolResult" ? 1 : 0)); i < wire.length; i++) {
      const candidate = wire[i]!
      if (candidate.role !== wireRole(message)) continue
      if (text === "" || wireText(candidate).includes(text)) {
        found = i
        break
      }
    }
    result.push(found)
    if (found !== null) cursor = found + 1
  }
  return result
}

const countMarkers = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce<number>((n, item) => n + countMarkers(item), 0)
  if (!Predicate.isObject(value)) return 0
  const record = value as Record<string, unknown>
  return (record.cache_control ? 1 : 0) + Object.values(record).reduce<number>((n, v) => n + countMarkers(v), 0)
}

const firstMarker = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstMarker(item)
      if (found) return found
    }
    return undefined
  }
  if (!Predicate.isObject(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.cache_control) return record.cache_control
  for (const v of Object.values(record)) {
    const found = firstMarker(v)
    if (found) return found
  }
  return undefined
}

/**
 * Adds markers for `breakpoints` (indices into the transcript, most important first) to
 * an Anthropic Messages payload, in place. Reuses pi-ai's own marker so TTLs match,
 * adds nothing when pi placed none (caching off), and stops at Anthropic's limit.
 * Returns the transcript indices that got a marker.
 */
export const applyAnthropicBreakpoints = (
  payload: Record<string, unknown>,
  transcript: ReadonlyArray<Message>,
  breakpoints: ReadonlyArray<number>
): Array<number> => {
  const marker = firstMarker(payload)
  if (!marker || !Array.isArray(payload.messages)) return []
  const wire = payload.messages as Array<WireMessage>
  const aligned = alignTranscript(transcript, wire)
  let budget = MAX_ANTHROPIC_BREAKPOINTS - countMarkers(payload)
  const placed: Array<number> = []
  for (const index of breakpoints) {
    if (budget <= 0) break
    const target = aligned[index]
    if (target === null || target === undefined) continue
    const message = wire[target]!
    if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }]
    // Thinking blocks can't carry a marker; the last cacheable block covers the message.
    const last = message.content.findLast((block) => !String(block.type).includes("thinking"))
    if (!last || last.cache_control) continue
    last.cache_control = marker
    budget--
    placed.push(index)
  }
  return placed
}
