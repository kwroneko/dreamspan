// OpenAI's API (the `openai-chat` and `openai-responses` kinds), Standard processing. Every text
// model on the pricing page on 2026-11-16; the deprecations page gives shutdown dates after that
// for gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-pro, o3 and o3-pro (2026-12-11), gpt-4o, gpt-4o-mini,
// gpt-4.1 and gpt-4.1-mini snapshots (2027-01-14), and gpt-5.1, gpt-5.3-codex, gpt-5.4-nano
// (2027-04-01). Dated snapshots aren't listed on the pricing page, so they aren't here.
// Regional processing (data residency) costs 10% more for models released on or after
// 2026-03-05; the app can't tell a data-residency project, so that isn't priced.
import type { Price } from "@dreamspan/shared/providers.ts"
import type { PriceEntry, PriceTable } from "./types.ts"

const source = "https://developers.openai.com/api/docs/pricing"
const checked = "2026-11-16"

const entry = (price: Price, note?: string): PriceEntry => ({ price, source, checked, ...(note ? { note } : {}) })

/** Input, cached input, output; optional 30-minute and 12-hour cache writes. */
const rates = (input: number, read: number | null, output: number, write?: number, writeLong?: number): Price => ({
  input,
  output,
  ...(read === null ? {} : { cacheRead: read }),
  ...(write === undefined ? {} : { cacheWrite: write }),
  ...(writeLong === undefined ? {} : { cacheWriteLong: writeLong })
})

/** "Short context: ≤272K input tokens. Long context: >272K input tokens." */
const long = (short: Price, longer: Price): Price => ({ ...short, tiers: [{ inputTokensAbove: 272_000, ...longer }] })

export const openaiPrices: PriceTable = {
  "gpt-6-astra": entry(long(rates(10, 1, 50, 12.5, 25), rates(20, 2, 75, 25, 50))),
  "gpt-6.1-sol": entry(long(rates(2, 0.1, 10, 2.5, 5), rates(4, 0.2, 15, 5, 10))),
  "gpt-6.1-terra": entry(long(rates(1, 0.05, 5, 1.25, 2.5), rates(2, 0.1, 7.5, 2.5, 5))),
  "gpt-6-luna": entry(long(rates(0.1, 0.01, 0.5, 0.125, 0.25), rates(0.2, 0.02, 0.75, 0.25, 0.5))),
  "gpt-6-sol": entry(long(rates(2, 0.2, 10, 2.5, 5), rates(4, 0.4, 15, 5, 10))),
  "gpt-5.6-sol": entry(
    long(rates(4, 0.4, 20, 5, 10), rates(8, 0.8, 30, 10, 20)),
    "The page calls this promotional pricing, available until 2026-11-30, and gives no later price."
  ),
  "gpt-5.6-terra": entry(long(rates(2, 0.2, 12, 2.5, 5), rates(4, 0.4, 18, 5, 10))),
  "gpt-5.6-luna": entry(long(rates(0.2, 0.02, 1.2, 0.25, 0.5), rates(0.4, 0.04, 1.8, 0.5, 1))),
  "gpt-5.5": entry(long(rates(5, 0.5, 30), rates(10, 1, 45))),
  "gpt-5.5-pro": entry(long(rates(30, null, 180), rates(60, null, 270))),
  "gpt-5.4": entry(long(rates(2.5, 0.25, 15), rates(5, 0.5, 22.5))),
  "gpt-5.4-pro": entry(long(rates(30, null, 180), rates(60, null, 270))),
  "gpt-5.4-mini": entry(rates(0.75, 0.075, 4.5)),
  "gpt-5.4-nano": entry(rates(0.2, 0.02, 1.25)),
  "gpt-5.2": entry(rates(1.75, 0.175, 14)),
  "gpt-5.2-pro": entry(rates(21, null, 168)),
  "gpt-5.1": entry(rates(1.25, 0.125, 10)),
  "gpt-5": entry(rates(1.25, 0.125, 10)),
  "gpt-5-mini": entry(rates(0.25, 0.025, 2)),
  "gpt-5-nano": entry(rates(0.05, 0.005, 0.4)),
  "gpt-5-pro": entry(rates(15, null, 120)),
  "gpt-4.1": entry(rates(2, 0.5, 8)),
  "gpt-4.1-mini": entry(rates(0.4, 0.1, 1.6)),
  "gpt-4o": entry(rates(2.5, 1.25, 10)),
  "gpt-4o-mini": entry(rates(0.15, 0.075, 0.6)),
  "o3-pro": entry(rates(20, null, 80)),
  o3: entry(rates(2, 0.5, 8)),
  // Specialized models.
  "chat-latest": entry(rates(5, 0.5, 30)),
  "gpt-5.3-codex": entry(rates(1.75, 0.175, 14)),
  "gpt-5-search-api": entry(rates(1.25, 0.125, 10)),
  "gpt-6-astra-law": entry(
    rates(10, 1, 50),
    "Promotional pricing available at least through 2026-12-31; no long-context price listed."
  ),
  "gpt-6-cyber": entry(long(rates(20, 2, 100, 25, 50), rates(40, 4, 150)), "Trusted access only."),
  "gpt-5.6-cyber": entry(rates(12.5, 1.25, 75, 15.625, 31.25), "Trusted access; no long-context price listed."),
  "gpt-5.5-cyber-preview": entry(rates(12.5, 1.25, 75), "Trusted access; no long-context price listed."),
  "gpt-6-rosalind": entry(long(rates(15, 1.5, 75, 18.75, 37.5), rates(30, 3, 112.5, 37.5, 75)), "Trusted access only."),
  "gpt-rosalind-research": entry(rates(5, 0.5, 25), "Trusted access; no long-context price listed."),
  "gpt-rosalind-discovery": entry(rates(5, 0.5, 25), "Trusted access; no long-context price listed.")
}
