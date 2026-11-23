import { claudeThinkingDefaults, claudeThinkingForm } from "./claudeThinking.ts"
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode"
// Signed thinking is replayed only with its original request prefix. This runs after every
// wire transform, so compaction, loading, Resume and plugin definitions share one guard.
// Cache markers are ignored only at the API's marker positions, never inside tool data.
import { createHash } from "node:crypto"
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared"
import {
  normalizeContext,
  type Api,
  type Model as PiModel,
  type AssistantMessage,
  type Message
} from "@earendil-works/pi-ai"
import type { RequestTarget } from "./registry.ts"

/** What an assistant turn with signed blocks records about the request that produced it. */
export interface ThinkingRecord {
  /** Digest of the request it answered: system, tools and messages, thinking and cache markers left out. */
  readonly prefix: string
  /** Key of the last signed block that request carried; null when it carried none. */
  readonly prev: string | null
  readonly connectionId: string
  readonly modelId: string
  /** Non-secret digest of the transport identity, including credentials and address. */
  readonly connectionStamp?: string
  /** Per-item prefixes when a response has separate reasoning and output items. */
  readonly prefixes?: Readonly<Record<string, string>>
}

/** An assistant turn as the provider layer returns it: with its record when it carries signed blocks. */
export type RecordedAssistant = AssistantMessage & { readonly thinkingRecord?: ThinkingRecord }

