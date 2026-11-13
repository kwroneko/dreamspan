// A rollout's requests (spec/AGENTIC.md §3.2): the frozen prefix the assembler built once, plus
// the rollout's own transcript after it. pi-ai converts the suffix for the APIs it converts the
// prefix for; Chat Completions gets the assembled messages exactly in `payload`, so the suffix
// is added there in the wire's own form. The summarizer's tool loop shares this.
import type { Message, Tool } from "@earendil-works/pi-ai"
import type { ProviderRequest } from "../assembler/wire.ts"
import type { ModelInput } from "../assembler/types.ts"
type ReasoningTarget = Pick<ModelInput, "api" | "kind" | "key">

/** A suffix message as Chat Completions takes it: assistant `tool_calls`, `role: "tool"` results. */
const signedDetails = (signature: string | undefined): ReadonlyArray<unknown> | undefined => {
  if (!signature) return undefined
  try {
    const parsed: unknown = JSON.parse(signature)
    return Array.isArray(parsed) && parsed.length ? parsed : undefined
  } catch {
    return undefined
  }
}

const completionsMessage = (
  m: Message,
  replayReasoning = false,
  target?: ReasoningTarget,
  requireReasoning = false
): unknown => {
  if (m.role === "assistant") {
    const text = m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
    const calls = m.content
      .filter((p) => p.type === "toolCall")
      .map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.arguments) } }))
    // DeepSeek's thinking models refuse a tool-call turn sent back without its reasoning.
    const reasoning = m.content
      .filter((p) => p.type === "thinking")
      .map((p) => p.thinking)
      .join("")
    // pi-ai stores OpenRouter's opaque reasoning_details in thinkingSignature.
    // Replaying only visible thinking loses encrypted reasoning required by Claude/Gemini.
    const provider = target?.kind === "openai-chat" || target?.kind === "openai-responses" ? "openai" : target?.kind
    const sameModel = !target || (m.api === target.api && m.model === target.key && m.provider === provider)
    const details =
      replayReasoning && sameModel
        ? m.content
            .flatMap((p) => (p.type === "thinking" ? [signedDetails(p.thinkingSignature)] : []))
            .find((d) => d !== undefined)
        : undefined
    const field =
      replayReasoning && sameModel
        ? m.content.find(
            (p) => p.type === "thinking" && ["reasoning", "reasoning_content"].includes(p.thinkingSignature ?? "")
          )
        : undefined
    const reasoningField = field?.type === "thinking" ? field.thinkingSignature : undefined
    return {
      role: "assistant",
      content: text,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(details
        ? { reasoning_details: details }
        : (reasoning || (requireReasoning && calls.length)) && (calls.length || reasoningField)
          ? { [reasoningField ?? "reasoning_content"]: reasoning }
          : {})
    }
  }
  if (m.role === "toolResult") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId,
      content: m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
    }
  }
  if (m.role === "user") {
    return {
      role: "user",
      ...((m as { name?: string }).name ? { name: (m as { name?: string }).name } : {}),
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.some((p) => p.type === "image")
            ? m.content.map((p) =>
                p.type === "text"
                  ? { type: "text", text: p.text }
                  : { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } }
              )
            : m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
    }
  }
  return { role: "system", content: typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("") }
}

/**
 * The request for one step of a rollout: the frozen prefix, then `suffix`, with `tools`.
 * `explicitTail`: one more cache breakpoint on the last suffix message, so each request reads
 * the one before it from the cache (reference-harness's tail checkpoint). It goes last, as the least
 * important: the provider layer drops it when the model's marker budget is spent.
 */
export const rolloutRequest = (
  prefix: ProviderRequest,
  api: string,
  suffix: ReadonlyArray<Message>,
  tools: ReadonlyArray<Tool> | undefined,
  options: {
    readonly explicitTail?: boolean
    /** DeepSeek requires the field even when the replayed call has no visible thinking. */
    readonly requireReasoning?: boolean
    readonly replayReasoning?: boolean
    readonly reasoningTarget?: ReasoningTarget
  } = {}
): ProviderRequest => {
  const messages = [...prefix.context.messages, ...suffix]
  const context = { ...prefix.context, messages, ...(tools?.length ? { tools: [...tools] } : {}) }
  const payload =
    suffix.length && api === "openai-completions" && Array.isArray(prefix.payload.messages)
      ? {
          ...prefix.payload,
          messages: [
            ...(prefix.payload.messages as Array<unknown>),
            ...suffix.map((message) =>
              completionsMessage(message, options.replayReasoning, options.reasoningTarget, options.requireReasoning)
            )
          ]
        }
      : prefix.payload
  const tail = messages.length - 1
  const breakpoints =
    options.explicitTail && suffix.length && !prefix.breakpoints.includes(tail)
      ? [...prefix.breakpoints, tail]
      : prefix.breakpoints
  return { ...prefix, context, payload, breakpoints }
}
