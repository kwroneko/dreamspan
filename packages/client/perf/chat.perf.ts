// The performance harness (CLIENT-FRAMEWORK §7): the built client against the real server
// with the fake generator at 300 tokens a second per stream, on synthetic chats of 100,000
// and 300 messages. Each scenario measures what the owner would feel (frames, input,
// scroll anchoring, memory, renders per streamed token) and fails past its budget.
import { appendFileSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { type CDPSession, expect, type Page, test } from "@playwright/test"
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { budgets } from "./budgets.ts"
import { type Fixture, prepare } from "./fixtures.ts"
import { type PerfServer, startServer, withClient } from "./support.ts"

let server: PerfServer
let fixture: Fixture
test.beforeAll(async () => {
  const prepared = await prepare()
  fixture = prepared.fixture
  server = await startServer(prepared.dataDir)
})

test.afterAll(async () => {
  await server?.stop()
})

/** Each scenario's numbers, one JSON line each in the output directory, with the load at the time. */
const record = (scenario: string, values: Record<string, number | string>) => {
  const load = loadavg()
    .map((n) => n.toFixed(1))
    .join(" ")
  const line = JSON.stringify({ scenario, ...values, loadAverage: load })
  appendFileSync(join(test.info().project.outputDir, "perf-results.jsonl"), `${line}\n`)
  console.log(line)
}

/** Observers installed before the app loads: long animation frames, input events, frame intervals. */
const instrument = () => {
  const w = window as unknown as Record<string, unknown> & { __m: Measures }
  interface Measures {
    loaf: Array<{ start: number; duration: number }>
    events: Array<{ name: string; start: number; duration: number }>
    frames: Array<{ at: number; interval: number }>
  }
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

interface Window {
  readonly loaf: Array<{ start: number; duration: number }>
  readonly events: Array<{ name: string; start: number; duration: number }>
  readonly frames: Array<{ at: number; interval: number }>
  readonly perf: Record<string, number>
}

const now = (page: Page) => page.evaluate(() => performance.now())

/** What happened in the page since `from` (a page timestamp). */
const since = (page: Page, from: number): Promise<Window> =>
  page.evaluate((from) => {
    const m = (window as unknown as { __m: Window }).__m
    return {
      loaf: m.loaf.filter((e) => e.start >= from),
      events: m.events.filter((e) => e.start >= from),
      frames: m.frames.filter((e) => e.at >= from),
      perf: { ...(window as unknown as { __rpPerf: Record<string, number> }).__rpPerf }
    }
  }, from)

const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const round = (n: number) => Math.round(n * 10) / 10

const frameStats = (window: Window) => ({
  frameP95Ms: round(
    quantile(
      window.frames.map((f) => f.interval),
      0.95
    )
  ),
  longFramesOver100: window.loaf.filter((e) => e.duration > 100).length,
  longFramesOver50: window.loaf.filter((e) => e.duration > 50).length,
  worstFrameMs: round(Math.max(0, ...window.loaf.map((e) => e.duration)))
})

const openPage = async (page: Page) => {
  await page.addInitScript(instrument)
  return page.context().newCDPSession(page)
}

const heapMb = async (page: Page, cdp: CDPSession) => {
  await cdp.send("HeapProfiler.collectGarbage")
  const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number }
  return round(usedSize / 2 ** 20)
}

const chatUrl = (chatId: string, search = "") => `${server.url}/chats/${chatId}${search}`
const messages = (page: Page) => page.getByTestId("messages")

/**
 * Waits until the message (by slot, or the last one rendered) is on screen in the list.
 * Playwright's own viewport check reports rows of this list as off screen.
 */
const onScreen = (page: Page, slot: string | null = null) =>
  page
    .waitForFunction(
      (slot) => {
        const list = document.querySelector("[data-testid=messages]")?.getBoundingClientRect()
        const rows = document.querySelectorAll("article[data-slot]")
        const row = slot === null ? rows[rows.length - 1] : document.querySelector(`article[data-slot="${slot}"]`)
        if (!list || !row) return false
        const rect = row.getBoundingClientRect()
        return rect.bottom > list.top && rect.top < list.bottom
      },
      slot,
      { timeout: 60_000, polling: 200 }
    )
    .catch(async (error: unknown) => {
      const state = await page.evaluate(() => {
        const list = document.querySelector("[data-testid=messages]")?.getBoundingClientRect()
        const rows = [...document.querySelectorAll("article[data-slot]")].map((r) => {
          const rect = r.getBoundingClientRect()
          return [Math.round(rect.top), Math.round(rect.bottom)]
        })
        return { list: list && [Math.round(list.top), Math.round(list.bottom)], rows, url: location.href }
      })
      throw new Error(`not on screen: ${JSON.stringify(state)}`, { cause: error })
    })

/** Regenerates the last `count` replies of a chat: that many streams at once. */
const startStreams = (chatId: string, count: number) =>
  withClient(server, (api) =>
    Effect.gen(function* () {
      const window = yield* api.ReadPath({
        chatId: chatId as ChatId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 4 * count
      })
      const replies = window.entries.filter((e) => e.version.writer === "model").slice(-count)
      const started: Array<VersionId> = []
      for (const entry of replies) {
        started.push((yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })).version.id)
      }
      return started
    })
  )

