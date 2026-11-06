// Which messages flashed (ui/reveal.ts `flashItem` sets `data-flashing` while it runs), recorded
// from the page's first script so that a flash shorter than a poll interval isn't missed.
import { type BrowserContext, expect, type Locator, type Page } from "@playwright/test"

declare global {
  interface Window {
    __flashes?: Array<{ slot: string; reduced: boolean; iterations: ReadonlyArray<number> }>
  }
}

/** Starts recording, for every page it (or every page the context) loads from now on, and a page already loaded. */
export async function recordFlashes(page: Page | BrowserContext) {
  const install = () => {
    if (window.__flashes) return
    window.__flashes = []
    const start = () =>
      new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target as HTMLElement
          if (target.dataset.flashing === undefined || record.oldValue !== null) continue
          const slot = target.closest<HTMLElement>("article[data-slot]")?.dataset.slot
          if (slot)
            window.__flashes!.push({
              slot,
              reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
              // The flash has started by now (observers run after the script that set it).
              iterations: target.getAnimations().map((a) => Number(a.effect?.getTiming().iterations))
            })
        }
      }).observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-flashing"],
        attributeOldValue: true
      })
    if (document.documentElement) start()
    else addEventListener("DOMContentLoaded", start)
  }
  await page.addInitScript(install)
  if ("url" in page && page.url() !== "about:blank") await page.evaluate(install)
}

/** The slots flashed so far, in order. */
export const flashedSlots = (page: Page) => page.evaluate(() => (window.__flashes ?? []).map((f) => f.slot))

/** Everything recorded about the flashes so far. */
export const flashes = (page: Page) => page.evaluate(() => window.__flashes ?? [])

/** Forgets the flashes recorded so far. */
export const clearFlashes = (page: Page) => page.evaluate(() => void (window.__flashes = []))

/**
 * The message flashed (at least `times` flashes recorded for it so far: a summary's layer replacing
 * the original it first showed as flashes the new one), and once the flash ends it's unmarked: no
 * ring, no tint, no accent border.
 */
export async function expectFlashedThenUnmarked(page: Page, message: Locator, times = 1) {
  const slot = await message.getAttribute("data-slot")
  await expect
    .poll(async () => (await flashedSlots(page)).filter((s) => s === slot).length)
    .toBeGreaterThanOrEqual(times)
  await expectUnmarked(message)
}

/** No flash running and nothing marking it. */
async function expectUnmarked(message: Locator) {
  await expect(message).not.toHaveAttribute("data-flashing", /.*/, { timeout: 5000 })
  await expect(message).not.toHaveClass(/border-accent|bg-accent/)
  expect(await message.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none")
}
