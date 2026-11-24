// Archive unused cards… centres on the centre column it was opened from, not the window (owner:
// "The archive unused cards modal opens in the center of the viewport instead of being centered
// on the centre column of our layout"), and follows the column when the window resizes.
import { expect, test, type Page } from "@playwright/test"
import { seedCardArchive } from "./support/cardArchive.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

test.setTimeout(180_000)

const centres = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector("main#content")!.getBoundingClientRect()
    const dialog = document.querySelector('[role="dialog"]')!.getBoundingClientRect()
    return { main: main.left + main.width / 2, dialog: dialog.left + dialog.width / 2 }
  })

for (const [width, sidebar] of [
  [1340, true],
  [1920, true],
  [1920, false]
] as const)
  test(`${width} sidebar ${sidebar ? "open" : "closed"}: the archive dialog centres on the centre column`, async ({
    page
  }, info) => {
    const server = await startServer(withAdmin)
    try {
      await seedCardArchive(server)
      await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
      await page.goto(server.url)
      const main = page.getByRole("main")
      if (!sidebar) {
        await page.getByRole("button", { name: "Hide the sidebar", exact: true }).click()
        await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0)
      } else await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible()
      await main.getByRole("group", { name: "Show", exact: true }).getByRole("button", { name: "Archived" }).click()
      await main.getByRole("button", { name: "Archive unused cards…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Archive unused cards", exact: true })
      await expect(dialog.getByRole("checkbox", { name: "Pilot 008", exact: true })).toBeVisible()
      const at = await centres(page)
      if (sidebar) expect(Math.abs(at.main - width / 2)).toBeGreaterThan(50)
      expect(Math.abs(at.dialog - at.main)).toBeLessThanOrEqual(1)
      await expectLayout(page, info, `archive-dialog-column-${width}-${sidebar}`, { scope: '[role="dialog"]' })
      await page.screenshot({
        path: `/tmp/dreamspan-shots/dialogcenter1/${width}-dark-sidebar-${sidebar ? "open" : "closed"}.png`
      })
      // Live: a narrower window moves the centre column, and the dialog with it.
      await page.setViewportSize({ width: width - 200, height: 1000 })
      await expect.poll(async () => {
        const next = await centres(page)
        return Math.abs(next.dialog - next.main)
      }).toBeLessThanOrEqual(1)
    } finally {
      await server.stop()
    }
  })