const stopStreams = (versions: ReadonlyArray<VersionId>) =>
  withClient(server, (api) => Effect.forEach(versions, (versionId) => Effect.ignore(api.StopGeneration({ versionId }))))

/** The top of a message on screen relative to the list, by slot. */
const topOf = (page: Page, slot: string) =>
  page.evaluate((slot) => {
    const list = document.querySelector("[data-testid=messages]")!.getBoundingClientRect()
    const row = document.querySelector(`article[data-slot="${slot}"]`)
    return row ? row.getBoundingClientRect().top - list.top : null
  }, slot)

const scrollState = (page: Page) =>
  messages(page).evaluate((list) => ({
    scrollTop: Math.round(list.scrollTop),
    scrollHeight: list.scrollHeight,
    firstIndex: Number(list.querySelector<HTMLElement>("[data-index]")?.dataset.index ?? -1)
  }))

/**
 * Scrolls the list to the top of what's loaded. The first loaded message is then at the
 * list's top padding, which is where it must stay when older history lands above it.
 */
const scrollToTop = async (page: Page) => {
  const slot = await page.evaluate(
    () => (window as unknown as { __rpPerf: { window: { first: string } } }).__rpPerf.window.first
  )
  await messages(page).evaluate((list) => list.scrollTo({ top: 0 }))
  return { slot, top: 16 }
}

/** Two animation frames: what a change needs to reach the screen. */
const settle = (page: Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))

/** The first message whose bottom is in view. */
const firstVisible = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector("[data-testid=messages]")!.getBoundingClientRect()
    const rows = [...document.querySelectorAll<HTMLElement>("article[data-slot]")]
    const row = rows.find((r) => r.getBoundingClientRect().bottom > list.top + 8)!
    return { slot: row.dataset.slot!, top: row.getBoundingClientRect().top - list.top }
  })

test("open at the bottom and at a deep slot", async ({ page }) => {
  await openPage(page)
  const start = Date.now()
  await page.goto(chatUrl(fixture.long.chatId))
  await onScreen(page)
  const bottomMs = Date.now() - start
  const bottom = await since(page, 0)

  const deepStart = Date.now()
  await page.goto(chatUrl(fixture.long.chatId, `?slot=${fixture.long.deep}`))
  await onScreen(page, fixture.long.deep)
  const deepMs = Date.now() - deepStart
  record("open", { bottomMs, deepMs, ...frameStats(bottom) })
  expect(bottomMs).toBeLessThan(budgets.openBottomMs)
  expect(deepMs).toBeLessThan(budgets.openDeepMs)
})

