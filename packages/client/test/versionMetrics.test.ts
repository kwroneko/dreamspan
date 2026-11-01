import type { VersionId } from "@rp/shared/chat.ts"
import { versionMetricsOf, type RequestFigures } from "@rp/shared/inspectorApi.ts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_DISPLAY_PREFS } from "@rp/shared/chatApi.ts"

vi.mock("../src/ui/viewPrefs.ts", () => ({ useViewPrefs: () => ({ prefs: DEFAULT_DISPLAY_PREFS }) }))
import { messageDetails } from "../src/features/chat/messageDetails.tsx"
import {
  metricsDetails,
  metricsSummary,
  recordedFigures,
  registerVersionMetrics
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

  it("registers as two message details under the portrait a plugin can replace", () => {
    dispose = registerVersionMetrics()
    expect([...messageDetails.snapshot().entries].map((entry) => [entry.id, entry.place])).toEqual([
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
