// Anthropic's models on AWS Bedrock (the `anthropic-bedrock` kind). The pricing page has two
// tables: "Global Cross-region Inference" (`global.` profiles) and "Geo and In-region Cross-region
// Inference" (`us.`, `eu.`, `jp.`, `au.`, `apac.`, `in.`, `ca.` profiles and the bare model IDs),
// which is 1.1x the global price for Claude 4.5 and later. Prices are the same in every commercial
// region; GovCloud (`us-gov.`) differs and isn't priced here. Model IDs are from the model cards,
// lifecycle from the legacy lifecycle page: Claude Sonnet 4 reached EOL on 2026-10-14 and Claude
// 3.x except 3 Haiku on 2026-11-13; Claude Opus 4 has no model card.
import type { Price } from "@dreamspan/shared/providers.ts"
import { claude } from "./anthropic.ts"
import { scalePrice } from "./scale.ts"
import type { PriceEntry } from "./types.ts"

const source = "https://aws.amazon.com/bedrock/pricing/"
const checked = "2026-11-16"
const ids = "https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.md"

/** A Bedrock model's two prices: on a `global.` profile and on a geo profile or in-region. */
export interface BedrockEntry {
  readonly global?: PriceEntry
  readonly regional?: PriceEntry
}

const entry = (price: Price, note?: string): PriceEntry => ({
  price,
  source,
  checked,
  note: `Model IDs: ${ids}.${note ? ` ${note}` : ""}`
})

/** Global price as listed; geo and in-region at the page's 10% premium. */
const both = (price: Price, note?: string): BedrockEntry => ({
  global: entry(price, note),
  regional: entry(scalePrice(price, 1.1), note)
})

// The page lists "Claude Haiku 5.5 - Long Context" without a threshold; Anthropic's page gives
// 100,000 prompt tokens for the model.
const haiku55: Price = {
  ...claude(0.1, 0.125, 0.2, 0.01, 0.5),
  tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 }]
}

/** By model ID without its inference profile prefix. */
export const bedrockPrices: Readonly<Record<string, BedrockEntry>> = {
  "anthropic.claude-fable-5-2": both(claude(8, 10, 16, 0.2, 40)),
  "anthropic.claude-mythos-5-2": both(claude(8, 10, 16, 0.2, 40)),
  "anthropic.claude-haiku-5-5": both(haiku55),
  "anthropic.claude-sonnet-5-5": both(
    claude(2, 2.5, 4, 0.1, 10),
    "Cache reads were halved on 2026-10-07; this is the new rate."
  ),
  "anthropic.claude-opus-5-5": both(claude(4, 5, 8, 0.2, 20)),
  "anthropic.claude-fable-5-1": both(claude(10, 12.5, 20, 0.25, 50)),
  "anthropic.claude-mythos-5-1": both(claude(10, 12.5, 20, 0.25, 50)),
  "anthropic.claude-opus-5": both(claude(5, 6.25, 10, 0.5, 25)),
  "anthropic.claude-sonnet-5": both(claude(2, 2.5, 4, 0.2, 10)),
  // Only in the geo and in-region table.
  "anthropic.claude-mythos-5": { regional: entry(claude(11, 13.75, 22, 1.1, 55)) },
  "anthropic.claude-fable-5": both(claude(10, 12.5, 20, 1, 50)),
  "anthropic.claude-opus-4-8": both(claude(5, 6.25, 10, 0.5, 25)),
  "anthropic.claude-opus-4-7": both(claude(5, 6.25, 10, 0.5, 25)),
  "anthropic.claude-opus-4-6-v1": both(claude(5, 6.25, 10, 0.5, 25)),
  "anthropic.claude-sonnet-4-6": both(claude(3, 3.75, 6, 0.3, 15)),
  "anthropic.claude-haiku-4-5": both(claude(1, 1.25, 2, 0.1, 5)),
  "anthropic.claude-haiku-4-5-20251001-v1:0": both(claude(1, 1.25, 2, 0.1, 5)),
  "anthropic.claude-opus-4-5-20251101-v1:0": both(claude(5, 6.25, 10, 0.5, 25)),
  "anthropic.claude-sonnet-4-5-20250929-v1:0": both(claude(3, 3.75, 6, 0.3, 15), "Legacy on Bedrock; EOL 2027-04-27."),
  // Geo and in-region only; no 1-hour cache write is offered.
  "anthropic.claude-opus-4-1-20250805-v1:0": {
    regional: entry({ input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, "Legacy on Bedrock; EOL 2027-01-08.")
  },
  "anthropic.claude-3-haiku-20240307-v1:0": {
    regional: entry({ input: 0.25, output: 1.25 }, "Legacy; EOL in its last regions by 2026-11-27.")
  }
}

const PROFILE = /^(global|us|eu|apac|au|jp|in|ca)\.(.+)$/

/** A Bedrock model ID's price: by its inference profile's scope, its bare ID in-region. */
export const bedrockEntry = (id: string): PriceEntry | null => {
  if (id.startsWith("us-gov.")) return null
  const profile = PROFILE.exec(id)
  const base = profile ? profile[2]! : id
  const found = Object.hasOwn(bedrockPrices, base) ? bedrockPrices[base]! : undefined
  if (!found) return null
  return (profile?.[1] === "global" ? found.global : found.regional) ?? null
}
