// Opt-in production-client profiling at owner scale. All inputs are synthetic.
// CLIENT_SCALE_WORK=/storage/... npx playwright test -c
// packages/client/perf/playwright.config.ts clientScale.perf.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Worker } from "node:worker_threads"
import { loadavg } from "node:os"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { startServer, withClient } from "./support.ts"
import { expectLayout } from "../e2e/support/layoutAudit.ts"

test("six client actions with 500 branches, 3,000 messages and 30 swipes", async ({ browser }) => {
  const work = process.env.CLIENT_SCALE_WORK
  test.skip(!work, "requires an artifact directory outside the checkout")
  const label = process.env.CLIENT_SCALE_LABEL ?? "current"
  const data = join(work!, "data")
  mkdirSync(data, { recursive: true })
  const env = process.env.CLIENT_SCALE_DIST ? { CLIENT_DIST: resolve(process.env.CLIENT_SCALE_DIST) } : {}
  let server = await startServer(data, env)
  const idsFile = join(work!, "ids.json")
  try {
    if (!existsSync(idsFile)) {
      const chats = await withClient(server, (api) =>
        Effect.all([api.CreateChat({ title: "Scale voyage" }), api.CreateChat({ title: "Second voyage" })])
      )
      await server.stop()
      await new Promise<void>((done, reject) => {
        const worker = new Worker(new URL("./branchFixture.ts", import.meta.url), {
          workerData: { file: join(data, "rp-harness.db"), chat: chats[0]!.id }
        })
        worker.once("error", reject)
        worker.once("exit", (code) => (code === 0 ? done() : reject(new Error(`fixture worker exited ${code}`))))
      })
      writeFileSync(idsFile, JSON.stringify(chats))
      server = await startServer(data, env)
    }
    const chats = JSON.parse(readFileSync(idsFile, "utf8")) as Array<{ id: string }>
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(120_000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    const cdp = await page.context().newCDPSession(page)
    // Thread time separates the browser's work from CPU scheduling delays on this shared host.
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" })
    const samples: Array<{ action: string; taskMs: number; scriptMs: number; layoutMs: number; wallMs: number }> = []
    const idle = () => page.waitForTimeout(1000)
    const metrics = async () =>
      Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((entry) => [entry.name, entry.value]))
    const measure = async (action: string, run: () => Promise<void>) => {
      await idle()
      const events: unknown[] = []
      const collect = ({ value }: { value: unknown[] }) => events.push(...value)
      cdp.on("Tracing.dataCollected", collect)
      await cdp.send("Tracing.start", {
        // CPU sampling is a diagnostic pass: its interrupts can distort short-action budgets.
        categories: process.env.CLIENT_SCALE_CPU_PROFILE
          ? "devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler"
          : "devtools.timeline",
        options: "sampling-frequency=1000",
        transferMode: "ReportEvents"
      })
      const before = await metrics()
      const start = performance.now()
      await run()
      await idle()
      const after = await metrics()
      const complete = new Promise<void>((done) => cdp.once("Tracing.tracingComplete", () => done()))
      await cdp.send("Tracing.end")
      await complete
      cdp.off("Tracing.dataCollected", collect)
      writeFileSync(join(work!, `${label}-${action}-trace.json`), JSON.stringify({ traceEvents: events }))
      const ms = (name: string) => Math.round((after[name]! - before[name]!) * 1000)
      samples.push({
        action,
        taskMs: ms("TaskDuration"),
        scriptMs: ms("ScriptDuration"),
        layoutMs: ms("LayoutDuration"),
        wallMs: Math.round(performance.now() - start - 1000)
      })
    }
    try {
      await page.goto(`${server.url}/?side=chats`)
      await idle()
      const chat = (name: string) => page.getByRole("link", { name: `Open chat ${name}`, exact: true }).first()
      // Resolve accessibility selectors before timing; injected selector scans are not app work.
      const openTarget = (await chat("Scale voyage").elementHandle())!
      await measure("openChat", async () => {
        await openTarget.click()
        await page.locator("[data-frame] article").first().waitFor()
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLButtonElement>("[data-frame] button")].some(
            (button) => /^Branch:.*switch branch$/.test(button.getAttribute("aria-label") ?? "") && !button.disabled
          )
        )
        await page.locator('[data-foot-section="branch"] [data-fork-row]').first().waitFor()
      })
      const branch = page
        .locator("[data-frame]")
        .first()
        .getByRole("button", { name: /^Branch:.*switch branch$/ })
      const menu = page.getByRole("dialog", { name: "Branches of this chat" })
      const branchTarget = (await branch.elementHandle())!
      await measure("openBranchMenu", async () => {
        await branchTarget.click()
        await menu.locator("[data-branch-row]").first().waitFor()
      })
      // Current branch starts at the end of a long list and remains reachable there.
      await expect(menu.locator("[aria-current]")).toBeInViewport()
      const renderedBranches = await menu.locator("[data-branch-row]").count()
      const switchTarget = (await menu.getByRole("link", { name: /^Branch 002/ }).elementHandle())!
      await measure("switchBranch", async () => {
        await switchTarget.click()
        await menu.waitFor({ state: "hidden" })
        await page.waitForURL((url) => url.searchParams.get("fork") === `${chats[0]!.id}-f2`)
        await page.locator("[data-frame] article").filter({ hasText: "Branch 2, version 1." }).waitFor()
      })
      const article = (await page.locator("[data-frame] article").first().elementHandle())!
      await measure("scrollTimeline", async () => {
        await article.hover()
        await page.mouse.wheel(0, -1800)
      })
      const branches = page.getByRole("button", { name: /^Branches of Scale voyage/ }).first()
      if ((await branches.getAttribute("aria-expanded")) === "true") await branches.click()
      const sidebarTarget = (await branches.elementHandle())!
      await measure("openSidebarBranches", async () => {
        await sidebarTarget.click()
      })
      await chat("Second voyage").dblclick()
      await chat("Scale voyage").dblclick()
      await chat("Second voyage").click()
      await idle()
      const tabTarget = (await page
        .getByRole("tab", { name: /Scale voyage/ })
        .first()
        .elementHandle())!
      await measure("switchWorkbenchTab", async () => {
        await tabTarget.click()
        await page.locator("[data-frame] article").first().waitFor()
      })
      writeFileSync(
        join(work!, `${label}.json`),
        JSON.stringify({ at: new Date().toISOString(), load: loadavg(), renderedBranches, samples, errors }, null, 2)
      )
      console.log(JSON.stringify({ label, renderedBranches, samples, errors }))
      expect(errors).toEqual([])
      expect(renderedBranches).toBeLessThan(40)
      if (process.env.CLIENT_SCALE_LAYOUT) {
        await page.locator("[data-frame] article").last().hover()
        await page.waitForTimeout(150)
        await expectLayout(page, test.info(), "scale-message-toolbar", {
          scope: '[role="toolbar"][aria-label="Message actions"]'
        })
      }

      // Windowing must preserve navigation, focus and the folded sidebar's position.
      await branch.click()
      const selected = menu.locator("[aria-current]")
      await expect(selected).toBeInViewport()
      if (process.env.CLIENT_SCALE_LAYOUT) {
        await page.mouse.move(0, 0)
        await expectLayout(page, test.info(), "scale-branch-menu", { scope: '[role="dialog"]' })
      }
      await selected.focus()
      const menuScroll = menu.locator("[data-branch-scroll]")
      await menuScroll.evaluate((element) => {
        element.scrollTop = 0
      })
      await expect(menu.getByRole("link", { name: /^Branch 499/ })).toBeInViewport()
      await expect(selected).toBeFocused()
      expect(await menu.locator("[data-branch-row]").count()).toBeLessThan(40)
      await page.keyboard.press("Escape")
      const foot = page.locator('[data-foot-section="branch"] [data-foot-body]')
      await foot.evaluate((element) => {
        element.scrollTop = 1200
      })
      await expect.poll(() => foot.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000)
      const offset = await foot.evaluate((element) => element.scrollTop)
      await branches.click()
      await expect(foot.locator("[data-fork-row]")).toHaveCount(0)
      await branches.click()
      await expect
        .poll(() => foot.evaluate((element, saved) => Math.abs(element.scrollTop - saved), offset))
        .toBeLessThan(2)
      if (process.env.CLIENT_SCALE_LAYOUT) {
        await page.mouse.move(0, 0)
        await expectLayout(page, test.info(), "scale-sidebar-branches", { scope: '[data-foot-section="branch"]' })
      }
      for (const sample of samples) expect.soft(sample.taskMs, sample.action).toBeLessThan(300)
    } finally {
      await page.close()
    }
  } finally {
    await server.stop()
  }
})
