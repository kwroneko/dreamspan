// CPU profile of the client during streaming, aggregated by self time.
// Usage: node --import tsx scripts/profile.ts [atom|plain] [streams|baseline]
import { type ChildProcess, spawn } from "node:child_process"
import { chromium } from "playwright"

const mode = process.argv[2] ?? "atom"
const scenario = process.argv[3] ?? "streams"

const start = (args: Array<string>, ready: RegExp) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] })
    const onData = (d: Buffer) => { if (ready.test(d.toString().replace(/\x1b\[[0-9;]*m/g, ""))) resolve(child) }
    child.stdout!.on("data", onData)
    child.stderr!.on("data", onData)
    child.on("exit", (code) => reject(new Error(`exited ${code}`)))
  })

const server = await start(["--import", "tsx", "src/server/main.ts"], /Listening/)
const preview = await start(["node_modules/vite/bin/vite.js", "preview"], /localhost:47102/)
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript("window.__name = (f) => f")
  const page = await context.newPage()
  await page.goto(`http://localhost:47102/?store=${mode}`)
  await page.waitForFunction(() => window.__ready === true)
  const cdp = await context.newCDPSession(page)
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 })
  await page.evaluate(() => { window.__perf.frames = []; window.__perf.recording = true })
  await cdp.send("Profiler.start")
  if (scenario === "streams") await page.evaluate(() => window.__startStreams(300, 3000))
  await page.getByTestId("composer").pressSequentially("She hesitated at the door, then knocked twice. ".repeat(2), { delay: 60 })
  const { profile } = await cdp.send("Profiler.stop")
  const frames = await page.evaluate(() => window.__perf.frames)

  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map<string, number>()
  const dt = profile.timeDeltas ?? []
  profile.samples?.forEach((id, i) => {
    const n = nodes.get(id)!
    const f = n.callFrame
    const file = f.url.split("/").pop() || "(native)"
    const key = `${f.functionName || "(anonymous)"}  ${file}:${f.lineNumber}`
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000)
  })
  const total = [...self.values()].reduce((a, b) => a + b, 0)
  const sorted = frames.slice().sort((a, b) => a - b)
  console.log(`${mode}/${scenario}: frames p50 ${sorted[Math.floor(sorted.length * 0.5)]?.toFixed(1)} p95 ${
    sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1)
  } over25 ${(100 * frames.filter((f) => f > 25).length / frames.length).toFixed(1)}%`)
  for (const [key, ms] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
    console.log(`${ms.toFixed(0).padStart(7)} ms ${(100 * ms / total).toFixed(1).padStart(5)}%  ${key}`)
  }
} finally {
  await browser.close()
  server.kill()
  preview.kill()
}
