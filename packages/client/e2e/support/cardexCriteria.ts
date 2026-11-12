// All public v1 card criteria use the existing generic panel. Synthetic archive only.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, startServer, withAdmin } from "./server.ts"
import { showAppNavigation } from "./appMenu.ts"
import { expectLayout } from "./layoutAudit.ts"

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

export function cardexCriteriaTests() {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      for (const place of ["home", "sidebar"] as const) {
        test(`cardex criteria: ${place} ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(300_000)
          const port = await freePort()
          const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
          try {
            await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
            await page.setViewportSize({ width, height: 900 })
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
            await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
            await page.goto(server.url)
            // A fresh account must be able to discover cardex without first importing a card.
            const home = page.getByRole("main")
            await expect(home.getByRole("button", { name: "cardex", exact: true })).toBeVisible()
            expect(
              ((await (await fetch(`http://127.0.0.1:${port}/__fake/hits`)).json()) as { hits: number }).hits
            ).toBe(0)
            if (place === "home") await home.getByRole("button", { name: "cardex", exact: true }).click()
            else {
              await showAppNavigation(page)
              await page
                .getByRole("group", { name: "Left panel", exact: true })
                .filter({ visible: true })
                .getByRole("button", { name: "Characters", exact: true })
                .click()
              await page.getByRole("combobox", { name: "Show", exact: true }).filter({ visible: true }).click()
              await page.getByRole("option", { name: /^cardex/ }).click()
            }
            const scope =
              place === "home" ? home : page.locator("[data-shell-list]").filter({ visible: true }).locator("..")
            await expect(scope.locator("[data-remote-card]").first()).toBeVisible()
            const filters = scope.getByRole("button", { name: /^Filters/ })
            await filters.click()
            const panel = scope.getByRole("region", { name: "cardex filters", exact: true })
            const chips = scope.getByLabel("Filters set", { exact: true })
            const clear = async () => {
              if (await chips.count()) await chips.getByRole("button", { name: "Clear filters", exact: true }).click()
              await expect(chips).toHaveCount(0)
              await expect(filters).toHaveAccessibleName("Filters")
            }
            const check = async (label: string) => {
              await expect(chips).toContainText(label)
              await expect(scope.getByText("cardex sent something this app can't read.", { exact: true })).toHaveCount(
                0
              )
              await clear()
            }
            // Both existing picker fields can reach values beyond their first keyset page.
            const suggestedTags = panel.getByLabel("Suggested tags", { exact: true })
            await expect(suggestedTags.getByRole("button", { name: "More tags", exact: true })).toBeVisible()
            await suggestedTags.getByRole("button", { name: "More tags", exact: true }).click()
            await expect(suggestedTags.getByRole("button")).toHaveCount(21)
            const creator = panel.getByRole("textbox", { name: "Creator", exact: true })
            await creator.fill("/")
            const suggestedCreators = panel.getByLabel("Suggested creators", { exact: true }).first()
            await suggestedCreators.getByRole("button", { name: "More creators", exact: true }).click()
            await expect(suggestedCreators.getByRole("button")).toHaveCount(21)
            await suggestedCreators.getByRole("button").first().click()
            await expect(creator).toHaveValue(/^[a-z_]+\//)
            await clear()
            // Each choice kind, including lists, has a chip and can be cleared again.
            for (const [group, option, chip] of [
              ["Rating", "Safe", "Rating: Safe"],
              ["Match", "Meaning", "Match: Meaning"],
              ["Site", "Chub", "Site: Chub"],
              ["Search in", "Name", "Search in: Name"],
              ["Kind", "With a lorebook", "Kind: With a lorebook"],
              ["Exclude sites", "Chub", "Exclude sites: Chub"],
              ["Cover", "Any", "Cover: Any"]
            ]) {
              await panel
                .getByRole("group", { name: group!, exact: true })
                .getByRole("button", { name: option!, exact: true })
                .click()
              await check(chip!)
            }
            for (const [label, value] of [
              ["Creator", "chub/fable_forge"],
              ["Any of these creators", "chub/fable_forge,risuai/lumen"],
              ["Exclude creators", "chub/fable_forge"],
              ["Any of these tags", "fantasy|magic,adventure|mystery"],
              ["Picture", "a".repeat(64)],
              ["Added after", "2026-01-01"],
              ["Added before", "2026-02-01"],
              ["Created after", "2025-01-01"],
              ["Created before", "2026-01-01"]
            ]) {
              await panel.getByRole("textbox", { name: label!, exact: true }).fill(value!)
              await expect(chips).toContainText(label!)
              if (label === "Picture") {
                await chips.scrollIntoViewIfNeeded()
                await expectLayout(page, info, `cardex-long-chip-${place}-${width}-${theme}`, {
                  scope: place === "home" ? "main" : "[data-shell-list]"
                })
              }
              await clear()
            }
            await panel.getByRole("spinbutton", { name: "Tokens: at least (tokens)", exact: true }).fill("100")
            await panel.getByRole("spinbutton", { name: "Tokens: at most (tokens)", exact: true }).fill("2000")
            await check("Tokens 100–2,000")
            for (const label of ["Leave out forks", "Deleted from all sites", "Deleted from a site"]) {
              await panel.getByRole("switch", { name: label, exact: true }).click()
              await check(label)
            }
            await expect(panel.getByRole("switch", { name: "Chub verified", exact: true })).toBeDisabled()
            await panel
              .getByRole("group", { name: "Site", exact: true })
              .getByRole("button", { name: "Chub", exact: true })
              .click()
            await panel.getByRole("switch", { name: "Chub verified", exact: true }).click()
            await panel.getByRole("switch", { name: "Chub recommended", exact: true }).click()
            await expect(chips).toContainText("Chub verified")
            await expect(chips).toContainText("Chub recommended")
            // Changing to another site removes incompatible marks, rather than asking a refused query.
            await panel
              .getByRole("group", { name: "Site", exact: true })
              .getByRole("button", { name: "RisuRealm", exact: true })
              .click()
            await expect(chips).not.toContainText("Chub verified")
            await clear()
            const tags = panel.getByRole("textbox", { name: "Tags", exact: true })
            await tags.fill("fantasy")
            await tags.press("Enter")
            await chips.getByRole("button", { name: "+fantasy", exact: true }).click()
            await expect(chips).toContainText("Not fantasy")
            await chips.getByRole("button", { name: "Not fantasy", exact: true }).click()
            await expect(chips).toHaveCount(0)
            // Audit the expanded panel through its full height, also in the narrow sidebar.
            for (const label of ["Tags", "Picture", "Created before"]) {
              await panel.getByRole("textbox", { name: label, exact: true }).scrollIntoViewIfNeeded()
              await expectLayout(page, info, `cardex-panel-${place}-${label}-${width}-${theme}`, {
                scope: place === "home" ? "main" : "[data-shell-list]"
              })
            }
            await panel.getByRole("button", { name: "Close", exact: true }).click()
            // Every sort and every available direction remains reachable in both toolbars.
            for (const label of ["Popular", "Newest", "Created", "Name", "Tokens", "Best match"]) {
              if (place === "home")
                await scope
                  .getByRole("group", { name: "Sort by", exact: true })
                  .getByRole("button", { name: label, exact: true })
                  .click()
              else {
                await scope.getByRole("button", { name: /^Sort by:/ }).click()
                await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click()
              }
              const direction = scope.getByRole("button", { name: /^Order:/ })
              if (["Newest", "Created", "Name", "Tokens"].includes(label)) {
                await direction.click()
                await expect(page).toHaveURL(/(?:sreverse|sideSreverse)=true/)
              } else await expect(direction).toBeDisabled()
            }
            await expectLayout(page, info, `cardex-sort-${place}-${width}-${theme}`, {
              scope: place === "home" ? "main" : "[data-shell-list]"
            })
          } finally {
            await server.stop()
          }
        })
      }
}
