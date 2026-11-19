// The line under "Fetch prices from this server" (spec/PRICES.md §4.5, §7).
import { describe, expect, it } from "vitest"
import { priceFeedText } from "../src/features/connections/priceFeedStatus.tsx"

describe("the price endpoint's last answer", () => {
  const at = Date.UTC(2026, 10, 16, 18, 0)
  it("says when prices were fetched, or why not, in user terms", () => {
    expect(priceFeedText(null)).toBe("Not asked yet. Prices are asked for when you refresh models.")
    expect(priceFeedText({ state: "supported", at, nextAt: at + 3_600_000, detail: null })).toMatch(
      /^Prices fetched .+\.$/
    )
    expect(priceFeedText({ state: "unsupported", at, nextAt: null, detail: "404" })).toBe(
      "This server doesn’t publish prices. It’s asked again when you refresh models."
    )
    expect(priceFeedText({ state: "denied", at, nextAt: at, detail: "401" })).toMatch(/didn’t accept the key/)
    // No internals: the server's own error text isn't shown.
    const failed = priceFeedText({ state: "failed", at, nextAt: at, detail: "HTTP 502 from 10.0.0.1" })
    expect(failed).toMatch(/^Prices couldn’t be fetched .+ The last prices stay in use/)
    expect(failed).not.toContain("10.0.0.1")
  })
})
