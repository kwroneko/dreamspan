// The provider-neutral request mapped per provider, as ST 1.19 maps its sources (ARCHITECTURE §15).
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { createHash } from "node:crypto"
import { Predicate } from "effect"
import { REPLY_TOOL, replyTool, schemaPrefillBudget } from "./prefill.ts"
import { reasoningDetails, type ReplayedReasoning } from "./reasoningReplay.ts"
import { HISTORY_REPLAY } from "../providers/thinkingBinding.ts"
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai"
import type { AssembledRequest, ModelInput, RequestImage, RequestMessage, WireContext } from "./types.ts"
import { isReasoningEffort } from "@dreamspan/shared/modelSettings.ts"
import { claudeRules, modelRules } from "@dreamspan/shared/samplerRules.ts"

/** The messages with the prefill appended as the start of the reply, where the model takes one. */
const withPrefill = (request: AssembledRequest): ReadonlyArray<RequestMessage> =>
  request.prefill ? [...request.messages, { role: "assistant", content: request.prefill }] : request.messages

/**
 * The Chat Completions fields the assembler decides, as ST sends them: its custom source
 * for `openai-chat` (its OpenAI-compatible sources send the same), OpenRouter's extra
 * samplers, DeepSeek's non-zero top_p, a seed only when the preset sets one.
 */
