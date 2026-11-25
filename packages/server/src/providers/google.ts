// Gemini generateContent has no public fetch hook in genai 2.21.0 (HttpOptions
// controls headers/body/retries only). Speak its REST wire format through Network's
// fetch, retaining pi's transcript/tool conversion without modifying either library.
import type { AssistantMessage, StreamFunction, SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai"
import {
  convertMessages,
  convertTools,
  getDisabledGoogleThinkingConfig as piDisabledThinkingConfig,
  isThinkingPart,
  mapStopReasonString,
  resolveGoogleFunctionCallingMode,
  resolveGoogleThinkingLevel,
  supportsGoogleStrictToolSampling,
  toGoogleSdkThinkingLevel,
  toGoogleThinkingLevel,
  usesGoogleThinkingLevel as piUsesThinkingLevel
} from "@earendil-works/pi-ai/api/google-shared"
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options"
import { clampThinkingLevel, calculateCost } from "@earendil-works/pi-ai/models"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import {
  collapseSystemMessages,
  getCurrentTools,
  getInitialSystemMessage
} from "@earendil-works/pi-ai/utils/transcript"
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text"
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers"
import { getPiUserAgent } from "@earendil-works/pi-ai/utils/pi-user-agent"
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode"
import { Schema } from "effect"
import { googleRequest } from "./googleRequest.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"

const Part = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thought: Schema.optionalKey(Schema.Boolean),
  thoughtSignature: Schema.optionalKey(Schema.String),
  functionCall: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.String,
      args: Schema.optionalKey(Schema.JsonObject)
    })
  )
})
const Chunk = Schema.StructWithRest(
  Schema.Struct({
    error: Schema.optionalKey(Schema.JsonObject),
    responseId: Schema.optionalKey(Schema.String),
    promptFeedback: Schema.optionalKey(Schema.Struct({ blockReason: Schema.optionalKey(Schema.String) })),
    candidates: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          content: Schema.optionalKey(Schema.Struct({ parts: Schema.optionalKey(Schema.Array(Part)) })),
          finishReason: Schema.optionalKey(Schema.String)
        })
      )
    ),
    usageMetadata: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          promptTokenCount: Schema.optionalKey(Schema.Number),
          cachedContentTokenCount: Schema.optionalKey(Schema.Number),
          candidatesTokenCount: Schema.optionalKey(Schema.Number),
          thoughtsTokenCount: Schema.optionalKey(Schema.Number),
          totalTokenCount: Schema.optionalKey(Schema.Number)
        }),
        [Schema.Record(Schema.String, Schema.Unknown)]
      )
    )
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
const parseChunk = Schema.decodeUnknownSync(Schema.fromJsonString(Chunk))
const decodeChunk = (value: string) => {
  const chunk = parseChunk(value)
  if (chunk.error) throw new Error(JSON.stringify({ error: chunk.error }))
  return chunk
}

