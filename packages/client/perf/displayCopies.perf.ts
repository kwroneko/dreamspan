// Display copies on the 100,000-message chat (review-adapters2): opening, two streams with
// typing, and scrolling up, with no copy, one unchanged copy and all nine unchanged copies
// turned on, in alternating rounds on one server. A working copy must stay on throughout:
// being turned off by load alone is the failure this guards. Numbers are recorded with the
// host's load; only the budgets the other scenarios already use are asserted.
import { appendFileSync, rmSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { budgets } from "./budgets.ts"
import { type Fixture, prepare } from "./fixtures.ts"
import { type PerfServer, startServer, withClient } from "./support.ts"

let server: PerfServer
let fixture: Fixture
let dataDir: string
test.beforeAll(async () => {
  const prepared = await prepare()
  fixture = prepared.fixture
  dataDir = prepared.dataDir
  server = await startServer(dataDir)
})
test.afterAll(async () => {
  await server?.stop()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

const PARTS = [
  ["displayTransforms", "display.macros"],
  ["displayTransforms", "display.regex"],
  ["displayScriptLists", "display-regex.global"],
  ["displayScriptLists", "display-regex.preset"],
  ["displayScriptLists", "display-regex.character"],
  ["timelineTransforms", "timeline.merges"],
  ["timelineTransforms", "timeline.history-budget"],
  ["timelineTransforms", "timeline.lcm"],
  ["timelineTransforms", "timeline.threads"]
] as const

interface Measures {
  loaf: Array<{ start: number; duration: number }>
  events: Array<{ name: string; start: number; duration: number }>
  frames: Array<{ at: number; interval: number }>
}
const instrument = () => {
  const w = window as unknown as { __m: Measures }
  w.__m = { loaf: [], events: [], frames: [] }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__m.loaf.push({ start: e.startTime, duration: e.duration })
  }).observe({ type: "long-animation-frame", buffered: true })
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__m.events.push({ name: e.name, start: e.startTime, duration: e.duration })
  }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit)
  let last = 0
  const tick = (now: number) => {
    if (last > 0) w.__m.frames.push({ at: now, interval: now - last })
    last = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const round = (n: number) => Math.round(n * 10) / 10
const since = (page: Page, from: number) =>
  page.evaluate((from) => {
    const m = (window as unknown as { __m: Measures }).__m
    const perf = (
      window as unknown as {
        __rpPerf: { displayCalls: number; displayCallMaxMs: number; displayQueueMax: number; displayCallMs: number[] }
      }
    ).__rpPerf
    return {
      loaf: m.loaf.filter((e) => e.start >= from),
      events: m.events.filter((e) => e.start >= from),
      frames: m.frames.filter((e) => e.at >= from),
      calls: perf.displayCalls,
      callMaxMs: perf.displayCallMaxMs,
      queueMax: perf.displayQueueMax,
      callMs: [...perf.displayCallMs]
    }
  }, from)
const now = (page: Page) => page.evaluate(() => performance.now())
const messages = (page: Page) => page.getByTestId("messages")
const onScreen = (page: Page) =>
  page.waitForFunction(
    () => {
      const list = document.querySelector("[data-testid=messages]")?.getBoundingClientRect()
      const rows = document.querySelectorAll("article[data-slot]")
      const row = rows[rows.length - 1]
      if (!list || !row) return false
      const rect = row.getBoundingClientRect()
      return rect.bottom > list.top && rect.top < list.bottom
    },
    undefined,
    { timeout: 60_000, polling: 100 }
  )

test("display copies: open, stream, type and scroll with none, one and nine turned on", async ({ page }) => {
  const copies = await withClient(server, (api) =>
    Effect.forEach(PARTS, ([registry, id], index) =>
      Effect.gen(function* () {
        const made = yield* api.CopyBuiltin({ registry, id, pluginId: `perf-display-${index}` })
        if (!made.report.ok) return yield* Effect.die(`copy of ${id} did not check: ${made.report.message}`)
        return made
      })
    )
  )
  const enable = (count: number) =>
    withClient(server, (api) =>
      Effect.forEach(copies, (copy, index) =>
        index < count
          ? api.EnablePlugin({ scope: copy.scope, id: copy.id, commit: copy.commit, consent: true })
          : api.DisablePlugin({ scope: copy.scope, id: copy.id })
      )
    )
  await page.addInitScript(instrument)
  const chat = `${server.url}/chats/${fixture.long.chatId}`
  for (const round_ of [1, 2])
    for (const count of [0, 1, 9]) {
      await enable(count)
      const start = Date.now()
      await page.goto(chat)
      await onScreen(page)
      const openMs = Date.now() - start
      // Every copy answered for what is on screen before anything is measured.
      await page.waitForTimeout(1500)
      const opened = await since(page, 0)

      const streams = await withClient(server, (api) =>
        Effect.gen(function* () {
          const window = yield* api.ReadPath({
            chatId: fixture.long.chatId as ChatId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 8
          })
          const replies = window.entries.filter((e) => e.version.writer === "model").slice(-2)
          const started: Array<VersionId> = []
          for (const entry of replies)
            started.push(
              (yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })).version.id
            )
          return started
        })
      )
      await expect(page.getByText("generating", { exact: true }).first()).toBeVisible()
      await page.waitForTimeout(1000)
      const steadyFrom = await now(page)
      await page.waitForTimeout(3000)
      const steady = await since(page, steadyFrom)
      const typingFrom = await now(page)
      await page
        .getByTestId("composer")
        .pressSequentially("She hesitated at the door, then knocked twice.", { delay: 50 })
      const typing = await since(page, typingFrom)
      const inputs = typing.events.filter(
        (e) => e.name.startsWith("key") || e.name === "input" || e.name === "beforeinput"
      )
      await withClient(server, (api) =>
        Effect.forEach(streams, (versionId) => Effect.ignore(api.StopGeneration({ versionId })))
      )
      await page.getByTestId("composer").fill("")

      const scrollFrom = await now(page)
      await messages(page).hover()
      for (let i = 0; i < 30; i++) {
        await page.mouse.wheel(0, -1200)
        await page.waitForTimeout(100)
      }
      await page.waitForTimeout(500)
      const scrolled = await since(page, scrollFrom)

      const result = {
        round: round_,
        copies: count,
        openMs,
        openLongFramesOver100: opened.loaf.filter((e) => e.duration > 100).length,
        streamFrameP95Ms: round(
          quantile(
            steady.frames.map((f) => f.interval),
            0.95
          )
        ),
        streamLongFramesOver50: steady.loaf.filter((e) => e.duration > 50).length,
        inputP95Ms: round(
          quantile(
            inputs.map((e) => e.duration),
            0.95
          )
        ),
        inputEvents: inputs.length,
        scrollFrameP95Ms: round(
          quantile(
            scrolled.frames.map((f) => f.interval),
            0.95
          )
        ),
        scrollLongFramesOver50: scrolled.loaf.filter((e) => e.duration > 50).length,
        scrollLongFramesOver100: scrolled.loaf.filter((e) => e.duration > 100).length,
        workerCalls: scrolled.calls,
        workerCallP50Ms: round(quantile(scrolled.callMs, 0.5)),
        workerCallP99Ms: round(quantile(scrolled.callMs, 0.99)),
        workerCallMaxMs: round(scrolled.callMaxMs),
        workerQueueMax: scrolled.queueMax,
        loadAverage: loadavg()
          .map((n) => n.toFixed(1))
          .join(" ")
      }
      const line = JSON.stringify({ scenario: "display-copies", ...result })
      appendFileSync(join(test.info().project.outputDir, "perf-results.jsonl"), `${line}\n`)
      console.log(line)
      // No copy was turned off by load: each is still what the registries hold.
      await expect(page.getByRole("status", { name: "Plugins", exact: true })).toHaveCount(0)
      if (count > 0) expect(scrolled.calls).toBeGreaterThan(0)
      else expect(scrolled.calls).toBe(0)
      expect(result.inputP95Ms).toBeLessThanOrEqual(budgets.inputP95Ms)
      expect(openMs).toBeLessThan(budgets.openBottomMs)
    }
  await enable(0)
})
