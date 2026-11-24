import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { gotoWithLayout } from "./support/workbench.ts"

const server = serverPerFile({ ...withAdmin, FAKE_CARD_SOURCE: "0" })
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.forEach(
      Array.from({ length: 56 }, (_, i) => `Scroll fixture ${i}`),
      (name) => api.CreateCard({ label: name, name }),
      { discard: true }
    )
  )
})

const tab = (page: Page) => page.locator("[data-workbench-tab]").first()
const scroller = (page: Page) => tab(page).locator("div[class*='scrollbar-gutter']").first()
const scrollTop = (page: Page) => scroller(page).evaluate((el) => el.scrollTop)

const open = async (page: Page, width: number, href: string) => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await gotoWithLayout(page, server().url, href, [0, "=~", "/settings"])
}

const back = async (page: Page, width: number) => {
  if (width === 390) await page.goBack()
  else await page.locator("[data-strip-history]").getByRole("button", { name: "Back", exact: true }).click()
}

for (const width of [1440, 390])
  test(`Library restores its saved scroll after Back at ${width}px`, async ({ page }) => {
    await open(page, width, "/library")
    const link = tab(page).getByRole("link", { name: "Scroll fixture 29", exact: true })
    await link.scrollIntoViewIfNeeded()
    await expect.poll(() => page.evaluate(() => window.history.state?.libraryBrowse)).toBe(true)
    const saved = await scrollTop(page)
    expect(saved).toBeGreaterThan(100)

    await link.click()
    await expect(page).toHaveURL(/\/cards\//)
    await expect(link).toHaveCount(0)
    await back(page, width)
    await expect(link).toBeVisible()
    await expect.poll(() => scrollTop(page)).toBe(saved)
  })

for (const width of [1440, 390])
  test(`Characters returns to the top after Back from a scrolled cardex at ${width}px`, async ({ page }) => {
    await open(page, width, "/")
    const local = tab(page).getByRole("link", { name: "Open Scroll fixture 55", exact: true })
    await expect(local).toBeVisible()
    expect(await scrollTop(page)).toBe(0)

    await tab(page).getByRole("button", { name: "cardex", exact: true }).click()
    await expect(tab(page).locator("[data-remote-card]").nth(8)).toBeVisible()
    await expect(tab(page).locator("[data-source-results]")).toHaveAttribute("aria-busy", "false")
    await scroller(page).evaluate((el) => (el.scrollTop = 750))
    expect(await scrollTop(page)).toBe(750)

    await back(page, width)
    await expect(local).toBeVisible()
    await expect.poll(() => scrollTop(page)).toBe(0)
  })
