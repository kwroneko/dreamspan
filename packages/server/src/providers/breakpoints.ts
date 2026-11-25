// Explicit cache breakpoints (spec/PROVIDERS.md §8). The caller names messages of the
// Context it built; this places `cache_control` markers on the wire messages pi-ai
// produced for them, in its onPayload hook.
//
// reference-harness found boundaries by searching the wire text for known tags. Here the
// positions come from the caller, and the wire message for each is found by aligning the
// transcript with the payload in order, by role and text. pi-ai keeps user, assistant
// and tool-result messages in order, but drops empty ones and merges consecutive tool
// results, so a plain index mapping would break.
import { type CacheLayout, pinnedRoute } from "@dreamspan/shared/providers.ts"
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
  breakpoints: ReadonlyArray<number>,
  capabilities: CacheLayout = {},
  preserve = false
): Array<number> => {
  const marker = firstMarker(payload)
  if (!marker || !Array.isArray(payload.messages)) return []
  const wire = payload.messages as Array<WireMessage>
  const aligned = alignTranscript(transcript, wire)
  // A carried run prioritizes the markers already present in its previous request.
  // pi-ai's automatic new tail would otherwise take one of their four places.
  if (preserve)
    for (const message of wire)
      if (Array.isArray(message.content)) for (const block of message.content) delete block.cache_control
  let budget = Math.min(MAX_ANTHROPIC_BREAKPOINTS, capabilities.maxMarkers ?? 4) - countMarkers(payload)
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

// Only actual wire content blocks count, never similarly named tool-schema properties.
const bedrockMarkers = (messages: ReadonlyArray<WireMessage>): number =>
  messages.reduce(
    (n, message) =>
      n +
      (Array.isArray(message.content)
        ? message.content.filter((block) => {
            const control = block.prompt_cache_breakpoint
            return Predicate.isObject(control) && control.mode === "explicit"
          }).length
        : 0),
    0
  )

/** Bedrock OpenAI-compatible checkpoints; explicit callers opt into this wire extension. */
export const applyBedrockBreakpoints = (
  payload: Record<string, unknown>,
  transcript: ReadonlyArray<Message>,
  breakpoints: ReadonlyArray<number>,
  responses: boolean,
  capabilities: CacheLayout = {}
): void => {
  const items = responses ? payload.input : payload.messages
  if (!Array.isArray(items) || breakpoints.length === 0) return
  const wire = items as Array<WireMessage>
  const textType = responses ? "input_text" : "text"
  const normalized = wire.map((m) => ({
    ...m,
    content: typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => ({ ...b, text: b.text }))
  }))
  // Chat payload is already in assembly order. Responses is converted by pi-ai.
  const aligned = responses ? alignTranscript(transcript, normalized) : transcript.map((_, i) => i)
  const cumulative: number[] = []
  let tokens = 0
  for (const item of normalized) {
    tokens += Math.ceil(wireText(item).length / 4)
    cumulative.push(tokens)
  }
  const prefix = wire.findLastIndex(
    (m, i) =>
      (m.role === "developer" || m.role === "system") &&
      wire.slice(0, i).every((p) => p.role === "developer" || p.role === "system")
  )
  const targets = [...breakpoints.flatMap((b) => (aligned[b] == null ? [] : [aligned[b]!])), prefix]
  // Responses reserves an automatic endpoint. Explicit-only Chat needs its own final marker.
  const limit = responses ? Math.min(4, capabilities.maxMarkers ?? 4) : (capabilities.maxMarkers ?? 4)
  let budget = limit - (responses ? 1 : 0) - bedrockMarkers(wire)
  const mark = (index: number) => {
    if (budget <= 0 || index < 0 || (cumulative[index] ?? 0) < (capabilities.minTokens ?? 1024)) return
    const item = wire[index]!
    if (typeof item.content === "string") item.content = [{ type: textType, text: item.content }]
    const last = item.content?.findLast((b) => b.type === textType)
    if (!last || last.prompt_cache_breakpoint) return
    last.prompt_cache_breakpoint = { mode: "explicit" }
    budget--
  }
  if (!responses) mark(wire.length - 1)
  for (const index of targets) mark(index)
}

const unmark = (message: WireMessage) => {
  if (typeof message.content === "string") return
  for (const block of message.content) delete block.cache_control
}

/**
 * The automatic layout on Anthropic Messages: pi-ai marks the request's last message, which is
 * the end-of-request instruction (or a prefill) the next request no longer has, so history would
 * never read back. Its marker moves to the assembly's endpoint, the last message the next request
 * repeats; a tool loop's messages after the assembly keep theirs, which the loop's next request
 * repeats. Reuses pi-ai's marker (and TTL); nothing is added when pi placed none.
 */
