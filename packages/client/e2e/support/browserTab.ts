// A link opened in a new browser tab, seen from Chromium's own tab list. Playwright sometimes
// never reports a tab Chromium opened from a Ctrl- or middle-click: the tab is there, loaded and
// attached, but the context's "page" event never comes (2026-11-24: about 1 click in 100 on a
// static page, more on a busy one). So a test can't wait for that event. Chromium only.
import { expect, type Page } from "@playwright/test"

/**
 * Runs `click`, waits for the browser tab it opens next to `page`, closes that tab and returns
 * the first address it loaded (before the app could rewrite it). A test then opens that address
 * itself to check what the tab shows.
 */
export const urlOpenedInNewTab = async (page: Page, click: () => Promise<unknown>): Promise<string> => {
  const context = page.context()
  const own = await context.newCDPSession(page)
  const { targetInfo } = await own.send("Target.getTargetInfo")
  await own.detach()
  const cdp = await context.browser()!.newBrowserCDPSession()
  try {
    const known = new Set<string>()
    let opened: { targetId: string; url: string } | undefined
    let armed = false
    const seen = ({
      targetInfo: t
    }: {
      targetInfo: { targetId: string; type: string; url: string; browserContextId?: string }
    }) => {
      if (t.type !== "page" || t.browserContextId !== targetInfo.browserContextId) return
      if (!armed) return void known.add(t.targetId)
      if (known.has(t.targetId) || opened || t.url === "" || t.url === "about:blank") return
      opened = { targetId: t.targetId, url: t.url }
    }
    cdp.on("Target.targetCreated", seen)
    cdp.on("Target.targetInfoChanged", seen)
    // Reports every existing tab first, as created.
    await cdp.send("Target.setDiscoverTargets", { discover: true })
    armed = true
    await click()
    await expect.poll(() => opened !== undefined, "a new browser tab opens").toBe(true)
    await cdp.send("Target.closeTarget", { targetId: opened!.targetId })
    return opened!.url
  } finally {
    await cdp.detach()
  }
}