// SSE records can span arbitrary TCP chunks, and data lines can span a record.
async function* chunks(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Google response has no body")
  const decoder = new TextDecoder()
  let pending = "",
    raw = "",
    mode: "sse" | "json" | undefined
  let data: string[] = []
  const parse = () => {
    const value = data.join("\n")
    data = []
    return value && value !== "[DONE]" ? decodeChunk(value) : null
  }
  try {
    while (true) {
      const next = await reader.read()
      pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      if (!mode && pending.trimStart()) mode = pending.trimStart().startsWith("{") ? "json" : "sse"
      if (mode === "json") {
        raw += pending
        pending = ""
      } else {
        let end: number
        while ((end = pending.search(/[\r\n]/)) >= 0) {
          // Wait for the next byte to distinguish CR from CRLF across chunks.
          if (pending[end] === "\r" && end === pending.length - 1 && !next.done) break
          const line = pending.slice(0, end)
          const width = pending[end] === "\r" && pending[end + 1] === "\n" ? 2 : 1
          pending = pending.slice(end + width)
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
          else if (line === "") {
            const chunk = parse()
            if (chunk) yield chunk
          }
        }
      }
      if (next.done) break
    }
    if (mode === "json") {
      yield decodeChunk(raw)
      return
    }
    if (pending.startsWith("data:")) data.push(pending.slice(5).trimStart())
    const chunk = parse()
    if (chunk) yield chunk
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (model, context, options = {}) => {
  const events = new AssistantMessageEventStream()
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "pending",
    timestamp: Date.now()
  }
  void (async () => {
    try {
      if (!options.fetch) throw new Error("Google requires the controlled transport")
      if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`)
      options.signal?.throwIfAborted()
      const normalized = collapseSystemMessages(context)
      const tools = getCurrentTools(normalized.messages)
      const system = getInitialSystemMessage(normalized.messages)
      const strict = supportsGoogleStrictToolSampling(model.id)
      const mode = tools.length ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict) : undefined
      const config: Record<string, unknown> = {
        ...(options.signal ? { abortSignal: options.signal } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        ...(system ? { systemInstruction: sanitizeSurrogates(getSystemMessageText(system)) } : {}),
        ...(tools.length ? { tools: convertTools(tools, false, strict) } : {}),
        ...(mode ? { toolConfig: { functionCallingConfig: { mode } } } : {}),
        ...(model.reasoning && options.thinking
          ? {
              thinkingConfig: options.thinking.enabled
                ? {
                    includeThoughts: true,
                    ...(options.thinking.level !== undefined
                      ? { thinkingLevel: toGoogleSdkThinkingLevel(options.thinking.level) }
                      : options.thinking.budgetTokens !== undefined
                        ? { thinkingBudget: options.thinking.budgetTokens }
                        : {})
                  }
                : getDisabledGoogleThinkingConfig(model)
            }
          : {})
      }
      const original = { model: model.id, contents: convertMessages(model, normalized), config }
      const payload = ((await options.onPayload?.(original, model)) ?? original) as typeof original
      const { model: resource, body } = googleRequest(payload)
      const url = `${model.baseUrl.replace(/\/$/, "")}/${resource}:streamGenerateContent?alt=sse`
      const response = await options.fetch(url, {
        method: "POST",
        ...(options.signal ? { signal: options.signal } : {}),
        headers:
          providerHeadersToRecord(
            { "content-type": "application/json", "x-goog-api-key": options.apiKey, "User-Agent": getPiUserAgent() },
            model.headers,
            options.headers
          ) ?? {},
        body: JSON.stringify(body)
      })
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model)
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      events.push({ type: "start", partial: output })
      let current: Extract<AssistantMessage["content"][number], { type: "text" | "thinking" }> | null = null
      const finishBlock = () => {
        if (!current) return
        if (current.type === "text")
          events.push({
            type: "text_end",
            contentIndex: output.content.length - 1,
            content: current.text,
            partial: output
          })
        else
          events.push({
            type: "thinking_end",
            contentIndex: output.content.length - 1,
            content: current.thinking,
            partial: output
          })
        current = null
      }
      for await (const chunk of chunks(response)) {
        await options.onProviderStreamEvent?.(chunk, model)
        if (chunk.responseId) output.responseId ||= chunk.responseId
        const blocked = chunk.promptFeedback?.blockReason
        if (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED") {
          output.rawStopReason = blocked
          output.stopReason = "error"
        }
        const candidate = chunk.candidates?.[0]
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text !== undefined) {
            const thinking = isThinkingPart(part)
            const type = thinking ? "thinking" : "text"
            if (!current || current.type !== type) {
              finishBlock()
              current = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" }
              output.content.push(current)
              events.push({
                type: thinking ? "thinking_start" : "text_start",
                contentIndex: output.content.length - 1,
                partial: output
              })
            }
            if (current.type === "text") {
              current.text += part.text
              if (part.thoughtSignature) current.textSignature = part.thoughtSignature
              events.push({
                type: "text_delta",
                delta: part.text,
                contentIndex: output.content.length - 1,
                partial: output
              })
            } else {
              current.thinking += part.text
              if (part.thoughtSignature) current.thinkingSignature = part.thoughtSignature
              events.push({
                type: "thinking_delta",
                delta: part.text,
                contentIndex: output.content.length - 1,
                partial: output
              })
            }
          }
          if (part.functionCall) {
            finishBlock()
            const call = part.functionCall
            const block = {
              type: "toolCall" as const,
              id:
                call.id && !output.content.some((b) => b.type === "toolCall" && b.id === call.id)
                  ? call.id
                  : `${call.name}_${uuidv7()}`,
              name: call.name,
              arguments: call.args ?? {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
            }
            output.content.push(block)
            events.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output })
            events.push({
              type: "toolcall_delta",
              delta: JSON.stringify(block.arguments),
              contentIndex: output.content.length - 1,
              partial: output
            })
            events.push({
              type: "toolcall_end",
              toolCall: block,
              contentIndex: output.content.length - 1,
              partial: output
            })
          }
        }
        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason
          output.stopReason = mapStopReasonString(candidate.finishReason)
          if (output.stopReason === "stop" && output.content.some((b) => b.type === "toolCall"))
            output.stopReason = "toolUse"
        }
        if (chunk.usageMetadata) {
          const u = chunk.usageMetadata
          output.usage.input = (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0)
          output.usage.cacheRead = u.cachedContentTokenCount ?? 0
          output.usage.output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
          output.usage.reasoning = u.thoughtsTokenCount ?? 0
          output.usage.totalTokens = u.totalTokenCount ?? 0
          calculateCost(model, output.usage)
        }
      }
      finishBlock()
      options.signal?.throwIfAborted()
      if (!["stop", "length", "toolUse"].includes(output.stopReason))
        throw new Error(
          output.rawStopReason
            ? `Google stream ended with ${output.rawStopReason}`
            : "Google stream ended without a finish reason"
        )
      if (
        output.stopReason === "stop" &&
        !output.content.some((block) => block.type === "toolCall" || (block.type === "text" && block.text.trim()))
      )
        throw new Error("Google returned no text or tool calls")
      events.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output })
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error"
      output.errorMessage = error instanceof Error ? error.message : String(error)
      events.push({ type: "error", reason: output.stopReason, error: output })
    } finally {
      events.end()
    }
  })()
  return events
}

// pi-ai 1.0.3 predates Gemini 4's thinkingLevel control. Its transcript, level
// mapping and all other model families still use the pinned helpers.
const gemini4 = (model: { readonly id: string }) => /^(?:models\/)?gemini-4-/i.test(model.id)
const usesGoogleThinkingLevel = (model: Parameters<typeof piUsesThinkingLevel>[0]) =>
  gemini4(model) || piUsesThinkingLevel(model)
const getDisabledGoogleThinkingConfig = (model: Parameters<typeof piDisabledThinkingConfig>[0]) =>
  gemini4(model) ? { thinkingLevel: toGoogleSdkThinkingLevel("LOW") } : piDisabledThinkingConfig(model)

const googleBudget = (model: string, level: string) => {
  const budgets = model.includes("2.5-pro")
    ? [128, 2048, 8192, 32768]
    : model.includes("2.5-flash-lite")
      ? [512, 2048, 8192, 24576]
      : model.includes("2.5-flash")
        ? [128, 2048, 8192, 24576]
        : null
  return budgets?.[["minimal", "low", "medium", "high"].indexOf(level)] ?? -1
}

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
  model,
  context,
  options = {}
) => {
  const base = buildBaseOptions(model, context, options, options.apiKey)
  const clamped = options.reasoning ? clampThinkingLevel(model, options.reasoning) : "off"
  const level = clamped === "off" ? "off" : resolveGoogleThinkingLevel(model, clamped)
  const thinking =
    level === "off"
      ? { enabled: false }
      : usesGoogleThinkingLevel(model)
        ? { enabled: true, level: toGoogleThinkingLevel(level) }
        : { enabled: true, budgetTokens: options.thinkingBudgets?.[level] ?? googleBudget(model.id, level) }
  return stream(model, context, {
    ...base,
    thinking,
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {})
  })
}
