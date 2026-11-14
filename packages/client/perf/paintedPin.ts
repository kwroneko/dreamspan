// Inspect frames actually presented by Chromium, independently of DOM sampling
// before ResizeObserver delivery. The marker is absolute and changes no geometry.
import { writeFileSync } from "node:fs"
import type { Page } from "@playwright/test"
import sharp from "sharp"
import { budgets } from "./budgets.ts"

export const observePaintedPin = async (page: Page, failureImage?: string) => {
  const marker = await page.getByTestId("messages").evaluate((list) => {
    const row = [...list.querySelectorAll<HTMLElement>("[data-index]")].at(-1)!
    const dot = document.createElement("span")
    dot.dataset.perfPaintedPin = ""
    dot.style.cssText =
      "position:absolute;bottom:2px;left:12px;width:16px;height:8px;background:rgb(17,249,117);pointer-events:none;z-index:10"
    row.append(dot)
    const rect = dot.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width }
  })
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  // Screencast can begin with the compositor's previous surface even after rAF.
  // Force the marker's first presentation before observing subsequent frames.
  await page.screenshot()
  const cdp = await page.context().newCDPSession(page)
  const pending = new Set<Promise<void>>()
  const measured = { frames: 0, missing: 0, maximumPx: 0, errors: [] as string[] }
  let savedFailure = false
  const frame = (event: { data: string; sessionId: number; metadata: { deviceWidth: number } }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {})
    const work = (async () => {
      const bytes = Buffer.from(event.data, "base64")
      const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const scale = info.width / event.metadata.deviceWidth
      const lo = Math.max(0, Math.floor(marker.x * scale))
      const hi = Math.min(info.width, Math.ceil((marker.x + marker.width) * scale))
      let first = -1
      for (let y = 0; y < info.height; y++) {
        let pixels = 0
        for (let x = lo; x < hi; x++) {
          const i = (y * info.width + x) * info.channels
          // JPEG tolerances around the distinctive solid mint marker.
          if (data[i]! < 75 && data[i + 1]! > 215 && data[i + 2]! > 60 && data[i + 2]! < 180) pixels++
        }
        if (pixels >= 4) {
          first = y
          break
        }
      }
      measured.frames++
      const distance = first < 0 ? Number.POSITIVE_INFINITY : Math.abs(first / scale - marker.y)
      if (first < 0) measured.missing++
      measured.maximumPx = Math.max(measured.maximumPx, distance)
      if (!savedFailure && distance > budgets.pinnedPx && failureImage) {
        savedFailure = true
        writeFileSync(failureImage, bytes)
      }
    })().catch((error: unknown) => {
      measured.errors.push(String(error))
    })
    pending.add(work)
    void work.finally(() => pending.delete(work))
  }
  cdp.on("Page.screencastFrame", frame)
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 })
  return {
    result: () => ({ ...measured, errors: [...measured.errors] }),
    stop: async () => {
      await cdp.send("Page.stopScreencast")
      cdp.off("Page.screencastFrame", frame)
      await Promise.all(pending)
      await cdp.detach()
      await page.locator("[data-perf-painted-pin]").evaluateAll((dots) => dots.forEach((dot) => dot.remove()))
      return { ...measured, errors: [...measured.errors] }
    }
  }
}