test("scroll the full length of 100,000 messages", async ({ page }) => {
  const cdp = await openPage(page)
  await page.goto(chatUrl(fixture.long.chatId))
  await onScreen(page)
  const heapStart = await heapMb(page, cdp)
  const from = await now(page)
  const errors: Array<number> = []
  const examples: Array<Record<string, number>> = []
  const started = Date.now()
  let pages = 0
  const olderLeft = () =>
    page.evaluate(() => (window as unknown as { __rpPerf: { window: { older: boolean } } }).__rpPerf.window.older)
  while (await olderLeft()) {
    const before = await scrollToTop(page)
    // The next older page lands above: this message must stay where it is.
    await page
      .waitForFunction(
        (slot) => {
          const row = document.querySelector(`article[data-slot="${slot}"]`)?.closest("[data-index]")
          return row === null || row === undefined || Number((row as HTMLElement).dataset.index) > 0
        },
        before.slot,
        { timeout: 30_000 }
      )
      .catch(async (error: unknown) => {
        const state = await page.evaluate(
          () => (window as unknown as { __rpPerf: { window: unknown } }).__rpPerf.window
        )
        throw new Error(`no older page after ${pages} pages: ${JSON.stringify(state)}`, { cause: error })
      })
    await settle(page)
    const after = await topOf(page, before.slot)
    if (after !== null) errors.push(Math.abs(after - before.top))
    if (after !== null && Math.abs(after - before.top) > budgets.anchorErrorPx && examples.length < 5) {
      examples.push({ page: pages, before: round(before.top), after: round(after), ...(await scrollState(page)) })
    }
    pages++
  }
  const window = await since(page, from)
  const heapEnd = await heapMb(page, cdp)
  record("scroll", {
    pages,
    seconds: round((Date.now() - started) / 1000),
    anchorErrorMaxPx: round(Math.max(0, ...errors)),
    anchorErrorsOverBudget: errors.filter((e) => e > budgets.anchorErrorPx).length,
    examples: JSON.stringify(examples),
    heapStartMb: heapStart,
    heapEndMb: heapEnd,
    ...frameStats(window)
  })
  expect(Math.max(0, ...errors)).toBeLessThanOrEqual(budgets.anchorErrorPx)
  expect(heapEnd - heapStart).toBeLessThan(budgets.heapGrowthMb)
  expect(heapEnd).toBeLessThan(budgets.heapMb)
})

test("six streams: renders per token, drift, prepending and typing", async ({ page }) => {
  await openPage(page)
  await page.goto(chatUrl(fixture.long.chatId))
  await onScreen(page)
  const streams = await startStreams(fixture.long.chatId, 6)
  await expect(page.getByText("generating", { exact: true }).first()).toBeVisible()
  await page.waitForTimeout(1000)

  // Steady streaming: only the bodies of streaming messages render, once per update.
  const steadyFrom = await now(page)
  await page.waitForTimeout(3000)
  const steady = await since(page, steadyFrom)

  // Typing in the composer while the streams run.
  const typingFrom = await now(page)
  const counters0 = await page.evaluate(() => ({
    ...(window as unknown as { __rpPerf: Record<string, number> }).__rpPerf
  }))
  await page.getByTestId("composer").pressSequentially("She hesitated at the door, then knocked twice.", { delay: 50 })
  const typing = await since(page, typingFrom)
  const counters1 = typing.perf
  const updates = counters1.rowUpdates! - counters0.rowUpdates!
  const bodies = counters1.bodyRenders! - counters0.bodyRenders!
  const rows = counters1.rowRenders! - counters0.rowRenders!
  const inputs = typing.events.filter((e) => e.name.startsWith("key") || e.name === "input" || e.name === "beforeinput")

  // Scrolled up a screen, replies growing below must not move what's on screen.
  await messages(page).hover()
  await page.mouse.wheel(0, -900)
  await page.waitForTimeout(300)
  const anchor = await firstVisible(page)
  await page.waitForTimeout(1500)
  const drift = Math.abs(((await topOf(page, anchor.slot)) ?? anchor.top) - anchor.top)

  // Prepending older history while they stream.
  const top = await scrollToTop(page)
  await page.waitForFunction(
    (slot) =>
      Number(
        document.querySelector(`article[data-slot="${slot}"]`)?.closest<HTMLElement>("[data-index]")?.dataset.index ?? 0
      ) > 0,
    top.slot
  )
  await settle(page)
  const prependError = Math.abs(((await topOf(page, top.slot)) ?? top.top) - top.top)
  await stopStreams(streams)
  const all = await since(page, steadyFrom)
  // The server's own event loop over the last minute: every stream shares it.
  const health = await withClient(server, (api) => api.Health())

  record("streams", {
    updates,
    bodyRendersPerUpdate: round(bodies / Math.max(1, updates)),
    rowRendersWhileTyping: rows,
    inputP95Ms: round(
      quantile(
        inputs.map((e) => e.duration),
        0.95
      )
    ),
    inputEvents: inputs.length,
    driftPx: round(drift),
    prependErrorPx: round(prependError),
    gaps: all.perf.gaps ?? 0,
    serverLoopP99Ms: health.eventLoopP99Ms,
    serverLoopMaxMs: health.eventLoopMaxMs,
    steadyFrameP95Ms: frameStats(steady).frameP95Ms,
    ...frameStats(all)
  })
  expect(updates).toBeGreaterThan(50)
  expect(bodies / updates).toBeLessThanOrEqual(budgets.bodyRendersPerUpdate)
  expect(rows).toBeLessThanOrEqual(budgets.rowRendersWhileStreaming)
  expect(
    quantile(
      inputs.map((e) => e.duration),
      0.95
    )
  ).toBeLessThanOrEqual(budgets.inputP95Ms)
  expect(drift).toBeLessThanOrEqual(budgets.streamDriftPx)
  expect(prependError).toBeLessThanOrEqual(budgets.anchorErrorPx)
  expect(all.perf.gaps ?? 0).toBe(budgets.gaps)
  expect(health.eventLoopP99Ms).toBeLessThanOrEqual(budgets.serverLoopP99Ms)
  expect(frameStats(steady).frameP95Ms).toBeLessThanOrEqual(budgets.frameP95Ms)
  expect(frameStats(all).longFramesOver100).toBeLessThanOrEqual(budgets.longFramesOver100)
})

