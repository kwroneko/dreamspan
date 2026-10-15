import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
// Usage: npm run measure:images -- BASE_URL OUTPUT_DIR PHASE [--fast-4g]
// [--desktop-only] [--cold-only] [--import=/absolute/synthetic/ST/user/folder]
const [base, out, phase = "images", ...options] = process.argv.slice(2)
if (!base || !out)
  throw new Error(
    "Pass BASE_URL OUTPUT_DIR PHASE and optional --fast-4g / --desktop-only / --cold-only / --import=PATH"
  )
const flag = options.includes("--fast-4g") ? "4g" : undefined
const importFolder = options.find((option) => option.startsWith("--import="))?.slice(9)
mkdirSync(`${out}/screenshots`, { recursive: true })
const browser = await chromium.launch()
if (importFolder) {
  const page = await browser.newPage()
  await page.goto(`${base}/import/st`)
  await page.getByLabel("Folder path").fill(importFolder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await page.getByRole("list", { name: "Imported" }).waitFor({ timeout: 600000 })
  await page.screenshot({ path: `${out}/screenshots/import-${phase}.png` })
  await page.close()
}
const results = []
for (const width of options.includes("--desktop-only") ? [1440] : [1440, 390]) {
  const context = await browser.newContext({
    viewport: { width, height: width === 1440 ? 900 : 844 },
    deviceScaleFactor: 1
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Network.enable")
  if (flag?.startsWith("4g"))
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: (9 * 1024 * 1024) / 8,
      uploadThroughput: (1.5 * 1024 * 1024) / 8,
      connectionType: "cellular4g"
    })
  for (const temperature of options.includes("--cold-only") ? ["cold"] : ["cold", "warm"]) {
    if (temperature === "warm") {
      await page.evaluate(() => {
        for (const e of document.querySelectorAll("*")) {
          if (["auto", "scroll"].includes(getComputedStyle(e).overflowY)) e.scrollTop = 0
        }
        window.scrollTo(0, 0)
      })
      await page.waitForTimeout(100)
    }
    const media = new Map()
    cdp.removeAllListeners("Network.requestWillBeSent")
    cdp.removeAllListeners("Network.responseReceived")
    cdp.removeAllListeners("Network.loadingFinished")
    cdp.on("Network.requestWillBeSent", (e) => {
      if (e.request.url.includes("/library/media?"))
        media.set(e.requestId, { url: e.request.url, bytes: 0, cached: false, done: false })
    })
    cdp.on("Network.responseReceived", (e) => {
      const m = media.get(e.requestId)
      if (m) {
        m.cached = !!(e.response.fromDiskCache || e.response.fromPrefetchCache)
        m.status = e.response.status
      }
    })
    cdp.on("Network.loadingFinished", (e) => {
      const m = media.get(e.requestId)
      if (m) {
        m.bytes = e.encodedDataLength
        m.done = true
      }
    })
    const begin = performance.now()
    if (temperature === "warm") await page.reload({ waitUntil: "domcontentloaded" })
    else await page.goto(`${base}/`, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => document.querySelectorAll("main img").length > 150, null, { timeout: 600000 })
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("main img")]
          .filter((img) => img.getBoundingClientRect().top < innerHeight && img.getBoundingClientRect().bottom > 0)
          .every((img) => img.complete && img.naturalWidth > 0),
      null,
      { timeout: 600000 }
    )
    await page.waitForTimeout(500)
    const firstScreen = {
      ms: Math.round(performance.now() - begin),
      requests: media.size,
      bytes: [...media.values()].reduce((sum, m) => sum + m.bytes, 0)
    }
    await page.screenshot({
      path: `${out}/screenshots/home-${phase}-${width}-${temperature}${flag?.startsWith("4g") ? "-4g" : ""}.png`
    })
    // Traverse the entire library so lazy images are included, waiting at each viewport.
    let steps = 0
    while (true) {
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("main img")]
            .filter((img) => img.getBoundingClientRect().top < innerHeight && img.getBoundingClientRect().bottom > 0)
            .every((img) => img.complete && img.naturalWidth > 0),
        null,
        { timeout: 600000 }
      )
      const end = await page.evaluate(() => {
        const containers = [...document.querySelectorAll("*")].filter(
          (e) => e.scrollHeight > e.clientHeight + 10 && ["auto", "scroll"].includes(getComputedStyle(e).overflowY)
        )
        const scroller = containers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? document.scrollingElement
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return true
        scroller.scrollTop += innerHeight * 0.85
        return false
      })
      if (end) break
      await page.waitForTimeout(100)
      if (++steps > 200) throw new Error("scroll did not terminate")
    }
    await page.waitForFunction(
      () => [...document.querySelectorAll("main img")].every((img) => img.complete && img.naturalWidth > 0),
      null,
      { timeout: 600000 }
    )
    await page.waitForTimeout(200)
    const row = {
      phase,
      width,
      temperature,
      profile: flag?.startsWith("4g") ? "Fast 4G" : "unthrottled",
      firstScreen,
      allMs: Math.round(performance.now() - begin),
      requests: media.size,
      networkRequests: [...media.values()].filter((m) => m.bytes > 0).length,
      bytes: [...media.values()].reduce((sum, m) => sum + m.bytes, 0),
      originals: [...media.values()].filter((m) => !new URL(m.url).searchParams.has("w")).length,
      steps
    }
    results.push(row)
    console.log(JSON.stringify(row))
    writeFileSync(
      `${out}/${phase}${flag?.startsWith("4g") ? "-4g" : ""}-measurements.json`,
      JSON.stringify(results, null, 2)
    )
  }
  await context.close()
}
await browser.close()
