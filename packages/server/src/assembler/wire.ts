// The provider-neutral request mapped per provider, as ST 1.19 maps its sources (ARCHITECTURE §15).
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { createHash } from "node:crypto"
import { Predicate } from "effect"
import { REPLY_TOOL, replyTool, schemaPrefillBudget } from "./prefill.ts"
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai"
import type { AssembledRequest, ModelInput, RequestMessage, WireContext } from "./types.ts"

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
    messages: withPrefill(request).map(({ role, content, name }, i, all) => ({
      role,
      content,
      ...(name ? { name } : {}),
      ...(kind === "deepseek" && request.prefill && i === all.length - 1 ? { prefix: true } : {})
    })),
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
  readonly reasoning?: import("@earendil-works/pi-ai").ThinkingLevel
  readonly cacheRetention?: "none" | "short" | "long"
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
const baseProviderRequest = (request: AssembledRequest, model: ModelInput): ProviderRequest => {
  if (request.prefill && model.prefill === "tool_schema") {
    // A schema encodes the prefix, rather than sending a completed assistant history turn.
    const ordinary = providerRequest(
      {
        ...request,
        prefill: null,
        samplers: {
          ...request.samplers,
          max_tokens: request.samplers.max_tokens + schemaPrefillBudget(request.prefill).output
        }
      },
      model
    )
    const tool = replyTool(request.prefill)
    const responses = model.api === "openai-responses"
    return {
      ...ordinary,
      payload: {
        ...ordinary.payload,
        tools: [responses ? { type: "function", ...tool } : { type: "function", function: tool }],
        tool_choice: responses
          ? { type: "function", name: REPLY_TOOL }
          : { type: "function", function: { name: REPLY_TOOL } },
        parallel_tool_calls: false
      }
    }
  }
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
    while (first < messages.length && messages[first]!.role === "system" && first < (request.summaryStart ?? Infinity))
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

/** Apply model-owned provider options after prompt composition. */
export const providerRequest = (request: AssembledRequest, model: ModelInput): ProviderRequest => {
  const wire = baseProviderRequest(request, model)
  const settings = model.settings
  if (!settings) return wire
  const effort = settings.samplers?.reasoning_effort
  const verbosity = settings.samplers?.verbosity
  return {
    ...wire,
    ...(settings.cacheRetention ? { cacheRetention: settings.cacheRetention } : {}),
    ...(["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort ?? "")
      ? { reasoning: effort as import("@earendil-works/pi-ai").ThinkingLevel }
      : {}),
    payload: {
      ...wire.payload,
      ...(settings.stop?.length
        ? model.api === "anthropic-messages"
          ? { stop_sequences: settings.stop }
          : model.api === "google-generative-ai"
            ? { config: { ...(wire.payload.config as object), stopSequences: settings.stop } }
            : { stop: settings.stop }
        : {}),
      ...(settings.logit_bias && model.api === "openai-completions" ? { logit_bias: settings.logit_bias } : {}),
      ...(effort && effort !== "auto"
        ? model.api === "openai-responses"
          ? { reasoning: { effort } }
          : model.api === "openai-completions"
            ? { reasoning_effort: effort }
            : {}
        : {}),
      ...(verbosity && verbosity !== "auto"
        ? model.api === "openai-responses"
          ? { text: { verbosity } }
          : model.api === "openai-completions"
            ? { verbosity }
            : {}
        : {}),
      ...(model.kind === "openrouter" && settings.routing ? { provider: settings.routing } : {})
    }
  }
}

/** The mapped request for inspection and cache comparison, with source indices only. */
export const wireContext = (request: AssembledRequest, model: ModelInput): WireContext => {
  if (request.prefill && model.prefill === "tool_schema") {
    const ordinary = wireContext(
      {
        ...request,
        prefill: null,
        samplers: {
          ...request.samplers,
          max_tokens: request.samplers.max_tokens + schemaPrefillBudget(request.prefill).output
        }
      },
      model
    )
    return {
      ...ordinary,
      messages: [
        ...ordinary.messages,
        {
          role: "assistant",
          content: request.prefill,
          inputs: [request.messages.length],
          prefill: { protocol: "tool_schema", schema: JSON.stringify(replyTool(request.prefill).parameters, null, 2) }
        }
      ]
    }
  }
  const wire = providerRequest(request, model)
  const input = withPrefill(request)
  const samplers: Record<string, number> = {}
  for (const [key, value] of Object.entries(wire.payload)) {
    if (typeof value === "number") samplers[key] = value
    if (key === "config" && value && typeof value === "object") {
      for (const [key, field] of Object.entries(value)) if (typeof field === "number") samplers[key] = field
    }
  }
  if (wire.temperature !== undefined) samplers.temperature = wire.temperature
  if (wire.maxTokens !== undefined) samplers.max_tokens = wire.maxTokens
  if (model.api === "openai-completions") {
    return { messages: input.map((message, i) => ({ ...message, inputs: [i] })), samplers, mapping: model.mapping }
  }
  const first = wire.context.systemPrompt !== undefined ? input.findIndex((m) => m.role !== "system") : 0
  const systemCount = Math.min(first === -1 ? input.length : first, request.summaryStart ?? Infinity)
  const messages: Array<WireContext["messages"][number]> = []
  if (wire.context.systemPrompt) {
    messages.push({
      role: "system",
      content: wire.context.systemPrompt,
      inputs: Array.from({ length: systemCount }, (_, i) => i)
    })
  }
  for (const [i, message] of wire.context.messages.entries()) {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
    messages.push({ role: message.role === "assistant" ? "assistant" : "user", content, inputs: [i + systemCount] })
  }
  const projected = { messages, samplers, mapping: model.mapping }
  if (model.api === "openai-responses") {
    // Use the installed SDK's conversion, including developer roles and text normalization.
    const sdk = {
      id: model.key,
      api: model.api,
      provider: "openai",
      reasoning: model.mapping?.reasoning ?? false,
      input: ["text"],
      compat: { supportsDeveloperRole: model.mapping?.supportsDeveloperRole ?? true }
    } as Model<"openai-responses">
    const payload = { input: convertResponsesMessages(sdk, normalizeContext(wire.context), new Set()) }
    const converted = {
      ...projected,
      messages: projected.messages.map((message) => ({
        ...message,
        role:
          message.role === "system" && sdk.reasoning && sdk.compat?.supportsDeveloperRole !== false
            ? ("developer" as const)
            : message.role
      }))
    }
    markWireSources(payload, converted)
    return { ...sentWire(payload, projected), samplers }
  }
  if (model.api === "google-generative-ai") {
    return {
      ...projected,
      messages: messages.map((m) => (m.role === "assistant" ? { ...m, role: "model" as const } : m))
    }
  }
  return projected
}

type WireMessage = WireContext["messages"][number]
type TextMessage = Pick<WireMessage, "role" | "content" | "name" | "prefill">

/** Only stored server-side; display redaction must not change cache identity. */
export const wireDigest = (message: TextMessage): string =>
  createHash("sha256")
    .update(JSON.stringify([message.role, message.name ?? null, message.content]))
    .digest("hex")

// Enumerable symbols survive normal transform object spreads, but never JSON serialization.
const provenance = Symbol("wire sources")
const systemProvenance = Symbol("system sources")
type Carrier = {
  [provenance]?: ReadonlyArray<number>
  [systemProvenance]?: { readonly content: string; readonly inputs: ReadonlyArray<number> }
}
const textContent = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .flatMap((block) => (Predicate.isObject(block) && typeof block.text === "string" ? [block.text] : []))
          .join("\n")
      : ""

const wireRows = (payload: Record<string, unknown>) => {
  const config = Predicate.isObject(payload.config) ? payload.config : {}
  const rows: Array<{ row: TextMessage; carrier: Carrier; system?: true }> = []
  const system = textContent(payload.system ?? config.systemInstruction)
  if (system) rows.push({ row: { role: "system", content: system }, carrier: payload, system: true })
  const messages = payload.messages ?? payload.input ?? payload.contents
  if (Array.isArray(messages))
    for (const message of messages) {
      if (!Predicate.isObject(message)) continue
      const role = message.role
      if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "model")
        continue
      rows.push({
        row: {
          role,
          content: textContent(message.content ?? message.parts),
          ...(typeof message.name === "string" ? { name: message.name } : {}),
          ...(message.prefix === true && role === "assistant"
            ? { prefill: { protocol: "deepseek_prefix" as const } }
            : {})
        },
        carrier: message
      })
    }
  // Inspect only this generator's forced text tool; never store arbitrary tool definitions.
  const choice = Predicate.isObject(payload.tool_choice) ? payload.tool_choice : {}
  const chosen = Predicate.isObject(choice.function) ? choice.function.name : choice.name
  if (chosen === REPLY_TOOL && Array.isArray(payload.tools)) {
    for (const item of payload.tools) {
      if (!Predicate.isObject(item)) continue
      const tool = Predicate.isObject(item.function) ? item.function : item
      if (tool.name !== REPLY_TOOL || tool.strict !== true || !Predicate.isObject(tool.parameters)) continue
      const props = tool.parameters.properties
      const field = Predicate.isObject(props) ? props.text : undefined
      if (!Predicate.isObject(field) || typeof field.description !== "string" || typeof field.pattern !== "string")
        continue
      rows.push({
        row: {
          role: "assistant",
          content: field.description,
          prefill: {
            protocol: "tool_schema",
            schema: JSON.stringify(tool.parameters, null, 2)
          }
        },
        carrier: tool
      })
    }
  }
  return rows
}

/** Attach provenance before transforms. Missing/replaced carriers remain unassigned, never positional. */
export const markWireSources = (payload: Record<string, unknown>, sources: WireContext): void => {
  const matches = new Map<string, Array<ReadonlyArray<number>>>()
  for (const message of sources.messages) {
    const key = wireDigest(message)
    const queue = matches.get(key) ?? []
    queue.push(message.inputs)
    matches.set(key, queue)
  }
  for (const { row, carrier, system } of wireRows(payload)) {
    const inputs = matches.get(wireDigest(row))?.shift() ?? []
    if (system) carrier[systemProvenance] = { content: row.content, inputs }
    else carrier[provenance] = inputs
  }
}

/** Extract only text messages and numeric samplers from the final SDK/transformed body.
 * Headers, connection settings, tool definitions and arbitrary payload fields never enter storage.
 */
export const sentWire = (
  payload: Record<string, unknown>,
  sources: WireContext,
  scrub = (text: string) => text
): WireContext => {
  const config = Predicate.isObject(payload.config) ? payload.config : {}
  const samplers: Record<string, number> = {}
  for (const fields of [payload, config])
    for (const key of [
      "temperature",
      "top_p",
      "topP",
      "top_k",
      "topK",
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
      "maxOutputTokens",
      "frequency_penalty",
      "presence_penalty",
      "seed",
      "min_p",
      "top_a",
      "repetition_penalty"
    ]) {
      if (typeof fields[key] === "number") samplers[key] = fields[key]
    }
  return {
    mapping: sources.mapping,
    samplers,
    messages: wireRows(payload).map(({ row, carrier, system }) => ({
      ...row,
      digest: wireDigest(row),
      content: scrub(row.content),
      ...(row.prefill
        ? { prefill: { ...row.prefill, ...(row.prefill.schema ? { schema: scrub(row.prefill.schema) } : {}) } }
        : {}),
      ...(row.name ? { name: scrub(row.name) } : {}),
      inputs: system
        ? carrier[systemProvenance]?.content === row.content
          ? carrier[systemProvenance]!.inputs
          : []
        : (carrier[provenance] ?? [])
    }))
  }
}
