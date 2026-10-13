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

interface Identity {
  readonly requested: string | null
  readonly prefixes: ReadonlyArray<string>
}
const empty: Identity = { requested: null, prefixes: [] }
const marker = (value: unknown) =>
  Predicate.isObject(value) &&
  value.type === "ephemeral" &&
  (value.ttl === undefined || value.ttl === "5m" || value.ttl === "1h")
const cacheable = (value: unknown) =>
  typeof value === "string"
    ? value.length > 0
    : Predicate.isObject(value) && !["thinking", "redacted_thinking"].includes(String(value.type))

/** Keep the reusable scheduling endpoint separate from all checkpoints written by a request. */
export const cacheIdentity = (input: {
  readonly payload: Record<string, unknown>
  readonly api: string
  readonly mode: "none" | "auto" | "explicit"
  readonly retention?: "none" | "short" | "long" | undefined
  readonly scope: ReadonlyArray<unknown>
  readonly sources: WireContext
  readonly end: number
}): Identity => {
  const { payload, api, mode, retention, sources, end } = input
  if (mode === "none" || retention === "none" || end < 0) return empty
  const explicit = mode === "explicit" || api === "anthropic-messages"
  const automaticMarker =
    api === "anthropic-messages" && marker(payload.cache_control) ? payload.cache_control : undefined
  const google = api === "google-generative-ai"
  const messageField = google ? "contents" : api === "openai-responses" ? "input" : "messages"
  if (!["google-generative-ai", "openai-responses", "openai-completions", "anthropic-messages"].includes(api))
    return empty
  const config = Predicate.isObject(payload.config) ? (payload.config as Record<string, unknown>) : {}
  const system = google ? config.systemInstruction : payload.system
  const messages = payload[messageField]
  if (!Array.isArray(messages)) return empty

  // Provenance only locates the reusable endpoint. The actual structured blocks,
  // tools and unassigned insertions before it supply the identity.
  const last = messages.findLastIndex((message) =>
    sentWire({ [messageField]: [message] }, sources).messages.some((m) => m.inputs.some((i) => i <= end))
  )
  const systemEnd =
    last === -1 &&
    sentWire({ ...payload, [messageField]: [] }, sources).messages.some((m) => m.inputs.some((i) => i <= end))
  if (last === -1 && !systemEnd) return empty
  const hash = createHash("sha256").update(
    canonicalJson([
      "cache-prefix-v2",
      input.scope,
      fieldsExcept(payload, [messageField, "system", "tools", "config"]),
      fieldsExcept(config, ["systemInstruction", "tools"])
    ])
  )
  const prefixes: string[] = []
  let requested: string | null = null
  let implicit: string | null = null
  const add = (value: unknown) => {
    hash.update(canonicalJson(value))
    hash.update("\n")
  }
  const digest = (control: unknown = null) => hash.copy().update(canonicalJson(control)).digest("hex")
  const block = (value: unknown, endpoint: boolean) => {
    const { cache_control, ...content } = Predicate.isObject(value) ? (value as Record<string, unknown>) : { value }
    add(Predicate.isObject(value) ? content : value)
    if (!cacheable(value)) return
    if (explicit && marker(cache_control)) {
      const key = digest(cache_control)
      prefixes.push(key)
      if (endpoint) requested = key
    }
    // Top-level Anthropic control places a marker on the last cacheable block,
    // not on a trailing thinking block. Remember only that effective endpoint.
    if (automaticMarker) implicit = digest(automaticMarker)
  }
  const blocks = (value: unknown, endpoint: boolean) => {
    const parts = Array.isArray(value) ? value : [value ?? null]
    const lastCacheable = parts.findLastIndex(cacheable)
    for (const [index, part] of parts.entries()) block(part, endpoint && index === lastCacheable)
  }
  add("tools")
  const tools = payload.tools ?? config.tools
  if (Array.isArray(tools)) for (const tool of tools) block(tool, false)
  else add(tools ?? null)
  add("system")
  blocks(system, systemEnd)
  add("messages")
  if (!explicit && systemEnd) {
    requested = digest()
    prefixes.push(requested)
  }
  for (const [index, message] of messages.entries()) {
    if (Predicate.isObject(message)) {
      const { content, parts, ...header } = message as Record<string, unknown>
      add(header)
      blocks(content ?? parts, index === last)
      add("end-message")
    } else block(message, index === last)
    if (!explicit) {
      const key = digest()
      prefixes.push(key)
      if (index === last) requested = key
    }
  }
  if (implicit !== null) {
    prefixes.push(implicit)
    // Automatic placement can be the only checkpoint; an actual explicit marker
    // at the reusable boundary takes precedence over this whole-request endpoint.
    requested ??= implicit
  }
  return { requested, prefixes }
}

/** SDK session IDs matter only through the routing fields actually sent to the transport. */
export const routeCacheIdentity = (identity: Identity, headers: Headers): Identity => {
  const routing = ["session_id", "x-session-id", "x-session-affinity", "x-client-request-id", "x-grok-conv-id"].map(
    (name) => [name, headers.get(name)]
  )
  const routed = (prefix: string) =>
    createHash("sha256")
      .update(canonicalJson([prefix, routing]))
      .digest("hex")
  return {
    requested: identity.requested === null ? null : routed(identity.requested),
    prefixes: identity.prefixes.map(routed)
  }
}
