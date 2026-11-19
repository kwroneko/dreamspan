// The Gemini API (the `google` kind), paid tier, Standard processing, text/image/video input.
// Context caching is priced as cache reads; explicit caches' hourly storage isn't per request and
// isn't priced. Grounding with Google Search is per search query ($14 per 1,000 after 5,000 free a
// month on Gemini 3 and newer; $35 per 1,000 grounded prompts after 1,500 free a day on 2.5),
// which a request's usage doesn't report, so it isn't priced.
// Not here: gemini-3.5-flash and gemini-3.7-flash (deprecated; requests route to 3.6/3.8 Flash and
// the page doesn't say at which price), gemini-flash-latest and gemini-flash-lite-latest (the page
// doesn't say which model they name), and audio-only, image, TTS, embedding and Live models.
import type { Price } from "@dreamspan/shared/providers.ts"
import type { PriceEntry, PriceTable } from "./types.ts"

const source = "https://aistudio.google.com/docs/pricing"
const checked = "2026-11-16"

/** Input, output (thinking included), context caching. */
const rates = (input: number, output: number, read: number): Price => ({ input, output, cacheRead: read })

const entry = (price: Price, extra?: Partial<PriceEntry>): PriceEntry => ({ price, source, checked, ...extra })

/** "prompts <= 200k tokens" and "prompts > 200k tokens". */
const long = (short: Price, longer: Price): Price => ({ ...short, tiers: [{ inputTokensAbove: 200_000, ...longer }] })

const flash38 = entry(rates(0.75, 3.75, 0.075), { changes: [{ from: "2027-01-01", price: rates(1.5, 7.5, 0.15) }] })
const gemini4 = entry(rates(2, 10, 0.1), {
  changes: [{ from: "2026-12-01", price: rates(4, 20, 0.2) }],
  note: "Implicit caching only."
})
const pro31 = entry(long(rates(2, 12, 0.2), rates(4, 18, 0.4)))
const robotics = entry(rates(1, 5, 0.1), { changes: [{ from: "2027-01-01", price: rates(2, 10, 0.2) }] })

export const googlePrices: PriceTable = {
  "gemini-4-carbon": gemini4,
  "gemini-4-argon": gemini4,
  "gemini-4-hydrogen": entry(rates(1.5, 7.5, 0.075), { note: "Implicit caching only." }),
  "gemini-3.8-flash": flash38,
  "gemini-3.6-flash": flash38,
  "gemini-3.5-flash-lite": entry(rates(0.3, 2.5, 0.03)),
  "gemini-3.1-flash-lite": entry(rates(0.25, 1.5, 0.025)),
  "gemini-3.1-pro-preview": pro31,
  "gemini-3.1-pro-preview-customtools": pro31,
  "gemini-3-flash-preview": entry(rates(0.5, 3, 0.05)),
  "gemini-2.5-pro": entry(long(rates(1.25, 10, 0.125), rates(2.5, 15, 0.25)), {
    note: "Deprecated; shuts down 2026-12-01, when requests route to gemini-3.8-flash."
  }),
  "gemini-2.5-flash": entry(rates(0.3, 2.5, 0.03), {
    note: "Deprecated; shuts down 2026-12-01, when requests route to gemini-3.5-flash-lite."
  }),
  "gemini-2.5-flash-lite": entry(rates(0.1, 0.4, 0.01)),
  "gemini-robotics-er-2-preview": robotics,
  "gemini-robotics-er-2-streaming-preview": entry(
    { input: 1, output: 5 },
    {
      changes: [{ from: "2027-01-01", price: { input: 2, output: 10 } }],
      note: "No context caching price listed."
    }
  )
}
