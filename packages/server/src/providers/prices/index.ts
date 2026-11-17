// The built-in price table (spec/PRICES.md §3.2): pi-ai's catalog plus our own supplement, one
// file per provider. A supplement entry replaces pi-ai's price for its (provider, model) whole,
// never field by field.
import type { Price } from "@rp/shared/providers.ts"
import { createHash } from "node:crypto"
import { anthropicPrices } from "./anthropic.ts"
import { bedrockEntry, bedrockPrices } from "./bedrock.ts"
import { deepseekPrices } from "./deepseek.ts"
import { googlePrices } from "./google.ts"
import { openaiPrices } from "./openai.ts"
import { scalePrice } from "./scale.ts"
import type { PriceEntry, PriceTable } from "./types.ts"
import { VERTEX_REGIONAL_MULTIPLIER, vertexPrices } from "./vertex.ts"

/** The supplement's tables by pi-ai provider id (`ProviderKindEntry.piProvider`). */
const tables: Readonly<Record<string, PriceTable>> = {
  anthropic: anthropicPrices,
  "google-vertex": vertexPrices,
  openai: openaiPrices,
  google: googlePrices,
  deepseek: deepseekPrices
}

/** Where a request went, as far as its price depends on it. */
export interface PriceContext {
  /** The kind's pi-ai provider id. */
  readonly provider: string
  /** The connection's cloud region setting, where the provider has one (Vertex AI). */
  readonly region?: string | undefined
}

/** The supplement's entry for a model, or null when it has none. */
const supplementEntry = (context: PriceContext, model: string): PriceEntry | null => {
  if (context.provider === "amazon-bedrock") return bedrockEntry(model)
  const table = Object.hasOwn(tables, context.provider) ? tables[context.provider]! : undefined
  // Model ids come from upstream: "constructor" or "__proto__" mustn't read the prototype.
  return table && Object.hasOwn(table, model) ? table[model]! : null
}

const peak = (entry: PriceEntry, at: Date) => {
  const offPeak = entry.offPeak
  if (!offPeak) return true
  const hour = at.getUTCHours()
  return (
    offPeak.peakDays.includes(at.getUTCDay()) && offPeak.peakHoursUtc.some(([from, to]) => hour >= from && hour < to)
  )
}

/** An entry's price at a moment: its announced changes and off-peak hours applied. */
const entryPriceAt = (entry: PriceEntry, at: number): Price => {
  const day = new Date(at).toISOString().slice(0, 10)
  const base = (entry.changes ?? []).reduce((price, change) => (day >= change.from ? change.price : price), entry.price)
  return peak(entry, new Date(at)) ? base : scalePrice(base, entry.offPeak!.multiplier)
}

/** The supplement's price for a model at a moment, the provider's regional premium applied. */
export const supplementPrice = (context: PriceContext, model: string, at: number): Price | null => {
  const entry = supplementEntry(context, model)
  if (!entry) return null
  const price = entryPriceAt(entry, at)
  const regional = context.provider === "google-vertex" && context.region !== undefined && context.region !== "global"
  return regional ? scalePrice(price, VERTEX_REGIONAL_MULTIPLIER) : price
}

/**
 * The pi-ai version whose catalog the table builds on (pinned in packages/server/package.json; a
 * test checks they match). A constant, so the server image reads no package file at runtime.
 */
export const PI_AI_VERSION = "1.0.3"

/**
 * The built-in table's version for `cost_formula` (`builtin:<version>`, PRICES §6): pi-ai's version
 * and the supplement's content hash, so a corrected price is a new version.
 */
export const BUILTIN_PRICE_VERSION = `pi-ai@${PI_AI_VERSION}+${createHash("sha256")
  .update(JSON.stringify({ tables, bedrockPrices }))
  .digest("hex")
  .slice(0, 12)}`
