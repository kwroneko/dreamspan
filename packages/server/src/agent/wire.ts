// A rollout's requests (spec/AGENTIC.md §3.2): the frozen prefix the assembler built once, plus
// the rollout's own transcript after it. pi-ai converts the suffix for the APIs it converts the
// prefix for; Chat Completions gets the assembled messages exactly in `payload`, so the suffix
// is added there in the wire's own form. The summarizer's tool loop shares this.
import type { Message, Tool } from "@earendil-works/pi-ai"
import type { ProviderRequest } from "../assembler/wire.ts"

/** A suffix message as Chat Completions takes it: assistant `tool_calls`, `role: "tool"` results. */
const completionsMessage = (m: Message): unknown => {
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
    return {
      role: "assistant",
      content: text,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(reasoning && calls.length ? { reasoning_content: reasoning } : {})
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
      content:
        typeof m.content === "string"
          ? m.content
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
  options: { readonly explicitTail?: boolean } = {}
): ProviderRequest => {
  const messages = [...prefix.context.messages, ...suffix]
  const context = { ...prefix.context, messages, ...(tools?.length ? { tools: [...tools] } : {}) }
  const payload =
    suffix.length && api === "openai-completions" && Array.isArray(prefix.payload.messages)
      ? {
          ...prefix.payload,
          messages: [...(prefix.payload.messages as Array<unknown>), ...suffix.map(completionsMessage)]
        }
      : prefix.payload
  const tail = messages.length - 1
  const breakpoints =
    options.explicitTail && suffix.length && !prefix.breakpoints.includes(tail)
      ? [...prefix.breakpoints, tail]
      : prefix.breakpoints
  return { ...prefix, context, payload, breakpoints }
}
