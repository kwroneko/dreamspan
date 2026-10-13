// Usage capture, normalization and cost (spec/PROVIDERS.md §9.2, §9.3).
//
// Keep the raw provider usage alongside pi's normalized counts, and fill the
// documented hit fields compatible adapters omit. This also retains reported cost,
// routed upstream and refusal details for the ledger.
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai"
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate"
import type { Price } from "@rp/shared/providers.ts"
import { type Cost, type TokenCounts, unknownCounts, type UsageSource } from "@rp/shared/usage.ts"
import { Option, Predicate, Schema } from "effect"
import type { CostFormula, RequestTarget } from "./registry.ts"

/** What a request's raw provider events told us, beyond pi's normalized message. */
export interface Capture {
  headerCacheRead: number | null
  rawUsage: Record<string, unknown> | null
  reportedCost: number | null
  upstream: string | null
  refusalCategory: string | null
}

export const emptyCapture = (): Capture => ({
  headerCacheRead: null,
  rawUsage: null,
  reportedCost: null,
  upstream: null,
  refusalCategory: null
})

const decodeHeaderCount = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
)
// Dedicated Fireworks: https://docs.fireworks.ai/guides/prompt-caching
// This is token reuse, unlike a gateway's whole-response cache-status header.
export const captureUsageHeaders = (headers: Headers, capture: Capture) => {
  const hit = headers.get("fireworks-cached-prompt-tokens")
  if (hit !== null) capture.headerCacheRead = Option.getOrNull(decodeHeaderCount(hit))
}

const record = (value: unknown) => (Predicate.isObject(value) ? (value as Record<string, unknown>) : null)

/**
 * Raw usage readers for the built-in wire APIs, registered as response observers
 * (registry.ts). They read the provider's parsed stream events, read-only.
 */
export const usageObservers: Record<string, (data: unknown, capture: Capture) => void> = {
  "openai-completions": (data, capture) => {
    const event = record(data)
    if (!event) return
    const usage = record(event.usage)
    if (usage) {
      capture.rawUsage = usage
      if (Predicate.isNumber(usage.cost)) capture.reportedCost = usage.cost
    }
    // OpenRouter names the provider it routed to on every chunk.
    if (Predicate.isString(event.provider)) capture.upstream = event.provider
  },
  "openai-responses": (data, capture) => {
    const usage = record(record(record(data)?.response)?.usage)
    if (usage) capture.rawUsage = usage
  },
  "anthropic-messages": (data, capture) => {
    const event = record(data)
    if (!event) return
    // message_start carries the input side; message_delta the final counts.
    const usage = record(event.type === "message_start" ? record(event.message)?.usage : event.usage)
    if (usage) capture.rawUsage = { ...capture.rawUsage, ...usage }
    const stop = record(record(event.delta)?.stop_details)
    if (stop && Predicate.isString(stop.category) && stop.category.length > 0) capture.refusalCategory = stop.category
  },
  "google-generative-ai": (data, capture) => {
    const usage = record(record(data)?.usageMetadata)
    if (usage) capture.rawUsage = usage
  }
}

usageObservers["google-vertex"] = usageObservers["google-generative-ai"]!
usageObservers["azure-openai-responses"] = usageObservers["openai-responses"]!
usageObservers["bedrock-converse-stream"] = (data, capture) => {
  const usage = record(record(record(data)?.metadata)?.usage)
  if (usage) capture.rawUsage = usage
}

const countsFromUsage = (usage: Usage): TokenCounts => ({
  inputUncached: usage.input,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  // Only Anthropic reports a long-TTL split; elsewhere no write is billed as long.
  cacheWriteLong: usage.cacheWrite1h ?? 0,
  output: usage.output,
  reasoning: usage.reasoning ?? null
})

const messageText = (message: AssistantMessage) =>
  message.content
    .map((block) => (block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : ""))
    .join("")

/**
 * The counts to record. Reported when the provider sent usage; estimated when it
 * produced output without reporting usage (a stop mid-stream, a server that doesn't
 * stream usage); unknown when nothing came back at all.
 */
