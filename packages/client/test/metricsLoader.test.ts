import type { VersionId } from "@rp/shared/chat.ts"
import { versionMetricsOf } from "@rp/shared/inspectorApi.ts"
import { afterEach, expect, it, vi } from "vitest"
import { MetricsLoader } from "../src/features/chat/metricsLoader.ts"
import type { ChatSession } from "../src/features/chat/session.ts"

const id = "01900000-0000-7000-8000-000000000001" as VersionId
const metrics = (running: boolean) =>
  versionMetricsOf(id, [
    {
      status: running ? "running" : "complete",
      startedAt: 0,
      firstTokenAt: 100,
      endedAt: running ? null : 1000,
      output: running ? null : 20,
      reasoning: null,
      usageSource: running ? "none" : "reported",
      inputUncached: null,
      cacheRead: null,
      cacheWrite: null,
      cacheWriteLong: null,
      cost: null,
      reportedCost: null
    }
  ])
afterEach(() => vi.useRealTimers())

it("keeps refreshing a finished version until its ledger request closes", async () => {
  vi.useFakeTimers()
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: [metrics(true)] })
    .mockResolvedValueOnce({ ok: true, value: [metrics(true)] })
    .mockResolvedValue({ ok: true, value: [metrics(false)] })
  const loader = new MetricsLoader({ call } as unknown as ChatSession)
  loader.want(id, "complete")
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(3000)
  expect(loader.peek(id, "complete")?.running).toBe(false)
  expect(call).toHaveBeenCalledTimes(3)
})

it("retries a transient metrics read failure without needing another status change", async () => {
  vi.useFakeTimers()
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValue({ ok: true, value: [metrics(false)] })
  const loader = new MetricsLoader({ call } as unknown as ChatSession)
  loader.want(id, "complete")
  await vi.advanceTimersByTimeAsync(2000)
  expect(loader.peek(id, "complete")?.output).toBe(20)
})

it("bounds retries when a request stays running or reads keep failing", async () => {
  vi.useFakeTimers()
  for (const outcome of [{ ok: true, value: [metrics(true)] }, { ok: false }]) {
    const call = vi.fn().mockResolvedValue(outcome)
    const loader = new MetricsLoader({ call } as unknown as ChatSession)
    loader.want(id, "complete")
    await vi.advanceTimersByTimeAsync(20_000)
    expect(call).toHaveBeenCalledTimes(6)
  }
})
