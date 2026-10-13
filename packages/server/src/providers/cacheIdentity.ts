// Scheduling identity is separate from the inspector's deliberately text-only projection.
// Raw tools, images and routing data are hashed here in memory; only digests leave this module.
import { createHash } from "node:crypto"
import { Predicate } from "effect"
import { canonicalJson } from "@rp/shared/editing.ts"
import type { WireContext } from "../assembler/types.ts"
import { sentWire } from "../assembler/wire.ts"

const outputFields = new Set([
  "temperature",
  "top_p",
  "top_k",
  "topP",
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
  "repetition_penalty",
  "stream",
  "stream_options"
])
const fieldsExcept = (record: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key) && !outputFields.has(key)))

/** Digests of covered endpoints, in provider prefix order. The last is the requested endpoint. */
export const cacheIdentity = (input: {
  readonly payload: Record<string, unknown>
  readonly api: string
  readonly mode: "none" | "auto" | "explicit"
  readonly retention?: "none" | "short" | "long" | undefined
  readonly sessionId?: string | undefined
  readonly scope: ReadonlyArray<unknown>
  readonly sources: WireContext
  readonly end: number
}): ReadonlyArray<string> => {
  const { payload, api, mode, retention, sources, end } = input
  if (mode === "none" || retention === "none" || end < 0) return []
  const explicit = mode === "explicit" || api === "anthropic-messages"
  const google = api === "google-generative-ai"
  const messageField = google ? "contents" : api === "openai-responses" ? "input" : "messages"
  if (!["google-generative-ai", "openai-responses", "openai-completions", "anthropic-messages"].includes(api)) return []
  const config = Predicate.isObject(payload.config) ? (payload.config as Record<string, unknown>) : {}
  const system = google ? config.systemInstruction : payload.system
  const messages = payload[messageField]
  if (!Array.isArray(messages)) return []

  // Include final prompt_cache_key, retention, tool choice, response schemas, provider
  // routing preferences and any other non-sampling fields. Session affinity can also
  // travel in SDK headers, independently of a final payload's prompt_cache_key.
  const hash = createHash("sha256").update(
    canonicalJson([
      "cache-prefix-v1",
      input.scope,
      input.sessionId ?? null,
      fieldsExcept(payload, [messageField, "system", "tools", "config"]),
      fieldsExcept(config, ["systemInstruction", "tools"])
    ])
  )
  const covered: string[] = []
  const add = (value: unknown) => {
    hash.update(canonicalJson(value))
    hash.update("\n")
  }
  const checkpoint = (marker: unknown = null) => covered.push(hash.copy().update(canonicalJson(marker)).digest("hex"))
  const block = (value: unknown) => {
    if (!Predicate.isObject(value)) {
      add(value)
      return
    }
    // Strip only the block's marker, never similarly named properties inside tool schemas.
    const { cache_control, ...content } = value as Record<string, unknown>
    add(content)
    if (explicit && Predicate.isObject(cache_control) && cache_control.type === "ephemeral") checkpoint(cache_control)
  }
  add("tools")
  const tools = payload.tools ?? config.tools
  if (Array.isArray(tools)) for (const tool of tools) block(tool)
  else add(tools ?? null)
  add("system")
  if (Array.isArray(system)) for (const part of system) block(part)
  else add(system ?? null)
  add("messages")
  const systemCovered =
    !explicit &&
    sentWire({ ...payload, [messageField]: [] }, sources).messages.some((m) => m.inputs.some((i) => i <= end))
  if (systemCovered) checkpoint()
  let last = -1
  if (!explicit) {
    // Provenance locates the endpoint only. Hash the actual structured payload, including
    // unassigned/tool messages before that endpoint, rather than its display projection.
    last = messages.findLastIndex((message) =>
      sentWire({ [messageField]: [message] }, sources).messages.some((m) => m.inputs.some((i) => i <= end))
    )
  }
  for (const [index, message] of messages.entries()) {
    if (!explicit && index > last) break
    if (Predicate.isObject(message)) {
      const { content, parts, ...header } = message as Record<string, unknown>
      add(header)
      const blocks = content ?? parts
      if (Array.isArray(blocks)) for (const part of blocks) block(part)
      else block(blocks ?? null)
      add("end-message")
    } else add(message)
    if (!explicit) checkpoint()
  }
  return covered
}
