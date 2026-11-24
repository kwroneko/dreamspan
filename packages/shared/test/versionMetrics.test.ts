import { describe, expect, it } from "vitest"
import type { VersionId } from "../src/chat.ts"
import { type RequestFigures, versionMetricsOf } from "../src/inspectorApi.ts"

const id = "01900000-0000-7000-8000-000000000001" as VersionId
const request = (overrides: Partial<RequestFigures>): RequestFigures => ({
  status: "complete",
  startedAt: 1_000,
  firstTokenAt: 1_500,
  endedAt: 3_500,
  output: 40,
  reasoning: null,
  usageSource: "reported",
  inputUncached: 20,
  cacheRead: 100,
  cacheWrite: 0,
  cacheWriteLong: 0,
  cost: null,
  reportedCost: null,
  ...overrides
})
const usd = (amount: number, formula = "builtin") => ({ amount, currency: "USD", formula })

describe("version metrics", () => {
  it("sums ended requests and keeps the last apart", () => {
    const metrics = versionMetricsOf(id, [
      request({ status: "failed", output: 4, reasoning: 2 }),
      request({ startedAt: 5_000, firstTokenAt: 5_200, endedAt: 6_200, output: 20, usageSource: "estimated" })
    ])
    expect(metrics).toMatchObject({
      requests: 2,
      running: false,
      elapsedMs: 2_500 + 1_200,
      streamingMs: 2_000 + 1_000,
      output: 24,
      reasoning: null,
      outputUnknown: 0,
      estimated: true
    })
    expect(metrics.last.startedAt).toBe(5_000)
  })

  it("labels unknowns: no count, no first token, still running", () => {
    const metrics = versionMetricsOf(id, [
      request({ output: null, usageSource: "none", firstTokenAt: null }),
      request({ status: "running", startedAt: 9_000, firstTokenAt: null, endedAt: null, output: null })
    ])
    expect(metrics).toMatchObject({
      requests: 2,
      running: true,
      elapsedMs: 2_500,
      streamingMs: null,
      output: 0,
      reasoning: null,
      outputUnknown: 1,
      estimated: false
    })
  })
  it("does not report a speed or reasoning total from incomplete request measurements", () => {
    const metrics = versionMetricsOf(id, [request({ reasoning: 2 }), request({ firstTokenAt: null, reasoning: null })])
    expect(metrics.streamingMs).toBeNull()
    expect(metrics.reasoning).toBeNull()
  })

  it("sums the ended requests' costs and input counts, the running one left out", () => {
    const metrics = versionMetricsOf(id, [
      request({ cost: usd(0.002, "reported"), reportedCost: 0.002, cacheWrite: 30, cacheWriteLong: 10 }),
      request({ cost: usd(0.0005), usageSource: "estimated" }),
      request({ status: "running", endedAt: null, cost: null, inputUncached: null })
    ])
    expect(metrics).toMatchObject({
      costs: [{ amount: 0.0025, currency: "USD" }],
      costUnknown: 0,
      costSources: ["reported", "builtin"],
      costEstimated: true,
      reportedCost: 0.002,
      reportedRequests: 1,
      inputUncached: 40,
      cacheRead: 200,
      cacheWrite: 30,
      cacheWriteLong: 10
    })
  })

  it("lists the separate reasoning rates the costs used, each once", () => {
    const priced = (reasoningRate?: number, reasoning: number | null = 5) =>
      request({ cost: { ...usd(0.01), ...(reasoningRate === undefined ? {} : { reasoningRate }) }, reasoning })
    expect(versionMetricsOf(id, [priced(2), priced(2), priced(3)]).reasoningRates).toEqual([
      { amount: 2, currency: "USD" },
      { amount: 3, currency: "USD" }
    ])
    expect(versionMetricsOf(id, [priced(), priced(7, 0), priced(8, null)]).reasoningRates).toEqual([])
  })

  it("never adds up currencies, counts requests without a cost, and keeps unknown counts unknown", () => {
    const metrics = versionMetricsOf(id, [
      request({ cost: usd(0.01) }),
      request({ cost: { amount: 2, currency: "EUR", formula: "user:r1:3" }, cacheRead: null }),
      request({ cost: usd(0.02) }),
      request({ cost: null })
    ])
    expect(metrics.costs).toEqual([
      { amount: 0.03, currency: "USD" },
      { amount: 2, currency: "EUR" }
    ])
    expect(metrics.costUnknown).toBe(1)
    expect(metrics.costSources).toEqual(["builtin", "user:r1:3"])
    expect(metrics.cacheRead).toBeNull()
    expect(metrics.inputUncached).toBe(80)
    // A provider-reported cost from estimated counts is still the provider's.
    expect(versionMetricsOf(id, [request({ cost: usd(1, "reported"), usageSource: "estimated" })]).costEstimated).toBe(
      false
    )
    const none = versionMetricsOf(id, [request({ status: "running", endedAt: null })])
    expect([none.costs, none.costUnknown, none.inputUncached, none.reportedCost]).toEqual([[], 0, null, null])
  })
})
