// The provider-neutral request mapped per provider, as ST 1.19 maps its sources (ARCHITECTURE §15).
import type { Api, AssistantMessage, Context, Message } from "@earendil-works/pi-ai"
import type { AssembledRequest, ModelInput, RequestMessage } from "./types.ts"

/** The messages with the prefill appended as the start of the reply, where the model takes one. */
const withPrefill = (request: AssembledRequest): ReadonlyArray<RequestMessage> =>
  request.prefill ? [...request.messages, { role: "assistant", content: request.prefill }] : request.messages

const drop = (fields: Record<string, unknown>, ...keys: ReadonlyArray<string>) => {
  for (const key of keys) delete fields[key]
}

/**
 * ST's rules for models that refuse some samplers: OpenAI's o-series, GPT-5 and GPT-6
 * Astra take `max_completion_tokens` and fewer samplers; Claude's newest models take none.
 */
const modelRules = (fields: Record<string, unknown>, kind: string, key: string) => {
  const gpt = kind === "openai-chat" || kind === "openrouter" || kind === "openai-responses"
  // Responses has its own field for the length, which pi-ai sets.
  const toCompletionTokens = () => {
    if (kind === "openai-responses") return
    fields.max_completion_tokens = fields.max_tokens
    fields.max_tokens = undefined
  }
  if (gpt && (/^(o1|o3|o4)/.test(key) || (kind === "openrouter" && /^openai\/(o1|o3|o4)/.test(key)))) {
    toCompletionTokens()
    drop(fields, "temperature", "top_p", "frequency_penalty", "presence_penalty")
  }
  if (gpt && /gpt-5/.test(key)) {
    toCompletionTokens()
    if (/gpt-5-chat-latest/.test(key)) {
      // As it is.
    } else if (/gpt-5\.(1|2|3|4)/.test(key)) drop(fields, "frequency_penalty", "presence_penalty")
    else drop(fields, "temperature", "top_p", "frequency_penalty", "presence_penalty")
  }
  if (gpt && /gpt-6-astra/.test(key)) {
    toCompletionTokens()
    drop(fields, "temperature", "top_p")
  }
  if (/claude-(fable|opus-5|sonnet-5)/.test(key)) {
    drop(fields, "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty")
  }
  return fields
}

/**
 * The Chat Completions fields the assembler decides, as ST sends them: its custom source
 * for `openai-chat` (its OpenAI-compatible sources send the same), OpenRouter's extra
 * samplers, DeepSeek's non-zero top_p, a seed only when the preset sets one.
 */
export const chatCompletionsFields = (request: AssembledRequest, kind: string, key = ""): Record<string, unknown> => {
  const s = request.samplers
  const fields: Record<string, unknown> = {
    messages: withPrefill(request).map(({ role, content, name }) => ({ role, content, ...(name ? { name } : {}) })),
    temperature: s.temperature,
    frequency_penalty: s.frequency_penalty,
    presence_penalty: s.presence_penalty,
    top_p: s.top_p,
    max_tokens: s.max_tokens,
    // pi-ai sets this one from the model; the preset's max_tokens is the one ST sends.
    max_completion_tokens: undefined,
    ...(s.seed >= 0 ? { seed: s.seed } : {})
  }
  if (kind === "openrouter") {
    Object.assign(fields, { min_p: s.min_p, repetition_penalty: s.repetition_penalty, top_a: s.top_a })
    if (s.top_k > 0) fields.top_k = s.top_k
  }
  if (kind === "deepseek") fields.top_p = s.top_p || Number.EPSILON
  return modelRules(fields, kind, key)
}

/** ST's Claude samplers: the limited models take temperature or top_p, the newest none. */
const claudeSamplers = (request: AssembledRequest, key: string) => {
  const s = request.samplers
  const fields: Record<string, unknown> = {
    temperature: s.temperature,
    top_p: s.top_p,
    ...(s.top_k > 0 ? { top_k: s.top_k } : {})
  }
  if (/^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(key)) {
    drop(fields, (s.top_p < 1 ? "temperature" : "top_p") as string)
  }
  if (/^claude-(opus-4-7|opus-4-8)/.test(key) || /claude-(fable|opus-5|sonnet-5)/.test(key)) {
    drop(fields, "temperature", "top_p", "top_k")
  }
  return fields
}