export const applyAnthropicStableEndpoint = (
  payload: Record<string, unknown>,
  transcript: ReadonlyArray<Message>,
  stable: { readonly message: number; readonly end: number },
  capabilities: CacheLayout = {}
): boolean => {
  const marker = firstMarker(payload)
  if (!marker || !Array.isArray(payload.messages)) return false
  const wire = payload.messages as Array<WireMessage>
  const aligned = alignTranscript(transcript, wire)
  const target = aligned[stable.message]
  if (target === null || target === undefined) return false
  for (let i = stable.message + 1; i < Math.min(stable.end, transcript.length); i++) {
    const at = aligned[i]
    if (at !== null && at !== undefined && at !== target) unmark(wire[at]!)
  }
  const message = wire[target]!
  if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }]
  const last = message.content.findLast((block) => !String(block.type).includes("thinking"))
  if (!last) return false
  if (last.cache_control) return true
  if (Math.min(MAX_ANTHROPIC_BREAKPOINTS, capabilities.maxMarkers ?? 4) - countMarkers(payload) <= 0) return false
  last.cache_control = marker
  return true
}

/** Which OpenRouter models take Chat Completions content-block markers. */
type RouterCacheFamily = "anthropic" | "gemini" | "alibaba"

export const routerCacheFamily = (
  model: string | undefined,
  routing?: Record<string, unknown>
): RouterCacheFamily | null => {
  if (!model) return null
  const key = model.split(":", 1)[0]!
  if (/^anthropic\/claude/i.test(key)) return "anthropic"
  if (/^google\/gemini/i.test(key)) return "gemini"
  const pin = pinnedRoute(routing)
  if (
    (pin === null || pin === "alibaba") &&
    /^qwen\/(?:qwen-plus|qwen3-(?:max|coder-plus|coder-flash)|qwen3\.(?:[6-9]|[1-9]\d+)-(?:plus|max))$/i.test(key)
  )
    return "alibaba"
  if (pin === "alibaba" && key === "deepseek/deepseek-v3.2") return "alibaba"
  return null
}

const markText = (message: WireMessage, marker: Record<string, unknown>) => {
  if (typeof message.content === "string") {
    if (message.content.length === 0) return false
    message.content = [{ type: "text", text: message.content }]
  }
  if (!Array.isArray(message.content)) return false
  const last = message.content.findLast((block) => block.type === "text")
  if (!last) return false
  if (!last.cache_control) last.cache_control = marker
  return true
}

/**
 * OpenRouter's `cache_control` markers on a Chat Completions payload whose messages the assembler
 * set (replacing the ones pi-ai marked), in assembly order. Claude
 * (https://openrouter.ai/docs/guides/best-practices/prompt-caching): the system message, then the
 * explicit breakpoints or the automatic layout's endpoint, within Anthropic's four markers.
 * Gemini and Alibaba use one deepest marker.
 */
export const applyRouterCacheControl = (
  payload: Record<string, unknown>,
  family: RouterCacheFamily,
  request: {
    readonly breakpoints: ReadonlyArray<number>
    readonly stable?: { readonly message: number; readonly end: number } | undefined
    readonly cacheRetention?: "none" | "short" | "long" | undefined
    readonly cacheLayout?: CacheLayout | undefined
  }
): void => {
  // A top-level control (set by the model's payload fields) picks OpenRouter's automatic placement.
  if (request.cacheRetention === "none" || !Array.isArray(payload.messages) || payload.cache_control !== undefined)
    return
  const wire = payload.messages as Array<WireMessage>
  const { stable } = request
  const targets =
    request.breakpoints.length > 0
      ? [...request.breakpoints]
      : stable
        ? [stable.message, ...(wire.length > stable.end ? [wire.length - 1] : [])]
        : []
  if (targets.length === 0) return
  if (family !== "anthropic") {
    const deepest = wire[Math.max(...targets)]
    if (deepest) markText(deepest, { type: "ephemeral" })
    return
  }
  const marker = { type: "ephemeral", ...(request.cacheRetention === "long" ? { ttl: "1h" } : {}) }
  let budget = Math.min(MAX_ANTHROPIC_BREAKPOINTS, request.cacheLayout?.maxMarkers ?? 4) - countMarkers(payload)
  const system = wire.findIndex((m) => m.role === "system" || m.role === "developer")
  for (const index of [...(system >= 0 ? [system] : []), ...targets]) {
    if (budget <= 0) break
    const message = wire[index]
    if (!message || countMarkers(message) > 0) continue
    if (markText(message, marker)) budget--
  }
}