/** A wire format's signed reasoning: where it sits in the payload, and how to leave it out. */
export interface ThinkingBinding {
  readonly id: string
  /** Keep declarations at the turn cap and forbid calls with these wire fields. */
  readonly modelDefaults?: (key: string) => ReturnType<typeof claudeThinkingDefaults>
  readonly deferHiddenThinking?: (key: string) => boolean
  readonly finalRequest?: Readonly<Record<string, unknown>>
  readonly appliesTo: (target: RequestTarget) => boolean
  /** The payload's conversation messages, in order. */
  readonly messages: (payload: Record<string, unknown>) => ReadonlyArray<unknown> | null
  /**
   * The payload with its messages replaced (some signed blocks left out). `history`: they were
   * earlier replies' reasoning in a plain chat, not a tool turn's, so the request's own settings stay.
   */
  readonly withMessages: (
    payload: Record<string, unknown>,
    messages: ReadonlyArray<unknown>,
    options?: { readonly history?: boolean }
  ) => Record<string, unknown>
  /** What the conversation is bound to besides its messages (system prompt, tools), comparable. */
  readonly head: (payload: Record<string, unknown>) => unknown
  /** The signed blocks' identities in a payload message, in order; empty for none. */
  readonly signed: (message: unknown) => ReadonlyArray<string>
  /** The message as the binding compares it: signed reasoning left out. */
  readonly comparable: (message: unknown) => unknown
  /** The message without its signed reasoning; null when nothing else is left in it. */
  readonly strip: (message: unknown, keys?: ReadonlySet<string>) => unknown
  /** The signed blocks' identities a pi assistant message will carry on this wire. */
  readonly piSigned: (message: AssistantMessage) => ReadonlyArray<string>
  readonly before?: (message: unknown, key: string) => unknown | null
  readonly reply?: (message: AssistantMessage, model: PiModel<Api>) => ReadonlyArray<unknown>
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Preserve JSON data ordering; API markers are removed only by the binding's projections. */
const stable = (value: unknown): string => JSON.stringify(value) ?? "null"

/** A short identity for a signature (signatures run to kilobytes). */
const keyOf = (signature: string) => createHash("sha256").update(signature).digest("hex").slice(0, 32)

/** Remove a marker only on a content block, retaining identically named tool arguments. */
const unmarked = (value: unknown): unknown => {
  const block = object(value)
  if (!block) return value
  const { cache_control: _marker, ...rest } = block
  return block.type === "tool_result" && Array.isArray(block.content)
    ? { ...rest, content: block.content.map(unmarked) }
    : rest
}

/** Normalize only cache metadata in a wire message's content blocks. */
const messageWithoutMarkers = (value: unknown, block: (value: unknown) => unknown): unknown => {
  const message = object(value)
  return message && Array.isArray(message.content) ? { ...message, content: message.content.map(block) } : value
}
const responseBlockWithoutMarker = (value: unknown): unknown => {
  const block = object(value)
  if (!block) return value
  const { prompt_cache_breakpoint: _marker, ...rest } = block
  return rest
}

// Anthropic Messages (direct, Amazon Bedrock, Google Vertex and proxies that speak it).
const SIGNED_BLOCKS = new Set(["thinking", "redacted_thinking"])
const anthropicSignature = (block: Record<string, unknown>) =>
  block.type === "redacted_thinking"
    ? typeof block.data === "string"
      ? block.data
      : undefined
    : typeof block.signature === "string" && block.signature.trim() !== ""
      ? block.signature
      : undefined
const blocksOf = (message: unknown) => {
  const content = object(message)?.content
  return Array.isArray(content) ? content : null
}

export const anthropicBinding: ThinkingBinding = {
  id: "anthropic-messages",
  modelDefaults: (key) => claudeThinkingDefaults("anthropic-messages", key),
  deferHiddenThinking: (key) => /claude-/i.test(key) && claudeThinkingForm(key) === null,
  finalRequest: { tool_choice: { type: "none" } },
  appliesTo: (target) => target.api === "anthropic-messages",
  messages: (payload) => (Array.isArray(payload.messages) ? payload.messages : null),
  withMessages: (payload, messages, options) => ({
    ...payload,
    messages: [...messages],
    // A tool turn left without its thinking can't go on with manual thinking; a plain chat's
    // earlier replies don't bind this reply's thinking.
    ...(object(payload.thinking)?.type === "enabled" && !options?.history ? { thinking: { type: "disabled" } } : {})
  }),
  head: (payload) => ({
    model: payload.model,
    system: Array.isArray(payload.system) ? payload.system.map(unmarked) : (payload.system ?? null),
    tools: Array.isArray(payload.tools) ? payload.tools.map(unmarked) : []
  }),
  signed: (message) => {
    if (object(message)?.role !== "assistant") return []
    return (blocksOf(message) ?? []).flatMap((block) => {
      const record = object(block)
      if (!record || !SIGNED_BLOCKS.has(String(record.type))) return []
      const signature = anthropicSignature(record)
      return signature === undefined ? [] : [keyOf(signature)]
    })
  },
  comparable: (message) => {
    const record = object(message)
    const content = record?.content
    if (!record) return message
    return {
      role: record.role,
      content:
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((block) => !SIGNED_BLOCKS.has(String(object(block)?.type))).map(unmarked)
            : content
    }
  },
  strip: (message, keys) => {
    const blocks = blocksOf(message)
    if (blocks === null) return message
    const kept = blocks.filter((block) => {
      const part = object(block)
      if (!part || !SIGNED_BLOCKS.has(String(part.type))) return true
      const signature = anthropicSignature(part)
      return keys !== undefined && signature !== undefined && !keys.has(keyOf(signature))
    })
    return kept.length === blocks.length ? message : kept.length === 0 ? null : { ...object(message), content: kept }
  },
  before: (message, key) => {
    const before: Array<unknown> = []
    for (const value of blocksOf(message) ?? []) {
      const block = object(value)
      if (block && SIGNED_BLOCKS.has(String(block.type))) {
        const signature = anthropicSignature(block)
        if (signature && keyOf(signature) === key) break
      } else before.push(unmarked(value))
    }
    return before.length ? before : null
  },
  reply: (message) => [
    {
      role: "assistant",
      content: message.content.flatMap((part): Array<unknown> => {
        if (part.type === "thinking")
          return [
            part.redacted
              ? { type: "redacted_thinking", data: part.thinkingSignature }
              : { type: "thinking", thinking: part.thinking, signature: part.thinkingSignature }
          ]
        if (part.type === "text") return part.text.trim() ? [{ type: "text", text: sanitizeSurrogates(part.text) }] : []
        return [{ type: "tool_use", id: part.id, name: part.name, input: part.arguments ?? {} }]
      })
    }
  ],
  piSigned: (message) =>
    message.content.flatMap((part) =>
      part.type === "thinking" && part.thinkingSignature && part.thinkingSignature.trim() !== ""
        ? [keyOf(part.thinkingSignature)]
        : []
    )
}

// Claude through OpenRouter's Chat Completions: the signed blocks travel as `reasoning_details`
// and reach Anthropic as thinking blocks, so the same rule applies. Other models' details (Gemini
// thought signatures, required on a tool loop's turn) are left alone.
const ROUTER_REASONING = ["reasoning_details", "reasoning", "reasoning_content"]
const detailsKey = (details: unknown) =>
  Array.isArray(details) && details.length > 0 ? keyOf(stable(details)) : undefined
const parsedDetails = (signature: string | undefined) => {
  if (!signature) return undefined
  try {
    const parsed: unknown = JSON.parse(signature)
    return Array.isArray(parsed) && parsed.length ? parsed : undefined
  } catch {
    return undefined
  }
}

export const openRouterClaudeBinding: ThinkingBinding = {
  id: "openrouter-claude",
  deferHiddenThinking: (key) => /claude-/i.test(key) && claudeThinkingForm(key) === null,
  appliesTo: (target) => target.api === "openai-completions" && /(?:^anthropic\/|claude-)/i.test(target.model ?? ""),
  messages: (payload) =>
    Array.isArray(payload.messages)
      ? payload.messages.filter((m) => !["system", "developer"].includes(String(object(m)?.role)))
      : null,
  withMessages: (payload, messages) => {
    const all = Array.isArray(payload.messages) ? payload.messages : []
    return {
      ...payload,
      messages: [...all.filter((m) => ["system", "developer"].includes(String(object(m)?.role))), ...messages]
    }
  },
  head: (payload) => ({
    model: payload.model,
    system: (Array.isArray(payload.messages) ? payload.messages : [])
      .filter((m) => ["system", "developer"].includes(String(object(m)?.role)))
      .map((m) => messageWithoutMarkers(m, unmarked)),
    tools: Array.isArray(payload.tools) ? payload.tools.map(unmarked) : []
  }),
  signed: (message) => {
    const record = object(message)
    if (record?.role !== "assistant") return []
    const key = detailsKey(record.reasoning_details)
    return key === undefined ? [] : [key]
  },
  comparable: (message) => {
    const record = object(message)
    if (!record) return message
    return messageWithoutMarkers(
      Object.fromEntries(Object.entries(record).filter(([key]) => !ROUTER_REASONING.includes(key))),
      unmarked
    )
  },
  strip: (message) => {
    const record = object(message)
    if (!record || !ROUTER_REASONING.some((key) => Object.hasOwn(record, key))) return message
    return Object.fromEntries(Object.entries(record).filter(([key]) => !ROUTER_REASONING.includes(key)))
  },
  piSigned: (message) => {
    // The wire sends the first part's parsable details (agent/wire.ts `completionsMessage`).
    const details = message.content
      .flatMap((part) => (part.type === "thinking" ? [parsedDetails(part.thinkingSignature)] : []))
      .find((d) => d !== undefined)
    const key = detailsKey(details)
    return key === undefined ? [] : [key]
  }
}

const reasoningItem = (value: unknown) => {
  const item = object(value)
  return item?.type === "reasoning" && typeof item.encrypted_content === "string" ? item : undefined
}

/** Responses binds instructions, tools, output format, effort and the preceding input items. */
export const responsesBinding: ThinkingBinding = {
  id: "openai-responses",
  appliesTo: (target) => target.api === "openai-responses",
  messages: (payload) => (Array.isArray(payload.input) ? payload.input : null),
  withMessages: (payload, messages) => ({ ...payload, input: [...messages] }),
  head: (payload) => ({
    model: payload.model,
    instructions: payload.instructions ?? null,
    tools: payload.tools ?? [],
    text: payload.text ?? null,
    reasoning: payload.reasoning ?? null
  }),
  signed: (item) => {
    const reasoning = reasoningItem(item)
    return reasoning ? [keyOf(reasoning.encrypted_content as string)] : []
  },
  comparable: (item) => (reasoningItem(item) ? null : messageWithoutMarkers(item, responseBlockWithoutMarker)),
  strip: (item) => (object(item)?.type === "reasoning" ? null : item),
  piSigned: (message) =>
    message.content.flatMap((part) => {
      if (part.type !== "thinking" || !part.thinkingSignature) return []
      try {
        const item = reasoningItem(JSON.parse(part.thinkingSignature))
        return item ? [keyOf(item.encrypted_content as string)] : []
      } catch {
        return []
      }
    }),
  reply: (message, model) =>
    convertResponsesMessages(model, normalizeContext({ messages: [message] }), new Set([model.provider]))
}

export const builtinThinkingBindings: ReadonlyArray<ThinkingBinding> = [
  anthropicBinding,
  openRouterClaudeBinding,
  responsesBinding
]

/** Whether a payload carries signed reasoning on this wire. */
export const carriesSigned = (binding: ThinkingBinding, payload: Record<string, unknown>) =>
  (binding.messages(payload) ?? []).some((message) => binding.signed(message).length > 0)

/** Why signed blocks were left out of a request, for its notes (ARCHITECTURE §6). */
export type DropReason = "changed" | "model" | "refused"

export const DROP_NOTES: Record<DropReason, string> = {
  changed:
    "Thinking from earlier in this reply was left out, because something before it changed after it was written. The provider refuses it then.",
  model: "Thinking was left out because the model or connection changed.",
  refused: "The provider refused earlier thinking, so this request was sent again without it."
}

/** The same for earlier replies' reasoning a plain chat sends back (assembler/reasoningReplay.ts). */
export const HISTORY_DROP_NOTES: Record<DropReason, string> = {
  changed: "Reasoning from an earlier reply wasn't sent back: the request before it changed since it was written.",
  model: "Reasoning from an earlier reply wasn't sent back: another model or connection wrote it.",
  refused: "The provider refused earlier replies' reasoning, so this request was sent again without it."
}

/**
 * Marks a plain chat's earlier reply that carries its own reasoning (assembler/wire.ts): the
 * provider layer stamps it with the model it's sent to, so pi-ai keeps its blocks as blocks.
 * Whether they may go is the binding's check, as for a tool run's turns.
 */
export const HISTORY_REPLAY = "historyReplay"

const replayed = (message: Message) =>
  message.role === "assistant" && (message as unknown as Record<string, unknown>)[HISTORY_REPLAY] === true

/** Whether a context carries earlier replies' reasoning. */
export const carriesHistoryReplay = (messages: ReadonlyArray<Message>) => messages.some(replayed)

/** The context with its replayed replies stamped as this model's own. */
export const stampHistoryReplay = (messages: ReadonlyArray<Message>, model: PiModel<Api>): Array<Message> =>
  messages.map((message) =>
    replayed(message) ? ({ ...message, provider: model.provider, api: model.api, model: model.id } as Message) : message
  )

export interface BindResult {
  readonly payload: Record<string, unknown>
  /** Signed blocks left out. */
  readonly dropped: number
  readonly reason: DropReason | null
}

/**
 * The payload with every signed block the provider would refuse left out: `check` keeps a
 * block only while everything before it is what it was written after (and by the same model
 * and connection), from the first that isn't dropping it and all signed blocks after it; `strip`
 * leaves every signed block out (the retry after a refusal); `keep` sends them all.
 */
export const bindThinking = (
  binding: ThinkingBinding,
  payload: Record<string, unknown>,
  input: {
    readonly context: ReadonlyArray<Message>
    readonly connectionId: string
    readonly modelId: string
    readonly connectionStamp?: string
    readonly mode: "check" | "strip" | "keep"
    /** The signed blocks are a plain chat's earlier replies' (HISTORY_REPLAY): the request's settings stay. */
    readonly history?: boolean
  }
): BindResult => {
  const messages = binding.messages(payload)
  if (
    messages === null ||
    input.mode === "keep" ||
    (input.mode !== "strip" && !messages.some((m) => binding.signed(m).length > 0))
  )
    return { payload, dropped: 0, reason: null }
  const records = new Map<string, ThinkingRecord>()
  for (const message of input.context) {
    if (message.role !== "assistant") continue
    const record = (message as RecordedAssistant).thinkingRecord
    if (record === undefined) continue
    for (const key of binding.piSigned(message)) records.set(key, record)
  }
  const hash = createHash("sha256").update(stable(binding.head(payload)))
  const out: Array<unknown> = []
  let dropping = input.mode === "strip"
  let reason: DropReason | null = input.mode === "strip" ? "refused" : null
  let dropped = 0
  for (const message of messages) {
    const keys = binding.signed(message)
    if (input.mode === "strip") {
      const stripped = binding.strip(message)
      dropped += keys.length || (stripped !== message ? 1 : 0)
      if (stripped !== null) out.push(stripped)
      continue
    }
    const leaving = new Set<string>()
    for (const key of keys) {
      const record = records.get(key)
      const written =
        record !== undefined &&
        record.connectionId === input.connectionId &&
        record.modelId === input.modelId &&
        record.connectionStamp === input.connectionStamp
      const prefix = hash.copy()
      const before = binding.before?.(message, key)
      if (before != null) prefix.update(stable(before))
      if (!dropping && (!written || (record.prefixes?.[key] ?? record.prefix) !== prefix.digest("hex"))) {
        dropping = true
        reason = record !== undefined && !written ? "model" : "changed"
      }
      if (dropping) leaving.add(key)
    }
    const comparable = binding.comparable(message)
    if (comparable !== null) hash.update(stable(comparable))
    if (leaving.size > 0) {
      dropped += leaving.size
      const stripped = binding.strip(message, leaving)
      if (stripped !== null) out.push(stripped)
    } else out.push(message)
  }
  return dropped === 0
    ? { payload, dropped: 0, reason: null }
    : { payload: binding.withMessages(payload, out, { history: input.history === true }), dropped, reason }
}

/** The record for a turn that answered `sent` (the payload as it went out, after `bindThinking`). */
export const thinkingRecord = (
  binding: ThinkingBinding,
  sent: Record<string, unknown>,
  written: { readonly connectionId: string; readonly modelId: string; readonly connectionStamp?: string },
  reply?: ReadonlyArray<unknown>
): ThinkingRecord => {
  const messages = binding.messages(sent) ?? []
  const hash = createHash("sha256").update(stable(binding.head(sent)))
  let prev: string | null = null
  for (const message of messages) {
    const comparable = binding.comparable(message)
    if (comparable !== null) hash.update(stable(comparable))
    prev = binding.signed(message).at(-1) ?? prev
  }
  const prefix = hash.copy().digest("hex")
  const prefixes: Record<string, string> = {}
  for (const item of reply ?? []) {
    for (const key of binding.signed(item)) {
      const prefix = hash.copy()
      const before = binding.before?.(item, key)
      if (before != null) prefix.update(stable(before))
      prefixes[key] = prefix.digest("hex")
    }
    const comparable = binding.comparable(item)
    if (comparable !== null) hash.update(stable(comparable))
  }
  return { prefix, prev, ...written, ...(reply ? { prefixes } : {}) }
}

/** Whether a turn came back with signed reasoning this wire sends back. */
export const signsReasoning = (binding: ThinkingBinding, message: AssistantMessage) =>
  binding.piSigned(message).length > 0

/** Only the measured prefix-binding 400, before any output, permits one stripped retry. */
export const refusesSigned = (error: {
  readonly status: number | null
  readonly message: string
  readonly afterTokens?: boolean
}) =>
  error.status === 400 &&
  !error.afterTokens &&
  /Invalid `signature` in `(?:redacted_)?thinking` block\. The block is bound to a different conversation\./.test(
    error.message
  )
