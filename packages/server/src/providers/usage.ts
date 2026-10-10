// Usage capture, normalization and cost (spec/PROVIDERS.md §9.2, §9.3).
//
// pi-ai already normalizes every adapter to uncached input + cache reads + cache writes
// + output, which we verified per adapter. On top of that we keep the provider's own
// usage object verbatim (seen through onProviderStreamEvent), so a normalization that
// turns out wrong for some upstream can be recounted later, and so we can read what pi
// drops: OpenRouter's reported cost and routed upstream, Anthropic's refusal category.
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai"
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate"
import type { Price, WireApi } from "@rp/shared/providers.ts"
import { type Cost, type TokenCounts, unknownCounts, type UsageSource } from "@rp/shared/usage.ts"
import { Predicate } from "effect"

/** What a request's raw provider events told us, beyond pi's normalized message. */
export interface Capture {
  rawUsage: Record<string, unknown> | null
  reportedCost: number | null
  upstream: string | null
  refusalCategory: string | null
}

export const emptyCapture = (): Capture => ({
  rawUsage: null,
  reportedCost: null,
  upstream: null,
  refusalCategory: null
})

const record = (value: unknown) => (Predicate.isObject(value) ? (value as Record<string, unknown>) : null)

/** Reads one provider stream event (already parsed by the adapter, read-only). */
export const captureEvent = (api: WireApi, data: unknown, capture: Capture) => {
  const event = record(data)
  if (!event) return
  switch (api) {
    case "openai-completions": {
      const usage = record(event.usage)
      if (usage) {
        capture.rawUsage = usage
        if (Predicate.isNumber(usage.cost)) capture.reportedCost = usage.cost
      }
      // OpenRouter names the provider it routed to on every chunk.
      if (Predicate.isString(event.provider)) capture.upstream = event.provider
      return
    }
    case "openai-responses": {
      const usage = record(record(event.response)?.usage)
      if (usage) capture.rawUsage = usage
      return
    }
    case "anthropic-messages": {
      // message_start carries the input side; message_delta the final counts.
      const usage = record(event.type === "message_start" ? record(event.message)?.usage : event.usage)
      if (usage) capture.rawUsage = { ...capture.rawUsage, ...usage }
      const stop = record(record(event.delta)?.stop_details)
      if (stop && Predicate.isString(stop.category) && stop.category.length > 0) capture.refusalCategory = stop.category
      return
    }
    case "google-generative-ai": {
      const usage = record(event.usageMetadata)
      if (usage) capture.rawUsage = usage
      return
    }
  }
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
  if (capture.rawUsage !== null) return { counts: countsFromUsage(message.usage), source: "reported" }
  const text = messageText(message)
  if (text.length === 0 && message.stopReason !== "stop" && message.stopReason !== "length") {
    return { counts: unknownCounts, source: "none" }
  }
  return {
    counts: {
      ...unknownCounts,
      // Whether any of it was cached isn't known, so all of it counts as uncached.
      inputUncached: estimateContextTokens(context).tokens,
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

/**
 * The cost to record: the provider's own figure when it reports one (it reflects the
 * actual route and any discount), else the built-in price. User formulas come later.
 */
export const recordedCost = (counts: TokenCounts, capture: Capture, price: Price | null): Cost | null => {
  if (capture.reportedCost !== null) return { amount: capture.reportedCost, currency: "USD", formula: "reported" }
  if (price === null) return null
  const amount = priceCost(counts, price)
  return amount === null ? null : { amount, currency: "USD", formula: "builtin" }
}
