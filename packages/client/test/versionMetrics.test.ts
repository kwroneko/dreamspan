import type { VersionId } from "@dreamspan/shared/chat.ts"
import { versionMetricsOf, type RequestFigures } from "@dreamspan/shared/inspectorApi.ts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_DISPLAY_PREFS } from "@dreamspan/shared/chatApi.ts"

vi.mock("../src/ui/viewPrefs.ts", () => ({ useViewPrefs: () => ({ prefs: DEFAULT_DISPLAY_PREFS }) }))
import { messageDetails } from "../src/features/chat/messageDetails.tsx"
import {
  metricsDetails,
  metricsSummary,
  costDetails,
  formatCost,
  recordedFigures,
  registerVersionMetrics,
  shortCost
} from "../src/features/chat/versionMetrics.tsx"

const id = "01900000-0000-7000-8000-000000000001" as VersionId
const request = (overrides: Partial<RequestFigures> = {}): RequestFigures => ({
  status: "complete",
  startedAt: 0,
  firstTokenAt: 800,
  endedAt: 12_300,
  output: 345,
  reasoning: null,
  usageSource: "reported",
  inputUncached: null,
  cacheRead: null,
  cacheWrite: null,
  cacheWriteLong: null,
  cost: null,
  reportedCost: null,
  ...overrides
})
const details = (metrics: ReturnType<typeof versionMetricsOf>, reasoning = false) =>
  Object.fromEntries(metricsDetails(metrics, reasoning))