/** ST's Claude conversion of a message's name: examples get the bound names, others their own. */
const named = (message: RequestMessage, names: AssembledRequest["names"]) => {
  const { content } = message
  const startsWithGroup = names.group.some((name) => content.startsWith(`${name}: `))
  if (message.name === "example_user" && names.user && !content.startsWith(`${names.user}: `)) {
    return `${names.user}: ${content}`
  }
  if (
    message.name === "example_assistant" &&
    names.char &&
    !content.startsWith(`${names.char}: `) &&
    !startsWithGroup
  ) {
    return `${names.char}: ${content}`
  }
  if (message.name && !message.name.startsWith("example_") && message.role !== "system") {
    return `${message.name}: ${content}`
  }
  return content
}

export interface ProviderRequest {
  readonly context: Context
  readonly temperature?: number
  readonly maxTokens?: number
  /** Fields merged over the body pi-ai built. */
  readonly payload: Readonly<Record<string, unknown>>
  /** Indices into `context.messages`, most important first. */
  readonly breakpoints: ReadonlyArray<number>
}

const text = (content: string) => ({ type: "text" as const, text: content })

/**
 * The request for a model: Chat Completions gets the messages as they are, in `payload` (the
 * context pi-ai gets only feeds its usage estimate); other APIs get a context pi-ai converts.
 */
export const providerRequest = (request: AssembledRequest, model: ModelInput): ProviderRequest => {
  if (model.api === "openai-completions") {
    return {
      context: { messages: withPrefill(request).map((m) => ({ role: "user", content: m.content, timestamp: 0 })) },
      payload: chatCompletionsFields(request, model.kind, model.key),
      breakpoints: []
    }
  }
  const messages = withPrefill(request)
  const systemParameter =
    request.useSystemPrompt || (model.api !== "anthropic-messages" && model.api !== "google-generative-ai")
  const system: Array<string> = []
  let first = 0
  if (systemParameter) {
    while (first < messages.length && messages[first]!.role === "system")
      system.push(named(messages[first++]!, request.names))
  }
  // One message each: consecutive turns of a role stay apart, so a breakpoint on one
  // covers it and nothing after it; the API joins them into one turn.
  const piMessages = messages.slice(first).map((message): Message =>
    message.role !== "assistant"
      ? { role: "user", content: [text(named(message, request.names))], timestamp: 0 }
      : ({
          role: "assistant",
          content: [text(named(message, request.names))],
          api: model.api as Api,
          provider: model.kind,
          model: model.key,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: "stop",
          timestamp: 0
        } satisfies AssistantMessage)
  )
  const s = request.samplers
  const anthropic = model.api === "anthropic-messages"
  const { temperature, ...payload } = anthropic
    ? claudeSamplers(request, model.key)
    : model.api === "google-generative-ai"
      ? // Google takes its samplers in the request's `config`, as ST sends them (topP, topK).
        { temperature: s.temperature, config: { topP: s.top_p, ...(s.top_k > 0 ? { topK: s.top_k } : {}) } }
      : model.api === "openai-responses"
        ? modelRules({ temperature: s.temperature, top_p: s.top_p }, "openai-responses", model.key)
        : { temperature: s.temperature, top_p: s.top_p }
  return {
    context: { ...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}), messages: piMessages },
    ...(typeof temperature === "number" ? { temperature } : {}),
    maxTokens: s.max_tokens,
    payload,
    // A breakpoint on a message that became part of the system prompt is pi-ai's own marker.
    breakpoints:
      model.cacheBreakpoints === "explicit"
        ? request.breakpoints.flatMap((b) => (b.message < first ? [] : [b.message - first]))
        : []
  }
}
