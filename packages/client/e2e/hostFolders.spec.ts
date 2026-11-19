// Host folders and commands without a sandbox for a server admin (spec/FILES-AND-ENVIRONMENT.md
// §3.7, track A6) in the browser: the working-folder popover's Folder on the server… row opens a
// browser of the folders HOST_FOLDERS allows, choosing one puts the chip on it with the server
// icon, and turning Run commands without a sandbox on asks first, then marks the chip "No
// sandbox". Light and dark at 1440 and 390, layout audit under LAYOUT_AUDIT=1. Synthetic folders
// only; no provider is called.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"

const audit = !!process.env.LAYOUT_AUDIT
const hostRoot = realpathSync(mkdtempSync(join(tmpdir(), "dreamspan-e2e-host-")))
const chip = (page: Page) => nextReply(page).getByRole("button", { name: /^Working folder: / })

test.describe("host folders", () => {
  const server = serverPerFile({ ...withAdmin, HOST_FOLDERS: hostRoot, ALLOW_UNSANDBOXED_COMMANDS: "1" })

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`an admin works in a folder on the server and turns the sandbox off at ${width} ${theme}`, async ({
        page
      }, info) => {
        test.setTimeout(120_000)
        const project = `project-${width}-${theme}`
        mkdirSync(join(hostRoot, project, "src"), { recursive: true })
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const workshop = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.CreateWorkshop({ title: `Host ${width} ${theme}` })
        )
        await page.goto(`${server().url}/chats/${workshop.id}`)
        await expect(page.getByTestId("composer")).toBeVisible()

        // Folder on the server…: the allowed folders, then the project.
        await chip(page).click()
        await page
          .getByRole("dialog", { name: "Working folder" })
          .getByRole("button", { name: "Folder on the server…" })
          .click()
        const dialog = page.getByRole("dialog", { name: "Folder on the server" })
        await dialog.getByRole("button", { name: hostRoot, exact: true }).click()
        await dialog.getByRole("button", { name: project, exact: true }).click()
        await expect(dialog.getByText(`Chosen: ${join(hostRoot, project)}`)).toBeVisible()
        if (audit) await expectLayout(page, info, `host-folder-dialog-${width}-${theme}`, { scope: '[role="dialog"]' })
        await dialog.getByRole("button", { name: "Use this folder" }).click()
        await expect(dialog).toBeHidden()
        await expect(chip(page)).toHaveAccessibleName(`Working folder: ${join(hostRoot, project)}`)
        await expect(chip(page).locator("[data-folder-host]")).toContainText(project)

        // Without a sandbox: asked first, then marked on the chip.
        await nextReply(page)
          .getByRole("button", { name: /^What the assistant may do: / })
          .click()
        const popover = page.getByRole("dialog", { name: "What the assistant may do" })
        const row = popover.locator('[data-capability="commands.unsandboxed"]')
        await expect(row).toContainText("Run commands without a sandbox")
        await row.getByRole("button", { name: "Allowed", exact: true }).click()
        const consent = page.getByRole("alertdialog")
        await expect(consent.getByText("Run commands without a sandbox?")).toBeVisible()
        await expect(consent.getByRole("button", { name: "Keep the sandbox" })).toBeVisible()
        // It says plainly that stopping may not end everything such a command started.
        await expect(consent).toContainText("may not end everything it started")
        if (audit) await expectLayout(page, info, `host-consent-${width}-${theme}`, { scope: '[role="alertdialog"]' })
        await consent.getByRole("button", { name: "Run without a sandbox" }).click()
        await expect(row.getByRole("button", { name: "Allowed", exact: true })).toHaveAttribute("aria-pressed", "true")
        await page.keyboard.press("Escape")
        await expect(chip(page)).toContainText("No sandbox")
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (audit) await expectLayout(page, info, `host-chip-${width}-${theme}`)
      })
})