test("swipe through versions", async ({ page }) => {
  await openPage(page)
  // Every 50th message from the root, a reply with three good versions and a failed one.
  const target = await withClient(server, (api) =>
    api
      .ReadPath({ chatId: fixture.long.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 60 })
      .pipe(Effect.map((w) => w.entries.find((e) => e.versionCount === 4)!.slotId))
  )
  await page.goto(chatUrl(fixture.long.chatId, `?slot=${target}`))
  const row = page.locator(`article[data-slot="${target}"]`)
  await onScreen(page, target)
  const from = await now(page)
  for (let i = 0; i < 3; i++) {
    await row.getByRole("button", { name: "Previous version" }).click()
    await expect(row.getByText(`${3 - i} / 4`)).toBeVisible()
  }
  for (let i = 0; i < 3; i++) {
    await row.getByRole("button", { name: "Next version" }).click()
    await expect(row.getByText(`${2 + i} / 4`)).toBeVisible()
  }
  const window = await since(page, from)
  const clicks = window.events.filter((e) => e.name === "click" || e.name === "pointerup" || e.name === "pointerdown")
  record("swipe", {
    inputP95Ms: round(
      quantile(
        clicks.map((e) => e.duration),
        0.95
      )
    ),
    ...frameStats(window)
  })
  expect(
    quantile(
      clicks.map((e) => e.duration),
      0.95
    )
  ).toBeLessThanOrEqual(budgets.inputP95Ms)
})

test("switch chats mid-stream", async ({ page }) => {
  await openPage(page)
  await page.goto(chatUrl(fixture.long.chatId))
  await onScreen(page)
  const streams = await startStreams(fixture.long.chatId, 6)
  await page.waitForTimeout(1500)
  const from = await now(page)
  let started = Date.now()
  await page.getByRole("link", { name: "← Chats" }).click()
  await page.getByRole("link", { name: fixture.short[0]!.title }).click()
  await onScreen(page)
  const awayMs = Date.now() - started
  await page.waitForTimeout(1000)
  started = Date.now()
  await page.goBack()
  await page.goBack()
  await expect(page.getByText("generating", { exact: true }).first()).toBeVisible()
  const backMs = Date.now() - started
  // Still streaming, and nothing was missed while away.
  const generatingRow = page.locator("article", { has: page.getByText("generating", { exact: true }) }).first()
  const length = async () => (await generatingRow.locator(".markdown").innerText()).length
  const first = await length()
  await page.waitForTimeout(800)
  const grew = (await length()) > first
  await stopStreams(streams)
  const window = await since(page, from)
  record("switch", { awayMs, backMs, grew: String(grew), gaps: window.perf.gaps ?? 0, ...frameStats(window) })
  expect(grew).toBe(true)
  expect(window.perf.gaps ?? 0).toBe(budgets.gaps)
  expect(awayMs).toBeLessThan(budgets.openBottomMs)
  expect(backMs).toBeLessThan(budgets.openBottomMs)
})
