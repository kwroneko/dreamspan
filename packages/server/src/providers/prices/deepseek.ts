// DeepSeek's API (the `deepseek` kind). Peak rates, halved off-peak: "Peak hours are 01:00 - 04:00
// and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays." Holidays aren't
// modelled, so a request on one is priced at the peak rate.
// `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` "are still accepted ... served by the
// DeepSeek-V4.1-Flash-1017 model and billed at the Flash price". Not here: `deepseek-chat` and
// `deepseek-reasoner`, announced as discontinued on 2026-07-24.
import type { Price } from "@dreamspan/shared/providers.ts"
import type { OffPeak, PriceEntry, PriceTable } from "./types.ts"

const source = "https://api-docs.deepseek.com/quick_start/pricing"
const checked = "2026-11-16"

const offPeak: OffPeak = {
  multiplier: 0.5,
  peakHoursUtc: [
    [1, 4],
    [6, 10]
  ],
  peakDays: [1, 2, 3, 4, 5]
}

/** Cache-miss input, cache-hit input, output, at peak. */
const entry = (input: number, read: number, output: number): PriceEntry => {
  const price: Price = { input, output, cacheRead: read }
  return { price, offPeak, source, checked }
}

const flash = entry(0.3, 0.006, 1.2)

export const deepseekPrices: PriceTable = {
  "deepseek-flash": flash,
  "deepseek-v4-flash": flash,
  "deepseek-v4-flash-vision-exp": flash,
  "deepseek-v4-pro": entry(1.32, 0.044, 3.96)
}
