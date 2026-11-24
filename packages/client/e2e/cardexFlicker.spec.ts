// Showing the archive on home, again and again (owner, 2026-11-23: the count and the archive's
// UI flickered off for an instant after appearing). Every animation frame from the click on, the
// cardex option's count, the filter bar, the result line and the cards are looked for; once one
// has appeared it must stay in every frame, whether the archive is shown for the first time,
// shown again (its last answer stays while it's asked again) or searched for something else
// (the last search's results stay, dimmed, until the new ones are in).
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"

interface Recorder {
  frames: number
  seen: Record<string, number>
  gaps: string[]
  stop: boolean
}

/** Starts looking at every frame: which parts are there, and any that went missing after appearing. */
const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __flicker: Recorder }
    const state: Recorder = { frames: 0, seen: {}, gaps: [], stop: false }
    w.__flicker = state
    const parts = (main: Element | null): Record<string, boolean> => {
      const tab = main
        ? [...main.querySelectorAll("button")].find((b) => b.textContent?.startsWith("cardex"))
        : undefined
      return {
        count: (tab?.textContent ?? "cardex") !== "cardex",
        bar: !!main?.querySelector("[data-filter-panels]"),
        line: !!main?.querySelector("[data-source-result-line]"),
        cards: !!main?.querySelector("[data-remote-card]")
      }
    }
    const tick = () => {
      if (state.stop) return
      state.frames++
      for (const [part, present] of Object.entries(parts(document.querySelector("main")))) {
        if (present) state.seen[part] ??= state.frames
        else if (state.seen[part] !== undefined) state.gaps.push(`${part} missing in frame ${state.frames}`)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

const stopRecording = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __flicker: Recorder }
    w.__flicker.stop = true
    return w.__flicker
  })

test("the archive's count and bar appear once and stay, shown again and searched", async ({ page }) => {
  test.setTimeout(120_000)
  const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: "0" })
  try {
    await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(server.url)
    const main = page.getByRole("main")
    const cardex = main.getByRole("button", { name: "cardex", exact: true })
    const all = main.getByRole("button", { name: "All", exact: true })
    const results = main.locator("[data-source-results]")
    // A search asked again goes out 300 ms after the click, behind what's shown: this outlasts its answer.
    const settle = async () => {
      await page.waitForTimeout(1500)
      await expect(results).toHaveAttribute("aria-busy", "false")
    }
    /** Records every frame from `act` until its search is answered, then checks nothing went missing. */
    const watch = async (label: string, act: () => Promise<void>) => {
      await record(page)
      await act()
      await expect(main.locator("[data-source-result-line]")).toBeVisible()
      await settle()
      const seen = await stopRecording(page)
      expect(Object.keys(seen.seen).sort(), `${label}: every part appeared`).toEqual(["bar", "cards", "count", "line"])
      expect(seen.gaps, `${label}: nothing went missing after appearing`).toEqual([])
    }

    await cardex.waitFor()
    for (const round of [1, 2, 3]) {
      await watch(`shown (${round})`, () => cardex.click())
      await all.click()
      await expect(results).toHaveCount(0)
    }
    await cardex.click()
    await settle()
    await watch("searched", () => main.getByRole("searchbox", { name: "Search cardex", exact: true }).fill("e"))
  } finally {
    await server.stop()
  }
})
