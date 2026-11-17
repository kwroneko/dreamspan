// Anthropic's models on Google Cloud Vertex AI (the `anthropic-vertex` kind), by Vertex model ID
// (`vertexModelId`: a dated ID's date after `@`). The global endpoint's prices; the US and EU
// multi-region and the regional endpoints charge 1.1x (every listed model, checked row by row).
// Not here: Claude Opus 4.1, Opus 4 and Sonnet 4, which Anthropic says remain on Vertex but the
// pricing page doesn't list; the Mythos models, which it doesn't list either.
import type { Price } from "@rp/shared/providers.ts"
import { claude } from "./anthropic.ts"
import type { PriceEntry, PriceTable } from "./types.ts"

const source = "https://cloud.google.com/model-garden/partner-models/pricing"
const checked = "2026-11-16"

const entry = (price: Price, note?: string): PriceEntry => ({ price, source, checked, ...(note ? { note } : {}) })

/** What a regional or multi-region endpoint charges over the global one. */
export const VERTEX_REGIONAL_MULTIPLIER = 1.1

export const vertexPrices: PriceTable = {
  "claude-fable-5-2": entry(claude(8, 10, 16, 0.2, 40)),
  // "If a query input context is longer than or equal to 100k tokens, all tokens are charged at
  // long context rates."
  "claude-haiku-5-5": entry({
    ...claude(0.1, 0.125, 0.2, 0.01, 0.5),
    tiers: [
      { inputTokensAbove: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 }
    ]
  }),
  "claude-sonnet-5-5": entry(claude(2, 2.5, 4, 0.1, 10)),
  "claude-opus-5-5": entry(claude(4, 5, 8, 0.2, 20)),
  "claude-opus-5": entry(claude(5, 6.25, 10, 0.5, 25)),
  "claude-sonnet-5": entry(claude(2, 2.5, 4, 0.2, 10)),
  "claude-fable-5-1": entry(claude(10, 12.5, 20, 0.25, 50)),
  "claude-fable-5": entry(claude(10, 12.5, 20, 1, 50)),
  "claude-opus-4-8": entry(claude(5, 6.25, 10, 0.5, 25)),
  "claude-opus-4-7": entry(claude(5, 6.25, 10, 0.5, 25)),
  "claude-opus-4-6": entry(claude(5, 6.25, 10, 0.5, 25)),
  // The global table has no 1-hour write row for Opus 4.5; the regional rows give 1.1x of $10.
  "claude-opus-4-5@20251101": entry(claude(5, 6.25, 10, 0.5, 25)),
  "claude-sonnet-4-6": entry(claude(3, 3.75, 6, 0.3, 15)),
  // "If a query input context is longer than or equal to 200K tokens, all tokens (input and output)
  // are charged at long context rates."
  "claude-sonnet-4-5@20250929": entry({
    ...claude(3, 3.75, 6, 0.3, 15),
    tiers: [{ inputTokensAbove: 199_999, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, cacheWriteLong: 12 }]
  }),
  "claude-haiku-4-5@20251001": entry(claude(1, 1.25, 2, 0.1, 5))
}
