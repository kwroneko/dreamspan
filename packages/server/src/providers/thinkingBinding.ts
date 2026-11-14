// Signed thinking goes back only into the conversation that produced it (ARCHITECTURE §6
// "Signed thinking"). Anthropic binds each signed thinking block to the request it was written
// for: the system prompt, the set of tools and every message before it, plus a chain to the
// signed block before it. A request that sends a block whose prefix changed is refused (400,
// "bound to a different conversation"); dropping a leading run of blocks, a trailing run, or all
// of them is allowed, dropping one from the middle is not.
//
// So the provider layer records, on each assistant turn that came back with signed blocks, a
// digest of the request as it was sent (thinking left out, cache markers ignored), the key of
// the last signed block that request carried, and the connection and model that wrote it. When
// a later request is about to go out, the same digest is taken over its own messages before each
// signed turn: the first turn whose prefix, chain, connection or model no longer matches has its
// signed blocks dropped, and so has every signed turn after it (the trailing run the provider
// accepts). The reply text, tool calls and results stay. Nothing changes for a payload without
// signed blocks, and nothing is dropped when nothing before them changed.
//
// Each wire format that carries signed reasoning is a registered binding (`thinkingBindings` in
// the provider registry), replaceable or removable by id like every provider part.
import { createHash } from "node:crypto"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import type { RequestTarget } from "./registry.ts"

/** What an assistant turn with signed blocks records about the request that produced it. */
export interface ThinkingRecord {
  /** Digest of the request it answered: system, tools and messages, thinking and cache markers left out. */
  readonly prefix: string
  /** Key of the last signed block that request carried; null when it carried none. */
  readonly prev: string | null
  readonly connectionId: string
  readonly modelId: string
}

/** An assistant turn as the provider layer returns it: with its record when it carries signed blocks. */
export type RecordedAssistant = AssistantMessage & { readonly thinkingRecord?: ThinkingRecord }

/** A wire format's signed reasoning: where it sits in the payload, and how to leave it out. */
export interface ThinkingBinding {
  readonly id: string
  readonly appliesTo: (target: RequestTarget) => boolean
  /** The payload's conversation messages, in order. */
  readonly messages: (payload: Record<string, unknown>) => ReadonlyArray<unknown> | null
  /** The payload with its messages replaced. */
  readonly withMessages: (payload: Record<string, unknown>, messages: ReadonlyArray<unknown>) => Record<string, unknown>
  /** What the conversation is bound to besides its messages (system prompt, tools), comparable. */
  readonly head: (payload: Record<string, unknown>) => unknown
  /** The signed blocks' identities in a payload message, in order; empty for none. */
  readonly signed: (message: unknown) => ReadonlyArray<string>
  /** The message as the binding compares it: signed reasoning left out. */
  readonly comparable: (message: unknown) => unknown
  /** The message without its signed reasoning; null when nothing else is left in it. */
  readonly strip: (message: unknown) => unknown
  /** The signed blocks' identities a pi assistant message will carry on this wire. */
  readonly piSigned: (message: AssistantMessage) => ReadonlyArray<string>
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Stable JSON: object keys sorted, `cache_control` left out (moving a marker changes nothing). */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = object(value)
  if (record === undefined) return JSON.stringify(value) ?? "null"
  return `{${Object.keys(record)
    .filter((key) => key !== "cache_control" && record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`
}

