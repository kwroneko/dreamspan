// The workshop's working folder (spec/FILES-AND-ENVIRONMENT.md §2.2, track A1) in the browser: the
// folder chip in the next-reply strip starts at "All files", its popover picks a folder from the
// tree, the chip and the Files tab follow ("Working here"), a rename made elsewhere is found again
// by the chip, New folder here makes a folder and works there, and a new workshop with the same
// assistant starts in its last folder. Light and dark at 1440 and 390, layout audit under
// LAYOUT_AUDIT=1. Synthetic files only; no provider is called.
import { expect, test, type Page } from "@playwright/test"
import { FILES_ROUTES } from "@dreamspan/shared/files.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { filesOf } from "./support/files.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"

const audit = !!process.env.LAYOUT_AUDIT
const chip = (page: Page) => nextReply(page).getByRole("button", { name: /^Working folder: / })

test.describe("working folder", () => {
  const server = serverPerFile(withAdmin)

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`the folder chip picks, follows a rename and is remembered at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(120_000)
        const phone = width === 390
        await page.setViewportSize({ width, height: phone ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const files = filesOf(page.request, server().url)
        await files.clear()
        await files.put(`/files/thesis-${width}-${theme}/notes.md`, "Synthetic notes.")
        await files.put(`/files/site-${width}-${theme}/index.html`, "<p>Synthetic</p>")
        const thesis = `thesis-${width}-${theme}`
        const workshop = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.CreateWorkshop({ title: `Folder ${width} ${theme}` })
        )
        await page.goto(`${server().url}/chats/${workshop.id}`)
        await expect(page.getByTestId("composer")).toBeVisible()

        // At the top of Files to begin with.
        await expect(chip(page)).toHaveAccessibleName(/^Working folder: \/files\b/)
        await expect(chip(page)).toContainText("All files")
        await chip(page).click()
        const popover = page.getByRole("dialog", { name: "Working folder" })
        await expect(popover).toContainText("Commands start in /files")
        const tree = popover.getByRole("tree", { name: "Folders" })
        await expect(tree.getByRole("button", { name: thesis, exact: true })).toBeVisible()
        if (audit) await expectLayout(page, info, `folder-popover-${width}-${theme}`, { scope: '[role="dialog"]' })
        await tree.getByRole("button", { name: thesis, exact: true }).click()
        await expect(popover).toBeHidden()
        await expect(chip(page)).toContainText(thesis)
        await expect(chip(page)).toHaveAccessibleName(`Working folder: /files/${thesis}`)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (audit)
          await expectLayout(page, info, `folder-chip-${width}-${theme}`, { scope: '[data-testid="composer"]' })

        // The Files tab opens there and marks it.
        const panel = await openPanel(page, "Files")
        await expect(panel.getByText("Working here")).toBeVisible()
        await expect(panel.locator("[data-files-browser]")).toContainText("notes.md")
        if (phone) await page.keyboard.press("Escape")

        // Renamed elsewhere: the chip finds it again.
        const moved = await page.request.post(`${server().url}${FILES_ROUTES.move}`, {
          headers: { origin: server().url },
          data: { from: `/files/${thesis}`, to: `/files/paper-${width}-${theme}` }
        })
        expect(moved.ok()).toBe(true)
        await expect(chip(page)).toContainText(`paper-${width}-${theme}`)

        // New folder here: made inside the working folder, and worked in.
        await chip(page).click()
        await popover.getByRole("button", { name: "New folder here" }).click()
        await popover.getByLabel("Name of the new folder").fill("drafts")
        await popover.getByRole("button", { name: "Make folder" }).click()
        await expect(chip(page)).toHaveAccessibleName(`Working folder: /files/paper-${width}-${theme}/drafts`)
        expect(await files.has(`/files/paper-${width}-${theme}/drafts`)).toBe(true)

        // A new workshop with the same assistant starts in its last folder.
        const second = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.CreateWorkshop({ title: `Folder again ${width} ${theme}` })
        )
        await page.goto(`${server().url}/chats/${second.id}`)
        await expect(chip(page)).toHaveAccessibleName(`Working folder: /files/paper-${width}-${theme}/drafts`)
        await chip(page).click()
        await expect(popover.getByRole("button", { name: "Use the top of Files" })).toBeVisible()
        await popover.getByRole("button", { name: "Use the top of Files" }).click()
        await expect(chip(page)).toContainText("All files")
      })
})
