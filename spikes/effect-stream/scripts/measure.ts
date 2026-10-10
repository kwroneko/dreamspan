// Spike measurements: Effect atoms vs a plain external store, same UI, same server.
// Spawns a fresh server per scenario and a `vite preview` of the production build.
import { type ChildProcess, spawn } from "node:child_process"
import { chromium, type Page } from "playwright"

const SERVER_PORT = 47100
const PREVIEW = "http://localhost:47102"
const TOKENS_PER_SECOND = Number(process.env.TPS ?? 300)
const STREAM_SECONDS = 10

const start = (cmd: string, args: Array<string>, ready: RegExp, env: Record<string, string> = {}) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    const onData = (data: Buffer) => {
      if (ready.test(data.toString().replace(/\x1b\[[0-9;]*m/g, ""))) resolve(child)
    }
    child.stdout!.on("data", onData)
    child.stderr!.on("data", onData)
    child.on("exit", (code) => reject(new Error(`${cmd} exited with ${code}`)))
  })

const quantile = (values: Array<number>, q: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const round = (n: number) => Math.round(n * 10) / 10

async function installObservers(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__loaf = []
    w.__events = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any) w.__loaf.push({ duration: e.duration, blocking: e.blockingDuration })
    }).observe({ type: "long-animation-frame" })
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any) w.__events.push({ name: e.name, duration: e.duration })
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit)
    w.__distanceFromEnd = []
    const list = document.querySelector("[data-testid=list]")!
    const sample = () => {
      w.__distanceFromEnd.push(list.scrollHeight - list.scrollTop - list.clientHeight)
      if (w.__sampling) requestAnimationFrame(sample)
    }
    w.__sampling = true
    requestAnimationFrame(sample)
  })
}

async function run(mode: "atom" | "plain", throttle: number) {
  const server = await start(process.execPath, ["--import", "tsx", "src/server/main.ts"], /Listening/, { PORT: String(SERVER_PORT) })
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    // tsx (esbuild keepNames) wraps functions passed to page.evaluate in a __name helper.
    await context.addInitScript("window.__name = (f) => f")
    const page = await context.newPage()
    await page.goto(`${PREVIEW}/?store=${mode}`)
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 })
    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
    await installObservers(page)

    // Phase 1: pinned at the bottom, six streams, typing in the composer.
    await page.evaluate(() => {
      Object.assign(window.__perf, { renders: 0, rowUpdates: 0, batches: 0, deltas: 0, frames: [], recording: true })
    })
    await page.evaluate(([tps, tokens]) => window.__startStreams(tps!, tokens!), [
      TOKENS_PER_SECOND,
      TOKENS_PER_SECOND * STREAM_SECONDS
    ])
    const typing = page.getByTestId("composer").pressSequentially(
      "She hesitated at the door, then knocked twice. ".repeat(3),
      { delay: 60 }
    )
    await page.waitForTimeout(5000)
    await typing

    // Phase 2: scroll up into the history while streams keep growing at the bottom.
    const list = page.getByTestId("list")
    await list.hover()
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, -600)
      await page.waitForTimeout(40)
    }
    await page.waitForTimeout(300)
    const anchorBefore = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".row")]
      const list = document.querySelector("[data-testid=list]")!.getBoundingClientRect()
      const first = rows.find((r) => r.getBoundingClientRect().bottom > list.top + 40)!
      return { index: first.dataset.index, top: first.getBoundingClientRect().top }
    })
    await page.waitForTimeout(1500)
    const anchorDrift = await page.evaluate((before) => {
      const row = document.querySelector<HTMLElement>(`.row[data-index="${before.index}"]`)
      return row ? Math.abs(row.getBoundingClientRect().top - before.top) : -1
    }, anchorBefore)

    const data = await page.evaluate(() => {
      const w = window as any
      w.__perf.recording = false
      w.__sampling = false
      return { perf: w.__perf, loaf: w.__loaf, events: w.__events, distance: w.__distanceFromEnd }
    })
    await page.evaluate(() => window.__stopAll())

    // Only phase 1 samples count for "stayed pinned": phase 2 scrolls away on purpose.
    const pinnedSamples = data.distance.slice(0, Math.floor(data.distance.length * 0.55))
    const frames: Array<number> = data.perf.frames
    return {
      mode,
      throttle: `${throttle}x`,
      deltas: data.perf.deltas,
      batches: data.perf.batches,
      rowUpdates: data.perf.rowUpdates,
      rendersPerRowUpdate: round(data.perf.renders / Math.max(1, data.perf.rowUpdates)),
      frameP50: round(quantile(frames, 0.5)),
      frameP95: round(quantile(frames, 0.95)),
      frameP99: round(quantile(frames, 0.99)),
      framesOver25ms: `${round(100 * frames.filter((f) => f > 25).length / Math.max(1, frames.length))}%`,
      longFrames: data.loaf.length,
      blockingMs: round(data.loaf.reduce((s: number, e: any) => s + e.blocking, 0)),
      slowInputEvents: data.events.length,
      inputP95: round(quantile(data.events.map((e: any) => e.duration), 0.95)),
      maxDistanceFromEndPx: round(Math.max(0, ...pinnedSamples)),
      anchorDriftPx: round(anchorDrift)
    }
  } finally {
    await browser.close()
    server.kill()
  }
}

const preview = await start(process.execPath, ["node_modules/vite/bin/vite.js", "preview"], /localhost:47102/)
try {
  const results = []
  for (const throttle of [1, 4]) {
    for (const mode of ["atom", "plain"] as const) {
      results.push(await run(mode, throttle))
      console.log(JSON.stringify(results.at(-1)))
    }
  }
  console.table(results)
} finally {
  preview.kill()
}