export const finalCounts = (
  message: AssistantMessage,
  capture: Capture,
  context: ReadonlyArray<Message>
): { counts: TokenCounts; source: UsageSource } => {
  const text = messageText(message)
  const finished = message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse"
  if (capture.rawUsage !== null) {
    let counts = countsFromUsage(message.usage)
    // pi's compatible Chat adapter does not preserve every upstream's hit spelling.
    // PROVIDER-CACHE-TTLS.md: Anthropic/Bedrock, Chat/Responses, Gemini, Together,
    // and Vercel AI Gateway. A discount alone never proves a token cache hit.
    const raw = capture.rawUsage
    const hit = [
      raw.cache_read_input_tokens,
      raw.cacheReadInputTokens,
      record(raw.prompt_tokens_details)?.cached_tokens,
      record(raw.input_tokens_details)?.cached_tokens,
      raw.prompt_cache_hit_tokens,
      raw.cachedContentTokenCount,
      raw.total_cached_tokens,
      raw.cached_tokens,
      record(raw.inputTokenDetails)?.cacheReadTokens,
      capture.headerCacheRead
    ].find((v) => Predicate.isNumber(v) && v >= 0)
    if (Predicate.isNumber(hit)) {
      const totalInput = (counts.inputUncached ?? 0) + (counts.cacheRead ?? 0)
      counts = {
        ...counts,
        cacheRead: hit,
        inputUncached: Predicate.isNumber(raw.prompt_cache_miss_tokens)
          ? raw.prompt_cache_miss_tokens
          : Math.max(0, totalInput - hit)
      }
    }
    if (finished) return { counts, source: "reported" }
    // A stopped or failed request may have reported only its start (Anthropic sends
    // output_tokens: 1 in message_start), so output is at least what actually arrived.
    const estimated = estimateTextTokens(text)
    return estimated > (counts.output ?? 0)
      ? { counts: { ...counts, output: estimated, reasoning: null }, source: "estimated" }
      : { counts, source: "reported" }
  }
  if (text.length === 0 && message.stopReason !== "stop" && message.stopReason !== "length") {
    return capture.headerCacheRead === null
      ? { counts: unknownCounts, source: "none" }
      : { counts: { ...unknownCounts, cacheRead: capture.headerCacheRead }, source: "reported" }
  }
  return {
    counts: {
      ...unknownCounts,
      // A documented header may report cache reads even without streamed usage.
      inputUncached: Math.max(0, estimateContextTokens(context).tokens - (capture.headerCacheRead ?? 0)),
      cacheRead: capture.headerCacheRead,
      output: estimateTextTokens(text)
    },
    source: "estimated"
  }
}

/**
 * The built-in formula (PROVIDERS §9.3): multipliers per million tokens, with the tier
 * for the request's total input. Long cache writes are priced at twice the input rate,
 * Anthropic's rule, which pi-ai applies too; nobody else bills long writes.
 */
export const priceCost = (counts: TokenCounts, price: Price): number | null => {
  const { inputUncached, cacheRead, cacheWrite, output } = counts
  if (inputUncached === null || output === null) return null
  const read = cacheRead ?? 0
  const write = cacheWrite ?? 0
  const long = Math.min(counts.cacheWriteLong ?? 0, write)
  const totalInput = inputUncached + read + write
  const tier = (price.tiers ?? [])
    .filter((t) => totalInput > t.inputTokensAbove)
    .reduce<(typeof price.tiers & object)[number] | null>(
      (best, t) => (best === null || t.inputTokensAbove > best.inputTokensAbove ? t : best),
      null
    )
  const rates = tier ?? price
  const rate = (value: number | undefined) => value ?? 0
  return (
    (inputUncached * rates.input +
      read * rate(rates.cacheRead) +
      (write - long) * rate(rates.cacheWrite) +
      long * rates.input * 2 +
      output * rates.output) /
    1e6
  )
}

/** The cost to record: the first formula, newest registration first, that returns one. */
export const costOf = (
  formulas: ReadonlyArray<CostFormula>,
  target: RequestTarget & { readonly model: string },
  input: Parameters<CostFormula["cost"]>[0]
): Cost | null => {
  for (const formula of [...formulas].reverse()) {
    if (!formula.appliesTo(target)) continue
    const cost = formula.cost(input)
    if (cost !== null) return { ...cost, formula: formula.id }
  }
  return null
}

/**
 * The built-in formulas, registered oldest first (builtins.ts): the price table, then the
 * provider's own figure when it reports one, which reflects the actual route and any
 * discount and so is tried before the table.
 */
export const builtinCostFormulas: ReadonlyArray<CostFormula> = [
  {
    id: "builtin",
    appliesTo: () => true,
    upperBound: ({ inputTokens, outputTokens, price }) => {
      if (!price) return null
      const rates = [price, ...(price.tiers ?? [])]
      const input = Math.max(...rates.flatMap((r) => [r.input, r.cacheRead ?? 0, r.cacheWrite ?? 0, r.input * 2]))
      const output = Math.max(...rates.map((r) => r.output))
      return { amount: (inputTokens * input + outputTokens * output) / 1e6, currency: "USD" }
    },
    cost: ({ counts, price }) => {
      const amount = price === null ? null : priceCost(counts, price)
      return amount === null ? null : { amount, currency: "USD" }
    }
  },
  {
    id: "reported",
    appliesTo: () => true,
    cost: ({ capture }) => (capture.reportedCost === null ? null : { amount: capture.reportedCost, currency: "USD" })
  }
]
