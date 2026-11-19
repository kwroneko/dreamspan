// Anthropic's own API (the `anthropic` kind). Every model the deprecation page lists as active
// or deprecated-but-callable on 2026-11-16, with its priced name from the pricing page.
// Not here: claude-mythos-preview (deprecated, still callable, but the pricing page has no row).
import type { Price } from "@dreamspan/shared/providers.ts"
import type { PriceEntry, PriceTable } from "./types.ts"

const source = "https://platform.claude.com/docs/en/about-claude/pricing"
const checked = "2026-11-16"
const geo =
  "US-only inference (`inference_geo`) costs 1.1x on Claude 4.6 and later; the app doesn't send it, so it isn't priced."

/** Base input, 5-minute write, 1-hour write, cache hit, output, per million tokens. */
export const claude = (input: number, write: number, writeLong: number, read: number, output: number): Price => ({
  input,
  output,
  cacheRead: read,
  cacheWrite: write,
  cacheWriteLong: writeLong
})

const entry = (price: Price, note?: string): PriceEntry => ({ price, source, checked, ...(note ? { note } : {}) })

// Claude Haiku 5.5: "a request whose prompt is over 100,000 tokens pays higher prices", counting
// cache reads and writes, for the whole request.
const haiku55: Price = {
  ...claude(0.1, 0.125, 0.2, 0.01, 0.5),
  tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 }]
}

export const anthropicPrices: PriceTable = {
  "claude-fable-5-2": entry(claude(8, 10, 16, 0.2, 40), geo),
  "claude-mythos-5-2": entry(claude(8, 10, 16, 0.2, 40), "Limited availability."),
  "claude-fable-5-1": entry(claude(10, 12.5, 20, 0.25, 50), geo),
  "claude-mythos-5-1": entry(claude(10, 12.5, 20, 0.25, 50), "Limited availability."),
  "claude-fable-5": entry(claude(10, 12.5, 20, 1, 50), geo),
  "claude-mythos-5": entry(claude(10, 12.5, 20, 1, 50), "Limited availability."),
  "claude-opus-5-5": entry(claude(4, 5, 8, 0.2, 20), geo),
  "claude-opus-5": entry(claude(5, 6.25, 10, 0.5, 25), geo),
  "claude-opus-4-8": entry(claude(5, 6.25, 10, 0.5, 25), geo),
  "claude-opus-4-7": entry(claude(5, 6.25, 10, 0.5, 25), geo),
  "claude-opus-4-6": entry(claude(5, 6.25, 10, 0.5, 25), geo),
  "claude-opus-4-5-20251101": entry(claude(5, 6.25, 10, 0.5, 25)),
  "claude-opus-4-5": entry(claude(5, 6.25, 10, 0.5, 25), "The undated alias of claude-opus-4-5-20251101."),
  "claude-sonnet-5-5": entry(claude(2, 2.5, 4, 0.1, 10), geo),
  "claude-sonnet-5": entry(claude(2, 2.5, 4, 0.2, 10), geo),
  "claude-sonnet-4-6": entry(claude(3, 3.75, 6, 0.3, 15), geo),
  "claude-sonnet-4-5-20250929": entry(claude(3, 3.75, 6, 0.3, 15), "Deprecated; retires 2026-11-30."),
  "claude-sonnet-4-5": entry(claude(3, 3.75, 6, 0.3, 15), "The undated alias of claude-sonnet-4-5-20250929."),
  "claude-haiku-5-5": entry(haiku55, geo),
  "claude-haiku-4-5-20251001": entry(claude(1, 1.25, 2, 0.1, 5)),
  "claude-haiku-4-5": entry(claude(1, 1.25, 2, 0.1, 5), "The undated alias of claude-haiku-4-5-20251001.")
}
