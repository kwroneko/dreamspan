import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { seedCardArchive } from "./support/cardArchive.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { showAppNavigation, hideAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"

test.setTimeout(180_000)
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: archive, search, sidebar, bulk selection and Undo`, async ({ page }, info) => {
      const server = await startServer(withAdmin)
      try {
        await seedCardArchive(server)
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(server.url)
        const main = page.getByRole("main")
        const show = (name: string) =>
          main.getByRole("group", { name: "Show", exact: true }).getByRole("button", { name, exact: true })
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toHaveCount(0)
        await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("Pilot 005")
        await main.getByRole("button", { name: "Archived (1)", exact: true }).click()
        await main.screenshot({ path: info.outputPath("archived-persona-search.png") })
        await expect(main.getByRole("link", { name: "Open Pilot 005 (persona)", exact: true })).toBeVisible()
        await expect(main.locator("[data-persona-badge]")).toHaveText("Persona")
        await main.getByRole("button", { name: "Archived (1)", exact: true }).click()
        await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("Pilot 001")
        await expect(main.getByRole("button", { name: "Archived (1)", exact: true })).toHaveAttribute(
          "aria-expanded",
          "false"
        )
        await main.getByRole("button", { name: "Archived (1)", exact: true }).click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("")
        await show("Archived").click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await expect(main.getByRole("link", { name: "Open Pilot 005 (persona)", exact: true })).toBeVisible()
        await expect(main.locator("[data-persona-badge]")).toHaveText("Persona")
        await expectLayout(page, info, `home-archive-${width}-${theme}`, { scope: "main" })
        await main.screenshot({ path: info.outputPath("home.png") })
        await main.getByRole("button", { name: "Unarchive Pilot 001", exact: true }).click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toHaveCount(0)
        await page
          .locator("[data-toast]")
          .filter({ hasText: "Pilot 001 unarchived" })
          .getByRole("button", { name: "Undo", exact: true })
          .click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await main.getByRole("button", { name: "Archive unused cards…", exact: true }).click()
        const dialog = page.getByRole("dialog", { name: "Archive unused cards", exact: true })
        await expect(dialog.getByRole("checkbox", { name: "Pilot 008", exact: true })).toBeChecked()
        await expect(dialog.getByRole("checkbox", { name: "Pilot 006", exact: true })).toHaveCount(0)
        await expect(dialog.getByRole("checkbox", { name: "Pilot 007", exact: true })).toHaveCount(0)
        await dialog.getByRole("checkbox", { name: "Pilot 008", exact: true }).click()
        await expectLayout(page, info, `archive-dialog-${width}-${theme}`, { scope: '[role="dialog"]' })
        await dialog.screenshot({ path: info.outputPath("dialog.png") })
        const before = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          api.ListArchiveCandidates({ criteria: { never: 30 } })
        )
        const n = before.length - 1
        await dialog.getByRole("button", { name: `Archive ${n} cards`, exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect
          .poll(() =>
            asUser(server, ADMIN.handle, ADMIN.password, (api) =>
              Effect.map(api.ListLibrary({ kind: "card", archived: true }), (cards) => cards.length)
            )
          )
          .toBe(n + 5)
        await page
          .locator("[data-toast]")
          .filter({ hasText: `${n} cards archived` })
          .getByRole("button", { name: "Undo", exact: true })
          .click()
        await expect
          .poll(() =>
            asUser(server, ADMIN.handle, ADMIN.password, (api) =>
              Effect.map(api.ListLibrary({ kind: "card", archived: true }), (cards) => cards.length)
            )
          )
          .toBe(5)
        await showAppNavigation(page)
        await page
          .getByRole("group", { name: "Left panel", exact: true })
          .filter({ visible: true })
          .getByRole("button", { name: "Characters", exact: true })
          .click()
        const selector = page.getByRole("combobox", { name: "Show", exact: true }).filter({ visible: true })
        await selector.click()
        await page.getByRole("option", { name: /Archived/ }).click()
        const list = page.locator("[data-shell-list]").filter({ visible: true })
        await expect(list.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await expect(list.getByRole("link", { name: "Open Pilot 005 (persona)", exact: true })).toHaveCount(1)
        await expect(list.locator("[data-persona-badge]")).toHaveText("Persona")
        await expectLayout(page, info, `sidebar-archive-${width}-${theme}`, { scope: "[data-shell-list]" })
        await list.screenshot({ path: info.outputPath("sidebar.png") })
        await page.getByLabel("Find a character", { exact: true }).filter({ visible: true }).fill("No such pilot")
        await expect(list.getByText("No characters here", { exact: true })).toBeVisible()
        const archiveUnused = list.getByRole("button", { name: "Archive unused cards…", exact: true })
        await expect(archiveUnused).toBeVisible()
        await archiveUnused.click()
        await expect(dialog).toBeVisible()
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
        await hideAppNavigation(page)
      } finally {
        await server.stop()
      }
    })
  }