export const chatCompletionsFields = (request: AssembledRequest, kind: string, key = ""): Record<string, unknown> => {
  const s = request.samplers
  const fields: Record<string, unknown> = {
    messages: withPrefill(request).map(({ role, content, name, images }, i, all) => ({
      role: images?.length ? "user" : role,
      content: images?.some((image) => image.data)
        ? [
            { type: "text", text: content },
            ...images
              .filter((image) => image.data)
              .map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.data}` }
              }))
          ]
        : content,
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
  return claudeRules(
    {
      temperature: s.temperature,
      top_p: s.top_p,
      ...(s.top_k > 0 ? { top_k: s.top_k } : {})
    },
    key,
    s.top_p
  )
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
  /**
   * The automatic layout's reusable endpoint: the context message the next request repeats
   * (the assembly's last breakpoint), for the transforms that place a provider's own markers.
   */
  readonly stable?: { readonly message: number; readonly end: number }
}

/** The automatic layout's endpoint, `offset` messages into the system prompt; none for explicit or off. */
const stableEndpoint = (request: AssembledRequest, model: ModelInput, offset: number, end: number) => {
  if (model.cacheBreakpoints !== "auto" || request.breakpoints.length === 0) return {}
  const message = Math.max(...request.breakpoints.map((b) => b.message)) - offset
  return message < 0 || message >= end ? {} : { stable: { message, end } }
}

const imageBlocks = (message: RequestMessage) =>
  (message.images ?? []).flatMap((image) =>
    image.data && image.mimeType ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []
  )
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
        // The outer call sends the reasoning back, once.
        replay: undefined,
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
    const messages = withPrefill(request)
    return {
      context: { messages: messages.map((m) => ({ role: "user", content: m.content, timestamp: 0 })) },
      payload: chatCompletionsFields(request, model.kind, model.key),
      breakpoints: model.cacheBreakpoints === "explicit" ? request.breakpoints.map((b) => b.message) : [],
      ...stableEndpoint(request, model, 0, messages.length)
    }
  }
  const messages = withPrefill(request)
  const systemParameter =
    request.useSystemPrompt || (model.api !== "anthropic-messages" && model.api !== "google-generative-ai")
  const system: Array<string> = []
  let first = 0
  // Lore pinned above the history changes when its start moves: Anthropic's system prompt ends
  // with the prefix before it, so the marker pi-ai puts there keeps the prefix cached (DESIGN §1.3).
  const pinnedAt =
    model.api === "anthropic-messages"
      ? (request.pinnedStart ??
        (request.breakpoints.some((b) => b.reason === "pinned")
          ? (request.breakpoints.find((b) => b.reason === "prefix")?.message ?? -1) + 1
          : Infinity))
      : Infinity
  if (systemParameter) {
    while (
      first < messages.length &&
      messages[first]!.role === "system" &&
      !messages[first]!.images?.length &&
      first < (request.summaryStart ?? Infinity) &&
      first < pinnedAt
    )
      system.push(named(messages[first++]!, request.names))
  }
  // One message each: consecutive turns of a role stay apart, so a breakpoint on one
  // covers it and nothing after it; the API joins them into one turn.
  const piMessages = messages.slice(first).map((message): Message =>
    message.role !== "assistant" || !!message.images?.length
      ? { role: "user", content: [text(named(message, request.names)), ...imageBlocks(message)], timestamp: 0 }
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
        : [],
    ...stableEndpoint(request, model, first, piMessages.length)
  }
}

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

/** A reply's reasoning as pi-ai's thinking parts, in the order the provider sent them. */
const thinkingParts = (replay: ReplayedReasoning) =>
  replay.native.parts.map((part) => ({
    type: "thinking" as const,
    thinking: part.text,
    ...(part.signature !== undefined ? { thinkingSignature: part.signature } : {}),
    ...(part.redacted ? { redacted: true } : {})
  }))

/**
 * Earlier replies' own reasoning on their messages (the `reasoning-replay` stage decided which):
 * Chat Completions (OpenRouter) gets `reasoning_details`, or plain `reasoning`, on the message;
 * other APIs get the reply's thinking parts first, which pi-ai sends as the provider's blocks
 * (Anthropic thinking and redacted thinking, Responses reasoning items). Each such reply is
 * marked (HISTORY_REPLAY) with the provider layer's record of what it answered, so the final
 * check (thinkingBinding.ts) can still leave a block out.
 */
const withReplay = (request: AssembledRequest, model: ModelInput, wire: ProviderRequest): ProviderRequest => {
  const replay = request.replay
  if (!replay?.length) return wire
  const replayed = (content: AssistantMessage["content"], r: ReplayedReasoning): Message =>
    Object.assign(
      {
        role: "assistant" as const,
        content: [...thinkingParts(r), ...content],
        api: model.api as Api,
        provider: model.kind,
        model: model.key,
        usage: emptyUsage(),
        stopReason: "stop" as const,
        timestamp: 0,
        // pi-ai puts the effort it was written at back before it (a mid-conversation system
        // message, on models that take one), as the request it answered had it.
        ...(r.native.level !== undefined ? { providerThinkingLevel: r.native.level } : {})
      } satisfies AssistantMessage,
      { [HISTORY_REPLAY]: true },
      r.native.record === undefined ? {} : { thinkingRecord: r.native.record }
    )
  if (model.api === "openai-completions") {
    const sent = Array.isArray(wire.payload.messages)
      ? [...(wire.payload.messages as Array<Record<string, unknown>>)]
      : []
    const context = [...wire.context.messages]
    for (const r of replay) {
      const message = sent[r.message]
      if (message?.role !== "assistant") continue
      const details = r.form === "signed" ? reasoningDetails(r.native) : undefined
      sent[r.message] = details
        ? { ...message, reasoning_details: details }
        : { ...message, reasoning: r.native.parts.map((part) => part.text).join("\n") }
      // The context only feeds the usage estimate, and the final check's record.
      if (details && context[r.message])
        context[r.message] = replayed([text(typeof message.content === "string" ? message.content : "")], r)
    }
    return { ...wire, payload: { ...wire.payload, messages: sent }, context: { ...wire.context, messages: context } }
  }
  // The leading system messages became the system prompt: the context starts after them.
  const offset = withPrefill(request).length - wire.context.messages.length
  const messages = [...wire.context.messages]
  for (const r of replay) {
    const message = messages[r.message - offset]
    if (r.form !== "signed" || message?.role !== "assistant") continue
    messages[r.message - offset] = replayed(message.content, r)
  }
  return { ...wire, context: { ...wire.context, messages } }
}

/** Apply model-owned provider options after prompt composition. */
export const providerRequest = (request: AssembledRequest, model: ModelInput): ProviderRequest => {
  const base = withReplay(request, model, baseProviderRequest(request, model))
  const settings = model.settings
  if (!settings) return base
  const { stable, ...wire } = base
  const effort = model.mapping?.reasoning === false ? undefined : settings.samplers?.reasoning_effort
  const verbosity = settings.samplers?.verbosity
  return {
    ...wire,
    ...(settings.cacheRetention ? { cacheRetention: settings.cacheRetention } : {}),
    ...(settings.cacheRetention === "none" ? { breakpoints: [] } : stable ? { stable } : {}),
    ...(isReasoningEffort(effort) ? { reasoning: effort } : {}),
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
  // The inspector shows the messages' text; earlier replies' reasoning isn't part of it.
  const wire = providerRequest({ ...request, replay: undefined }, model)
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
    return {
      messages: input.map(({ role, content, name, images }, i) => ({
        role: images?.length ? ("user" as const) : role,
        content,
        ...(name ? { name } : {}),
        ...(images?.length ? { images } : {}),
        inputs: [i]
      })),
      samplers,
      mapping: model.mapping
    }
  }
  // Only messages actually consumed into the system parameter leave the transcript.
  // A system-role image stays in the transcript, as do pinned lore and summaries.
  const systemCount = input.length - wire.context.messages.length
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
    const images = input[i + systemCount]?.images
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content,
      ...(images?.length ? { images } : {}),
      inputs: [i + systemCount]
    })
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
    const captured = sentWire(payload, projected)
    return {
      ...captured,
      samplers,
      messages: captured.messages.map((message) => {
        const images = message.inputs.flatMap((i) => input[i]?.images ?? [])
        return { ...message, images, digest: wireDigest({ ...message, images }) }
      })
    }
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
type TextMessage = Pick<WireMessage, "role" | "content" | "name" | "prefill" | "images">

/** Only stored server-side; display redaction must not change cache identity. */
export const wireDigest = (message: TextMessage): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        message.role,
        message.name ?? null,
        message.content,
        (message.images ?? [])
          .filter((image) => image.estimate?.sent !== false)
          .map((image) => [
            image.sha256 ??
              (image.data
                ? createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex")
                : image.mediaId),
            image.estimate?.detail === "unspecified" ? "auto" : (image.estimate?.detail ?? "auto")
          ])
      ])
    )
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

/** Only identities survive capture: never persist or publish inline image data. */
const capturedImages = (content: unknown): ReadonlyArray<RequestImage> => {
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (!Predicate.isObject(block)) return []
    const url =
      block.type === "input_image"
        ? block.image_url
        : block.type === "image_url"
          ? Predicate.isObject(block.image_url)
            ? block.image_url.url
            : block.image_url
          : undefined
    const source = Predicate.isObject(block.source) ? block.source : {}
    const inline = Predicate.isObject(block.inlineData)
      ? block.inlineData
      : Predicate.isObject(block.inline_data)
        ? block.inline_data
        : {}
    const data =
      typeof url === "string"
        ? /^data:[^;,]+;base64,(.*)$/s.exec(url)?.[1]
        : block.type === "image" && source.type === "base64" && typeof source.data === "string"
          ? source.data
          : typeof inline.data === "string"
            ? inline.data
            : undefined
    if (data === undefined) return []
    const detail = Predicate.isObject(block.image_url) ? block.image_url.detail : block.detail
    return [
      {
        mediaId: "",
        sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
        estimate: { tokens: null, basis: "unknown" as const, detail: typeof detail === "string" ? detail : "auto" }
      }
    ]
  })
}

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
          images: capturedImages(message.content ?? message.parts),
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
    const key = wireDigest({ ...message, images: [] })
    const queue = matches.get(key) ?? []
    queue.push(message.inputs)
    matches.set(key, queue)
  }
  for (const { row, carrier, system } of wireRows(payload)) {
    const inputs = matches.get(wireDigest({ ...row, images: [] }))?.shift() ?? []
    if (system) carrier[systemProvenance] = { content: row.content, inputs }
    else carrier[provenance] = inputs
  }
}

/** Extract text messages and numeric samplers from the final body. Tool capture is separate. */
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
    messages: wireRows(payload).map(({ row: { images, ...row }, carrier, system }) => ({
      ...row,
      digest: wireDigest({ ...row, images: images ?? [] }),
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
