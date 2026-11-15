// Group forks (audit item 015): a card and its forks as one tile on the Characters page and in
// the left panel's grid, expanding to its members; off until chosen. Synthetic cards only.
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { hideAppNavigation, showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"

test.setTimeout(180_000)
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: fork families group into one tile that expands`, async ({ page }, info) => {
      const server = await startServer(withAdmin)
      try {
        const seed = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const mira = yield* api.CreateCard({ label: "Mira Lantern", name: "Mira Lantern" })
            const fork = (refId: typeof mira.id, name: string, characterVersion: string) =>
              api.ForkCard({ refId, name, nickname: "", characterVersion })
            const winter = yield* fork(mira.id, "Mira Lantern", "winter")
            const festival = yield* fork(winter.id, "Mira Lantern", "festival")
            const tomas = yield* api.CreateCard({ label: "Tomas Reed", name: "Tomas Reed" })
            yield* fork(tomas.id, "Tomas Reed", "older")
            // A small library: grouped, the left panel's grid is too short to scroll.
            yield* api.CreateCard({ label: "Solo Wren", name: "Solo Wren" })
            // The festival fork is the one used last: it stands for its family.
            yield* api.StartChat({
              cards: [festival.entityId],
              persona: null,
              greeting: 0,
              first: { _tag: "Send", content: "A synthetic festival evening.", speakerEntityId: null }
            })
            yield* api.SetCardFavourite({ entityId: winter.entityId, favourite: true })
            return { mira: mira.entityId, tomas: tomas.entityId }
          })
        )
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(server.url)
        const main = page.getByRole("main")
        const tiles = (within: Locator) => within.getByRole("link", { name: /^Open / })
        const group = (within: Locator) => within.getByRole("button", { name: "Group forks", exact: true })
        const shot = async (within: Locator, name: string, scope: string) => {
          await expectLayout(page, info, `${name}-${width}-${theme}`, { scope })
          await within.screenshot({ path: info.outputPath(`${name}-${width}-${theme}.png`) })
        }

        // Off until chosen: every card its own tile, as before.
        await expect(tiles(main)).toHaveCount(6)
        await expect(group(main)).toHaveAttribute("aria-pressed", "false")
        await expect(main.locator("[data-family-toggle]")).toHaveCount(0)
        await group(main).hover()
        await expect(
          page
            .locator('[data-layout-overlay="Tooltip floats above the page"]')
            .filter({ hasText: "a card and its forks as one tile" })
        ).toBeVisible()
        await shot(main, "home-flat", "main")

        // Grouped: one tile a family, with its count, by the member used last.
        await group(main).click()
        await expect(group(main)).toHaveAttribute("aria-pressed", "true")
        await expect(tiles(main)).toHaveCount(3)
        const miraToggle = main.getByRole("button", { name: "Mira Lantern: 3 cards in this family", exact: true })
        const tomasToggle = main.getByRole("button", { name: "Tomas Reed: 2 cards in this family", exact: true })
        await expect(miraToggle).toHaveText("3 cards")
        await expect(tomasToggle).toHaveText("2 cards")
        const miraHead = main.locator(`[data-family="${seed.mira}"][data-family-head="true"]`)
        await expect(miraHead).toContainText("1 chat")
        await miraToggle.hover()
        await expect(
          page
            .locator('[data-layout-overlay="Tooltip floats above the page"]')
            .filter({ hasText: "2 other cards of this family" })
        ).toBeVisible()
        await shot(main, "home-grouped", "main")

        // Expanded: its members follow it; the open family is in the URL and survives a reload.
        await miraToggle.click()
        await expect(miraToggle).toHaveAttribute("aria-expanded", "true")
        await expect(main.locator(`[data-family="${seed.mira}"]`)).toHaveCount(3)
        await expect(tiles(main)).toHaveCount(5)
        await expect(page).toHaveURL(new RegExp(`family=${seed.mira}`))
        await shot(main, "home-expanded", "main")
        await page.reload()
        await expect(main.locator(`[data-family="${seed.mira}"]`)).toHaveCount(3)
        await expect(group(main)).toHaveAttribute("aria-pressed", "true")

        // A member keeps its own star, and the app's own menu on its tile.
        await expect(
          main.getByRole("button", { name: "Remove Mira Lantern from favourites", exact: true })
        ).toHaveCount(1)
        await miraHead.getByRole("link", { name: "Open Mira Lantern", exact: true }).click({ button: "right" })
        await expect(page.getByRole("menu", { name: "Actions for Mira Lantern", exact: true })).toBeVisible()
        await page.keyboard.press("Escape")

        // A search lists each card it finds; a filter decides the members there are.
        const search = main.getByRole("searchbox", { name: "Search characters and groups" })
        await search.fill("winter")
        await expect(tiles(main)).toHaveCount(1)
        await expect(main.locator("[data-family-toggle]")).toHaveCount(0)
        await search.fill("Mira")
        await expect(tiles(main)).toHaveCount(3)
        await search.fill("")
        const show = (name: string) =>
          main.getByRole("group", { name: "Show", exact: true }).getByRole("button", { name, exact: true })
        await show("Favourites").click()
        await expect(tiles(main)).toHaveCount(1)
        await expect(main.locator("[data-family-toggle]")).toHaveCount(0)
        await show("All").click()
        await miraToggle.click()
        await expect(tiles(main)).toHaveCount(3)
        await expect(page).not.toHaveURL(/family=/)

        // The left panel's grid: the same choice, its own open family.
        await showAppNavigation(page)
        await page
          .getByRole("group", { name: "Left panel", exact: true })
          .filter({ visible: true })
          .getByRole("button", { name: "Characters", exact: true })
          .click()
        const list = page.locator("[data-shell-list]").filter({ visible: true })
        const side = list.locator("xpath=..").getByRole("button", { name: "Group forks", exact: true })
        await expect(tiles(list)).toHaveCount(3)
        await shot(list, "side-grouped", "[data-shell-list]")
        await list.getByRole("button", { name: "Tomas Reed: 2 cards in this family", exact: true }).click()
        await expect(list.locator(`[data-family="${seed.tomas}"]`)).toHaveCount(2)
        await expect(page).toHaveURL(new RegExp(`sideFamily=${seed.tomas}`))
        await shot(list, "side-expanded", "[data-shell-list]")
        // Back to every card on its own, here and on the page.
        await side.click()
        await expect(tiles(list)).toHaveCount(6)
        await expect(list.locator("[data-family-toggle]")).toHaveCount(0)
        await shot(list, "side-flat", "[data-shell-list]")
        await hideAppNavigation(page)
        if (width === 1440) await expect(tiles(main)).toHaveCount(6)
      } finally {
        await server.stop()
      }
    })
  }