describe("version metrics display", () => {
  let dispose: Array<() => void> = []
  afterEach(() => {
    for (const close of dispose) close()
    dispose = []
  })

  it("registers the cost in the header and two details under the portrait, all replaceable", () => {
    dispose = registerVersionMetrics()
    expect([...messageDetails.snapshot().entries].map((entry) => [entry.id, entry.place])).toEqual([
      ["message.cost", "header"],
      ["message.timer", "portrait"],
      ["message.tokens", "portrait"]
    ])
  })

  it("shows what SillyTavern recorded for an imported version, as ST writes it", () => {
    const figures = recordedFigures({ startedAt: 0, finishedAt: 12_400, tokens: 384, firstTokenMs: 900 })
    expect([figures.time, figures.tokens, figures.summary]).toEqual(["12.4s", "384t", "12.4 s · 384 tokens"])
    expect(Object.fromEntries(figures.rows)).toMatchObject({
      "Generation time": "12.4 s",
      "Time to first token": "0.9 s",
      Speed: "31.0 tokens/s"
    })
    // A user's message: only ST's count; no time is made up.
    const counted = recordedFigures({ tokens: 4 })
    expect([counted.time, counted.tokens]).toEqual([null, "4t"])
  })

  it("shows elapsed seconds and output tokens, details in the tooltip", () => {
    const metrics = versionMetricsOf(id, [request({ reasoning: 120 })])
    expect(metricsSummary(metrics)).toBe("12.3 s · 345 tokens")
    // An older request: one first token, reasoning text on the swipe.
    expect(details(metrics, true)).toEqual({
      "Generation time": "12.3 s",
      "Time to first token": "0.8 s",
      "Output tokens": "345 (120 reasoning, 225 reply)",
      Reasoning: "120 tokens, shown above the reply",
      Speed: "30.0 tokens/s",
      Cost: "unknown (no price for this model)",
      "Input tokens": "unknown"
    })
  })

  it("times streamed reasoning and the reply apart, speed over the streaming only", () => {
    const shown = versionMetricsOf(id, [
      request({ reasoning: 512, output: 778, firstTokenAt: 1_200, firstReasoningAt: 1_200, firstReplyAt: 9_400 })
    ])
    expect(details(shown, true)).toEqual({
      "Generation time": "12.3 s",
      "Time to first reasoning token": "1.2 s",
      "Time to first reply token": "9.4 s",
      "Reasoning time": "8.2 s",
      "Output tokens": "778 (512 reasoning, 266 reply)",
      Reasoning: "512 tokens, shown above the reply",
      Speed: "70.1 tokens/s",
      Cost: "unknown (no price for this model)",
      "Input tokens": "unknown"
    })
  })

  it("says when the provider kept the reasoning back, and counts only the reply's speed", () => {
    const hidden = versionMetricsOf(id, [
      request({ reasoning: 512, output: 778, firstTokenAt: 9_800, firstReasoningAt: null, firstReplyAt: 9_800 })
    ])
    expect(details(hidden, false)).toMatchObject({
      "Time to first token": "9.8 s",
      "Output tokens": "778 (512 reasoning, 266 reply)",
      Reasoning: "512 tokens, not returned by the provider",
      Speed: "106.4 tokens/s (reply only)"
    })
    // An older request with no times: the swipe's missing text says it wasn't streamed.
    expect(details(versionMetricsOf(id, [request({ reasoning: 100 })]), false).Speed).toBe("21.3 tokens/s (reply only)")
  })

  it("marks the app's reasoning estimate, and says none or unknown", () => {
    const estimated = versionMetricsOf(id, [request({ reasoning: 120, reasoningEstimated: true })])
    expect(details(estimated, true)).toMatchObject({
      "Output tokens": "345 (~120 reasoning, ~225 reply)",
      Reasoning: "~120 tokens, shown above the reply"
    })
    const none = versionMetricsOf(id, [request({ reasoning: 0, firstReasoningAt: null, firstReplyAt: 800 })])
    expect(details(none, false)).toMatchObject({ "Output tokens": "345", Reasoning: "none" })
    const unknown = versionMetricsOf(id, [request()])
    expect(details(unknown, false)).toMatchObject({
      "Output tokens": "345, reasoning count unknown",
      Reasoning: "none returned, count unknown"
    })
  })

  it("labels estimates and unknowns instead of showing zero", () => {
    const estimated = versionMetricsOf(id, [request({ usageSource: "estimated" })])
    expect(metricsSummary(estimated)).toBe("12.3 s · ~345 tokens")
    expect(details(estimated)["Output tokens"]).toContain("estimated")
    const unknown = versionMetricsOf(id, [request({ output: null, usageSource: "none", firstTokenAt: null })])
    expect(metricsSummary(unknown)).toBe("12.3 s · tokens unknown")
    expect(details(unknown, true)).toMatchObject({
      "Time to first token": "unknown",
      Speed: "unknown",
      Reasoning: "shown above the reply, count unknown"
    })
  })

  it("sums a continuation with the reply it continued, the last request apart", () => {
    const metrics = versionMetricsOf(id, [
      request(),
      request({ startedAt: 20_000, firstTokenAt: 20_500, endedAt: 24_000, output: 100 })
    ])
    expect(metricsSummary(metrics)).toBe("16.3 s · 445 tokens")
    expect(details(metrics)).toMatchObject({
      "Time to first token": "0.5 s (last request)",
      Requests: "2 (includes original generation, retries and continuations)",
      "Last request": "4.0 s, 100 tokens"
    })
    const partly = versionMetricsOf(id, [request(), request({ output: null, usageSource: "none" })])
    expect(metricsSummary(partly)).toBe("24.6 s · 345+ tokens")
  })
  it("labels a partial estimate and an estimated last request, and keeps unknown speed unknown", () => {
    const metrics = versionMetricsOf(id, [
      request({ output: null, firstTokenAt: null, usageSource: "none" }),
      request({ usageSource: "estimated" })
    ])
    expect(details(metrics)["Output tokens"]).toContain("estimated")
    expect(details(metrics)["Last request"]).toContain("estimated")
    expect(details(metrics).Speed).toBe("unknown")
    expect(details(versionMetricsOf(id, [request({ output: null, usageSource: "none" })]))["Output tokens"]).toMatch(
      /^unknown/
    )
  })
  it("does not show zero tokens while a finished version's ledger is still closing", () => {
    const pending = versionMetricsOf(id, [
      request({ status: "running", endedAt: null, output: null, usageSource: "none" })
    ])
    expect(metricsSummary(pending)).toBe("time unknown · tokens unknown")
    expect(details(pending)["Output tokens"]).toMatch(/^unknown/)
  })

  it("writes a cost short: three decimals, two significant digits under a cent, the currency's label", () => {
    const usd = (amount: number) => formatCost({ amount, currency: "USD" })
    expect([usd(0.0123), usd(0.15), usd(0.0041), usd(0.000047), usd(1.234), usd(0)]).toEqual([
      "$0.012",
      "$0.150",
      "$0.0041",
      "$0.000047",
      "$1.23",
      "$0"
    ])
    expect(formatCost({ amount: 0.0123, currency: "EUR" })).toBe("0.012 EUR")
    // Rounding into the next band takes that band's digits.
    expect([usd(0.00999), usd(0.000999), usd(0.9996), usd(0.0099999), usd(1e-15)]).toEqual([
      "$0.010",
      "$0.0010",
      "$1.00",
      "$0.010",
      "$0"
    ])
  })

  it("marks an estimated cost with ~ and a request without one, or in another currency, with +", () => {
    const priced = (amount: number, formula = "builtin", currency = "USD") => ({ cost: { amount, currency, formula } })
    expect(shortCost(versionMetricsOf(id, [request(priced(0.0123))]))).toBe("$0.012")
    expect(shortCost(versionMetricsOf(id, [request({ ...priced(0.0041), usageSource: "estimated" })]))).toBe("~$0.0041")
    expect(shortCost(versionMetricsOf(id, [request(priced(0.01)), request()]))).toBe("$0.010+")
    expect(shortCost(versionMetricsOf(id, [request(priced(0.01)), request(priced(1, "user:a:1", "EUR"))]))).toBe(
      "$0.010+"
    )
    // No cost at all, or still running: nothing in the header.
    expect(shortCost(versionMetricsOf(id, [request()]))).toBeNull()
    expect(shortCost(versionMetricsOf(id, [request({ status: "running", endedAt: null, ...priced(1) })]))).toBeNull()
  })

  it("lists the cost, how it was priced, the provider's differing charge and the input split", () => {
    const counts = { inputUncached: 200, cacheRead: 1_000, cacheWrite: 300, cacheWriteLong: 100 }
    const rows = Object.fromEntries(
      costDetails(
        versionMetricsOf(id, [
          request({ ...counts, cost: { amount: 0.0123, currency: "USD", formula: "builtin" }, reportedCost: 0.015 })
        ])
      )
    )
    expect(rows).toEqual({
      Cost: "$0.012",
      "Priced by": "the model's price list",
      "Provider charged": "$0.015",
      "Input tokens": "1,500 (200 uncached, 1,000 cache read, 300 cache write, 100 of it long-lived)",
      Cached: "67% of input"
    })
    // The provider's own charge isn't repeated.
    const reported = Object.fromEntries(
      costDetails(
        versionMetricsOf(id, [
          request({ ...counts, cost: { amount: 0.015, currency: "USD", formula: "reported" }, reportedCost: 0.015 })
        ])
      )
    )
    expect(reported["Priced by"]).toBe("the provider's charge")
    expect(reported["Provider charged"]).toBeUndefined()
    // Partial and mixed costs say so.
    const mixed = Object.fromEntries(
      costDetails(
        versionMetricsOf(id, [
          request({ cost: { amount: 0.01, currency: "USD", formula: "builtin" } }),
          request({ cost: { amount: 0.4, currency: "EUR", formula: "user:r:2" } }),
          request()
        ])
      )
    )
    expect(mixed.Cost).toBe("$0.010 + 0.400 EUR; 1 request had none")
    expect(mixed["Priced by"]).toBe("the model's price list, your cost formula")
    expect(mixed.Cached).toBeUndefined()
    // A price endpoint's cost names when its prices were fetched, and the route it was for.
    const fetched = Date.UTC(2026, 10, 16, 18, 0)
    const served = Object.fromEntries(
      costDetails(
        versionMetricsOf(id, [
          request({ cost: { amount: 0.01, currency: "USD", formula: `endpoint:${fetched}:route-b` } })
        ])
      )
    )
    expect(served["Priced by"]).toMatch(/^this server's price list, fetched .+ \(route route-b\)$/)
  })

  it("puts the last request's cost beside its time and tokens", () => {
    const metrics = versionMetricsOf(id, [
      request(),
      request({
        startedAt: 20_000,
        endedAt: 24_000,
        output: 100,
        cost: { amount: 0.002, currency: "USD", formula: "builtin" }
      })
    ])
    expect(details(metrics)["Last request"]).toBe("4.0 s, 100 tokens, $0.0020")
  })
})
