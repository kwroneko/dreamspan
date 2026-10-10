// Browser trace during streaming, summarized by renderer main-thread event name.
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { chromium } from "playwright"

const start = (args: Array<string>, ready: RegExp) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] })
    const onData = (d: Buffer) => { if (ready.test(d.toString().replace(/\x1b\[[0-9;]*m/g, ""))) resolve(child) }
    child.stdout!.on("data", onData)
    child.stderr!.on("data", onData)
    child.on("exit", (code) => reject(new Error(`exited ${code}`)))
  })

const out = process.argv[2] ?? "trace.json"
const server = await start(["--import", "tsx", "src/server/main.ts"], /Listening/)
const preview = await start(["node_modules/vite/bin/vite.js", "preview"], /localhost:47102/)
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript("window.__name = (f) => f")
  const page = await context.newPage()
  await page.goto("http://localhost:47102/?store=atom")
  await page.waitForFunction(() => window.__ready === true)
  await browser.startTracing(page, { path: out, categories: ["devtools.timeline", "blink"] })
  await page.evaluate(() => window.__startStreams(300, 3000))
  await page.waitForTimeout(5000)
  await browser.stopTracing()
} finally {
  await browser.close()
  server.kill()
  preview.kill()
}

const events = JSON.parse(readFileSync(out, "utf8")).traceEvents as Array<any>
const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")
const totals = new Map<string, number>()
for (const e of events) {
  if (e.ph !== "X" || e.tid !== main?.tid || e.pid !== main?.pid) continue
  totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000)
}
for (const [name, ms] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`${ms.toFixed(0).padStart(7)} ms  ${name}`)
}
