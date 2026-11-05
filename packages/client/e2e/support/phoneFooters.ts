import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, type TestInfo } from "@playwright/test"
import { showAppNavigation } from "./appMenu.ts"
import { expectLayout } from "./layoutAudit.ts"

export async function exercisePhoneFooters(page: Page, info: TestInfo, url: string, audit = false) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
  await showAppNavigation(page)
  const drawer = page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
  const branches = drawer.getByRole("region", { name: "Branches of the open chat", exact: true })
  const splits = drawer.getByRole("region", { name: "Related chats", exact: true })
  const branchToggle = branches.getByRole("button", { name: /^Branches of / })
  const splitToggle = splits.getByRole("button", { name: /^Related chats \(/ })
  await expect(branches).toHaveAttribute("aria-busy", "false")
  await expect(splits).toHaveAttribute("aria-busy", "false")
  for (const toggle of [branchToggle, splitToggle]) {
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(toggle).toBeEnabled()
  }
  const sizes = () =>
    page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage).filter(([key]) => /^rp\.(branchHeight|splitHeight)\./.test(key)))
    )
  const saved = await sizes()
  const measurements = []
  for (const [name, section, toggle, other] of [
    ["branches", branches, branchToggle, splitToggle],
    ["split-off", splits, splitToggle, branchToggle]
  ] as const) {
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(other).toHaveAttribute("aria-expanded", "false")
    const measure = () =>
      section.evaluate((el) => {
        const body = el.querySelector<HTMLElement>("[data-foot-body]")!
        const box = body.getBoundingClientRect()
        const list = el.closest("[data-sidebar-feet]")!.parentElement!.querySelector<HTMLElement>("[data-shell-list]")!
        const first = list.querySelector<HTMLElement>("[data-fork-row]")!
        return {
          section: el.getBoundingClientRect().height,
          visibleRows: [...body.querySelectorAll<HTMLElement>("[data-fork-row]")].filter((row) => {
            const r = row.getBoundingClientRect()
            return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
          }).length,
          chatsHeight: list.clientHeight,
          oneChatRow: first.getBoundingClientRect().bottom - list.getBoundingClientRect().top + list.scrollTop
        }
      })
    await expect.poll(async () => (await measure()).visibleRows).toBeGreaterThanOrEqual(1)
    const m = await measure()
    expect(m.chatsHeight).toBeGreaterThanOrEqual(m.oneChatRow - 1)
    expect(await sizes()).toEqual(saved)
    measurements.push({ name, ...m })
    if (audit) {
      await expectLayout(page, info, `phone-${name}-open`, { scope: "[data-shell-list], [data-sidebar-feet]" })
      const full = join(process.env.LAYOUT_AUDIT_WORK ?? info.outputDir, "full")
      mkdirSync(full, { recursive: true })
      await drawer.screenshot({ path: join(full, `${name}-open-390x844-dark.png`) })
      writeFileSync(join(full, "phone-open-measurements.json"), JSON.stringify(measurements, null, 2))
    }
  }
  // Clicking the open header closes it, and both sections remain usable afterward.
  await splitToggle.click()
  await expect(splitToggle).toHaveAttribute("aria-expanded", "false")
  await branchToggle.click()
  await expect(branchToggle).toHaveAttribute("aria-expanded", "true")
  await branchToggle.click()
  await expect(branchToggle).toHaveAttribute("aria-expanded", "false")
  expect(await sizes()).toEqual(saved)
}
