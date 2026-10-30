import type { VersionId } from "@rp/shared/chat.ts"
import { versionMetricsOf, type RequestFigures } from "@rp/shared/inspectorApi.ts"
import { afterEach, describe, expect, it } from "vitest"
import { messageHeaderDetails } from "../src/features/chat/presentation.tsx"
import { metricsDetails, metricsSummary, registerVersionMetrics } from "../src/features/chat/versionMetrics.tsx"

const id = "01900000-0000-7000-8000-000000000001" as VersionId
const request = (overrides: Partial<RequestFigures> = {}): RequestFigures => ({
  status: "complete",
  startedAt: 0,
  firstTokenAt: 800,
  endedAt: 12_300,
  output: 345,
  reasoning: null,
  usageSource: "reported",
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

  it("registers as a header contribution a plugin can replace", () => {
    dispose = registerVersionMetrics()
    expect([...messageHeaderDetails.snapshot().entries].map((entry) => entry.id)).toEqual(["message.metrics"])
  })

  it("shows elapsed seconds and output tokens, details in the tooltip", () => {
    const metrics = versionMetricsOf(id, [request({ reasoning: 120 })])
    expect(metricsSummary(metrics)).toBe("12.3 s · 345 tokens")
    expect(details(metrics, true)).toEqual({
      "Generation time": "12.3 s",
      "Time to first token": "0.8 s",
      "Output tokens": "345",
      Speed: "30.0 tokens/s",
      "Reasoning tokens": "120",
      "Reasoning time": "not recorded"
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
      "Reasoning tokens": "unknown"
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
})