/** A short identity for a signature (signatures run to kilobytes). */
const keyOf = (signature: string) => createHash("sha256").update(signature).digest("hex").slice(0, 32)

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
  appliesTo: (target) => target.api === "anthropic-messages",
  messages: (payload) => (Array.isArray(payload.messages) ? payload.messages : null),
  withMessages: (payload, messages) => ({ ...payload, messages: [...messages] }),
  // Tools are bound as a set: their order doesn't matter.
  head: (payload) => ({
    system: typeof payload.system === "string" ? [{ type: "text", text: payload.system }] : (payload.system ?? null),
    tools: Array.isArray(payload.tools)
      ? [...payload.tools].sort((a, b) => String(object(a)?.name ?? "").localeCompare(String(object(b)?.name ?? "")))
      : []
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
          ? [{ type: "text", text: content }]
          : Array.isArray(content)
            ? content.filter((block) => !SIGNED_BLOCKS.has(String(object(block)?.type)))
            : content
    }
  },
  strip: (message) => {
    const blocks = blocksOf(message)
    if (blocks === null) return message
    const kept = blocks.filter((block) => !SIGNED_BLOCKS.has(String(object(block)?.type)))
    return kept.length === 0 ? null : { ...object(message), content: kept }
  },
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
  appliesTo: (target) =>
    target.kind === "openrouter" && target.api === "openai-completions" && /^anthropic\//i.test(target.model ?? ""),
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
    system: (Array.isArray(payload.messages) ? payload.messages : []).filter((m) =>
      ["system", "developer"].includes(String(object(m)?.role))
    ),
    tools: Array.isArray(payload.tools)
      ? [...payload.tools].sort((a, b) =>
          String(object(object(a)?.function)?.name ?? "").localeCompare(String(object(object(b)?.function)?.name ?? ""))
        )
      : []
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
    return Object.fromEntries(Object.entries(record).filter(([key]) => !ROUTER_REASONING.includes(key)))
  },
  strip: (message) => {
    const record = object(message)
    if (!record) return message
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

export const builtinThinkingBindings: ReadonlyArray<ThinkingBinding> = [anthropicBinding, openRouterClaudeBinding]

/** Whether a payload carries signed reasoning on this wire. */
export const carriesSigned = (binding: ThinkingBinding, payload: Record<string, unknown>) =>
  (binding.messages(payload) ?? []).some((message) => binding.signed(message).length > 0)

/** Why signed blocks were left out of a request, for its notes (ARCHITECTURE §6). */
export type DropReason = "changed" | "model" | "refused"

export const DROP_NOTES: Record<DropReason, string> = {
  changed:
    "Thinking from earlier in this reply was left out, because something before it changed after it was written. The provider refuses it then.",
  model: "Thinking written by another model or connection was left out. Only the model that wrote it can read it.",
  refused: "The provider refused earlier thinking, so this request was sent again without it."
}

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
    readonly mode: "check" | "strip" | "keep"
  }
): BindResult => {
  const messages = binding.messages(payload)
  if (messages === null || input.mode === "keep" || !messages.some((m) => binding.signed(m).length > 0))
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
  let lastKept: string | null = null
  let dropped = 0
  for (const message of messages) {
    const keys = binding.signed(message)
    if (keys.length > 0 && !dropping) {
      const record = records.get(keys[0]!)
      const sameRecord = keys.every((key) => records.get(key) === record)
      const written =
        record !== undefined && record.connectionId === input.connectionId && record.modelId === input.modelId
      const unchanged =
        written &&
        sameRecord &&
        record.prefix === hash.copy().digest("hex") &&
        (lastKept === null || record.prev === lastKept)
      if (unchanged) lastKept = keys.at(-1)!
      else {
        dropping = true
        reason = record !== undefined && !written ? "model" : "changed"
      }
    }
    hash.update(stable(binding.comparable(message)))
    if (keys.length > 0 && dropping) {
      dropped += keys.length
      const stripped = binding.strip(message)
      if (stripped !== null) out.push(stripped)
    } else out.push(message)
  }
  return dropped === 0
    ? { payload, dropped: 0, reason: null }
    : { payload: binding.withMessages(payload, out), dropped, reason }
}

/** The record for a turn that answered `sent` (the payload as it went out, after `bindThinking`). */
export const thinkingRecord = (
  binding: ThinkingBinding,
  sent: Record<string, unknown>,
  written: { readonly connectionId: string; readonly modelId: string }
): ThinkingRecord => {
  const messages = binding.messages(sent) ?? []
  const hash = createHash("sha256").update(stable(binding.head(sent)))
  let prev: string | null = null
  for (const message of messages) {
    hash.update(stable(binding.comparable(message)))
    prev = binding.signed(message).at(-1) ?? prev
  }
  return { prefix: hash.digest("hex"), prev, ...written }
}

/** Whether a turn came back with signed reasoning this wire sends back. */
export const signsReasoning = (binding: ThinkingBinding, message: AssistantMessage) =>
  binding.piSigned(message).length > 0

/**
 * A refusal of signed thinking: Anthropic's "Invalid `signature` in `thinking` block" (bound to
 * a different conversation, or one it can't verify). Its retry sends no signed blocks.
 */
export const refusesSigned = (error: {
  readonly status: number | null
  readonly message: string
  readonly afterTokens?: boolean
}) =>
  error.status === 400 &&
  !error.afterTokens &&
  /signature[^.]*\b(?:redacted_)?thinking\b[^.]*block|bound to a different conversation/i.test(error.message)

/**
 * A provider that needs the turn being continued to start with its thinking (older Claude
 * models with thinking on: "Expected `thinking` or `redacted_thinking`"). Its retry sends the
 * signed blocks as they were: those models don't bind them to what came before.
 */
export const needsSigned = (error: {
  readonly status: number | null
  readonly message: string
  readonly afterTokens?: boolean
}) =>
  error.status === 400 &&
  !error.afterTokens &&
  /expected\s+`?thinking`?\s+or\s+`?redacted_thinking`?|must start with a thinking block/i.test(error.message)
