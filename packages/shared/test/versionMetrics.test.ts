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
  ...overrides
})

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
      reasoning: 2,
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
})
