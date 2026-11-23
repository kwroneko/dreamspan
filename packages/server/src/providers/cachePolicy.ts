// Dated provider contracts, not pi-ai's promptCache guesses. Unknown is null, never
// a retention ceiling. See spec/PROVIDER-CACHE-TTLS.md (2026-10-13) for qualifications.
import { Predicate } from "effect"

export interface CachePolicy {
  readonly ttlS: number
  readonly fixed: boolean
  readonly source: string
}
interface Target {
  readonly provider: string
  readonly api: string
  readonly model: string
}
const object = (value: unknown): Record<string, unknown> =>
  Predicate.isObject(value) ? (value as Record<string, unknown>) : {}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
// Only wire control locations, never arbitrary schemas, function arguments or results.
const markers = (target: Target, payload: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> => {
  const { api, provider } = target
  const messages = array(payload.messages)
  const content = messages.flatMap((m) => array(object(m).content))
  let locations: unknown[]
  if (api === "bedrock-converse-stream") {
    locations = [...array(payload.system), ...content, ...array(object(payload.toolConfig).tools)]
    return locations
      .map((v) => object(object(v).cachePoint))
      .filter((v) => v.type === "default" && (v.ttl === undefined || v.ttl === "5m" || v.ttl === "1h"))
  }
  if (["qwen", "dashscope"].includes(provider) && ["anthropic-messages", "openai-completions"].includes(api))
    locations = content
  else if (api === "anthropic-messages")
    locations = [payload, ...array(payload.system), ...array(payload.tools), ...content]
  else if (api === "openai-completions") locations = [payload, ...messages, ...array(payload.tools), ...content]
  else return []
  return locations
    .map((v) => object(object(v).cache_control))
    .filter((v) => v.type === "ephemeral" && (v.ttl === undefined || v.ttl === "5m" || v.ttl === "1h"))
}
const policy = (ttlS: number, source: string, fixed = false): CachePolicy => ({ ttlS, source, fixed })
const claudeSource = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
const openaiSource = "https://developers.openai.com/api/docs/guides/prompt-caching"
const routerSource = "https://openrouter.ai/docs/guides/best-practices/prompt-caching"
const bedrockSource = "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html"
const azureSource = "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching"

const newerGPT = (model: string) => {
  const family = /(?:^|[/.])gpt-(\d+)(?:\.(\d+))?/i.exec(model)
  return family !== null && (+family[1]! > 5 || (+family[1]! === 5 && +(family[2] ?? 0) >= 6))
}
/**
 * An OpenAI model's id as its family names it: a fine-tune (`ft:gpt-4.1-mini:org::id`) is its base
 * model's, and a router's or gateway's vendor prefix (`openai/gpt-4o`) is left out.
 */
const openaiFamily = (model: string) => model.replace(/^ft:/, "").replace(/^openai\//, "")
// API-compatible local models and legacy GPT-3/4 do not inherit a cache contract.
const knownOpenAI = (model: string) => {
  const family = openaiFamily(model)
  return newerGPT(family) || /^(gpt-(?:4o|4\.[15]|5)(?:[.-]|$)|o[1-9]\d*(?:-|$)|chatgpt-4o(?:-|$))/i.test(family)
}
/** OpenAI's policy for one of its models, wherever it's served: 30 minutes for GPT-5.5 and later. */
const openaiPolicy = (model: string, payload: Record<string, unknown>, source: string) => {
  const family = openaiFamily(model)
  return policy(
    newerGPT(family) || /^gpt-5\.5(?:-|$)/.test(family) || payload.prompt_cache_retention === "24h" ? 1800 : 300,
    source
  )
}

/** OpenAI's models on Bedrock's OpenAI-compatible APIs (`us.openai.gpt-5.6-sol`, `openai.gpt-oss-120b`). */
const bedrockOpenAI = (model: string, api: string) =>
  (api === "openai-responses" || api === "openai-completions") && /(?:^|\.)openai\.gpt-/.test(model)

export const documentedCachePolicy = (target: Target, payload: Record<string, unknown> = {}): CachePolicy | null => {
  const provider =
    target.provider === "openai-chat" || target.provider === "openai-responses" ? "openai" : target.provider
  const model = target.model.toLowerCase()
  const cacheMarkers = markers(target, payload)
  const explicit = cacheMarkers.length > 0
  // Mixed Anthropic marker lifetimes expire at the shortest marked prefix.
  const hour = explicit && cacheMarkers.every((m) => m.ttl === "1h")
  if (provider === "anthropic") return policy(hour ? 3600 : 300, claudeSource)
  if (provider === "openai" && knownOpenAI(model)) return openaiPolicy(model, payload, openaiSource)
  if (provider === "azure" && knownOpenAI(model)) {
    const family = openaiFamily(model)
    if (newerGPT(family)) return policy(1800, azureSource)
    return payload.prompt_cache_retention === "24h" || /^gpt-5\.5(?:-|$)/.test(family) ? null : policy(300, azureSource)
  }
  if (provider === "openrouter") {
    const pinned = object(payload.provider).only
    // Claude through OpenRouter caches only at markers (or a top-level control).
    if (model.startsWith("anthropic/claude"))
      return explicit
        ? policy(hour ? (Array.isArray(pinned) && pinned.length === 1 ? 3600 : 600) : 300, routerSource)
        : null
    if (model.startsWith("google/gemini")) return policy(explicit ? 300 : 180, routerSource, explicit)
    // OpenAI's models through OpenRouter cache automatically, with OpenAI's lifetimes (routerSource).
    if (model.startsWith("openai/") && knownOpenAI(model)) return openaiPolicy(model, payload, routerSource)
    // Other upstreams (DeepSeek, xAI, Moonshot...) state no lifetime through OpenRouter.
    return null
  }
  if (["moonshotai", "moonshotai-cn"].includes(provider) && /(?:kimi[-/]?)?k3(?:[-.]|$)/.test(model)) {
    const options = object(payload.prompt_cache_options)
    // K3 Messages ignores per-message markers: only its top-level control writes.
    const long =
      target.api === "anthropic-messages"
        ? cacheMarkers.includes(object(payload.cache_control)) && object(payload.cache_control).ttl === "1h"
        : options.mode === "implicit" && options.ttl === "1h"
    return policy(long ? 3600 : 300, "https://platform.kimi.ai/docs/guide/context-caching")
  }
  if (
    ["qwen", "dashscope"].includes(provider) &&
    ["openai-completions", "anthropic-messages"].includes(target.api) &&
    explicit
  )
    return policy(300, "https://www.alibabacloud.com/help/en/model-studio/context-cache")
  if (provider === "groq" && /(?:^|\/)gpt-oss-(?:20b|120b|safeguard-20b)(?:-|$)/.test(model))
    return policy(7200, "https://console.groq.com/docs/prompt-caching")
  // Anthropic Messages on Bedrock or Vertex AI serves only Claude, whatever the id names (an
  // inference profile's ARN, a custom deployment): the connection's API decides, not the id.
  const claudeOnly = target.api === "anthropic-messages"
  if (provider === "amazon-bedrock") {
    if (model.includes("claude") || claudeOnly) return policy(hour ? 3600 : 300, bedrockSource)
    if (["openai-completions", "openai-responses"].includes(target.api) && newerGPT(model))
      return policy(1800, bedrockSource)
  }
  if (provider === "google-vertex" && (model.includes("claude") || claudeOnly))
    return policy(
      hour ? 3600 : 300,
      "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching"
    )
  if (["minimax", "minimax-cn"].includes(provider) && target.api === "anthropic-messages" && explicit)
    return policy(300, "https://platform.minimax.io/docs/api-reference/text-prompt-caching")
  if (provider === "cerebras")
    return policy(300, "https://inference-docs.cerebras.ai/capabilities/prompt-caching", true)
  if (provider === "vercel-ai-gateway" && /^(anthropic\/claude|minimax\/)/.test(model))
    return policy(
      hour || payload.cache_ttl === "1h" ? 3600 : 300,
      "https://vercel.com/docs/ai-gateway/models-and-providers/provider-options"
    )
  // Gemini implicit has no documented TTL. Explicit cachedContents are resources:
  // their returned expireTime must be used; this app does not create those objects.
  return null
}

/**
 * The documented minimum cacheable prefix, in tokens: a shorter prefix is never cached, whatever
 * its markers. Null where no minimum is documented for the model.
 */
export const documentedCacheMinimum = (target: Target): number | null => {
  const provider =
    target.provider === "openai-chat" || target.provider === "openai-responses" ? "openai" : target.provider
  const model = target.model.toLowerCase()
  const claude = /claude-?((?:fable|mythos|opus|sonnet|haiku)[-.]?[\w.-]*)/.exec(model)?.[1]?.replace(/\./g, "-")
  if (
    claude &&
    ["anthropic", "openrouter", "amazon-bedrock", "google-vertex", "vercel-ai-gateway"].includes(provider)
  ) {
    // claudeSource, "Cache limitations" (read 2026-11-07).
    if (/^(fable|mythos-5|opus-5|sonnet-5-5|haiku-5)/.test(claude)) return 512
    if (/^(mythos-preview|opus-4-7)/.test(claude)) return 2048
    if (/^(opus-4-6|opus-4-5|haiku-4-5)/.test(claude)) return 4096
    if (/^(opus-4-8|sonnet-5|sonnet-4|opus-4)/.test(claude)) return 1024
    return null
  }
  // openaiSource and routerSource: 1,024 tokens for OpenAI's automatic caching.
  if ((provider === "openai" || provider === "azure") && knownOpenAI(model)) return 1024
  // bedrockSource: 1,024 per marker for GPT-5.6 and later, and for earlier models' automatic cache.
  if (provider === "amazon-bedrock" && bedrockOpenAI(model, target.api)) return 1024
  if (provider === "openrouter" && /^openai\//.test(model)) return 1024
  // Google generateContent implicit caching, read 2026-11-12. No minimum is
  // inferred for unlisted models, including Flash-Lite aliases.
  if (provider === "google" && target.api === "google-generative-ai") {
    if (/^gemini-2\.5-(?:flash|pro)(?:-\d+)?$/.test(model)) return 2048
    if (/^gemini-(?:4-(?:argon|carbon)|3\.[68]-flash|3\.1-pro-preview)(?:-\d+)?$/.test(model)) return 4096
  }
  // routerSource: Gemini Pro 4,096, Flash 1,024.
  if (provider === "openrouter" && /^google\/gemini/.test(model)) return /pro/.test(model) ? 4096 : 1024
  return null
}

/**
 * OpenAI's automatic prompt cache, direct, on Azure or through OpenRouter: best effort, with no
 * markers and its own routing, so the estimate is calibrated from the reads it reports.
 */
export const bestEffortCache = (target: Target): boolean => {
  const provider =
    target.provider === "openai-chat" || target.provider === "openai-responses" ? "openai" : target.provider
  const model = target.model.toLowerCase()
  if (provider === "openai" || provider === "azure") return knownOpenAI(model)
  // Bedrock's automatic cache for OpenAI's models is "best effort" too (bedrockSource): every model
  // on Chat Completions, which takes no markers there, and models before GPT-5.6 on Responses.
  if (provider === "amazon-bedrock" && bedrockOpenAI(model, target.api))
    return target.api === "openai-completions" || !newerGPT(model)
  return provider === "openrouter" && /^openai\//.test(model)
}
