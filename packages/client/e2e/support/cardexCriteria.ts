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
            await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
            await page.goto(server.url)
            // A fresh account must be able to discover cardex without first importing a card.
            const home = page.getByRole("main")
            await expect(home.getByRole("button", { name: "cardex", exact: true })).toBeVisible()
            expect(
              ((await (await fetch(`http://127.0.0.1:${port}/__fake/hits`)).json()) as { hits: number }).hits
            ).toBe(0)
            await fetch(`http://127.0.0.1:${port}/__fake/count-cap?value=50`)
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
            if (place === "home")
              await expect(scope.getByRole("button", { name: "cardex", exact: true })).toContainText("50+")
            else
              await expect(
                page.getByRole("combobox", { name: "Show", exact: true }).filter({ visible: true })
              ).toContainText("50+")
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
            // A long list of choices (every site) is the existing picker, with its search.
            const pick = async (label: string, option: string) => {
              await panel.getByRole("combobox", { name: label, exact: true }).click()
              const list = page.getByRole("dialog", { name: `Choose: ${label.toLowerCase()}`, exact: true })
              await list.getByPlaceholder("Search").fill(option)
              await list.getByRole("option", { name: option, exact: true }).click()
              await page.keyboard.press("Escape")
              await expect(list).toBeHidden()
            }
            for (const label of ["Site", "Exclude sites"]) {
              await pick(label, "Chub")
              await check(`${label}: Chub`)
            }
            // Each choice kind, including lists, has a chip and can be cleared again.
            for (const [group, option, chip] of [
              ["Rating", "Safe", "Rating: Safe"],
              ["Match", "Meaning", "Match: Meaning"],
              ["Search in", "Name", "Search in: Name"],
              ["Kind", "Characters with a lorebook", "Kind: Characters with a lorebook"],
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
              ["Picture", "a".repeat(64)]
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
            // Dates are date fields.
            for (const [label, value] of [
              ["Added after", "2026-01-01"],
              ["Added before", "2026-02-01"],
              ["Created after", "2025-01-01"],
              ["Created before", "2026-01-01"]
            ]) {
              const date = panel.getByLabel(label!, { exact: true })
              await expect(date).toHaveAttribute("type", "date")
              await date.fill(value!)
              await check(`${label}: ${value}`)
            }
            await panel.getByRole("spinbutton", { name: "Tokens: at least (tokens)", exact: true }).fill("100")
            await panel.getByRole("spinbutton", { name: "Tokens: at most (tokens)", exact: true }).fill("2000")
            await check("Tokens 100–2,000")
            for (const label of ["Leave out forks", "Deleted from all sites", "Deleted from a site"]) {
              await panel.getByRole("switch", { name: label, exact: true }).click()
              await check(label)
            }
            await expect(panel.getByRole("switch", { name: "Chub verified", exact: true })).toBeDisabled()
            await pick("Site", "Chub")
            await panel.getByRole("switch", { name: "Chub verified", exact: true }).click()
            await panel.getByRole("switch", { name: "Chub recommended", exact: true }).click()
            await expect(chips).toContainText("Chub verified")
            await expect(chips).toContainText("Chub recommended")
            // Changing to another site removes incompatible marks, rather than asking a refused query.
            await pick("Site", "RisuRealm")
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
            for (const label of ["Tags", "Site", "Picture", "Created before"]) {
              await panel.getByLabel(label, { exact: true }).first().scrollIntoViewIfNeeded()
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
            // URL state restores filters, text, sorting and direction in either surface.
            await filters.click()
            await panel
              .getByRole("group", { name: "Kind", exact: true })
              .getByRole("button", { name: "Characters with a lorebook", exact: true })
              .click()
            await panel.getByRole("button", { name: "Close", exact: true }).click()
            if (place === "home")
              await scope
                .getByRole("group", { name: "Sort by", exact: true })
                .getByRole("button", { name: "Name", exact: true })
                .click()
            else {
              await scope.getByRole("button", { name: /^Sort by:/ }).click()
              await page.getByRole("menuitemcheckbox", { name: "Name", exact: true }).click()
            }
            const search = scope.getByRole("searchbox", { name: "Search cardex", exact: true })
            await fetch(`http://127.0.0.1:${port}/__fake/fail?path=/api/v1/search&sort=name&status=500&times=1`)
            await search.fill("synthetic")
            await expect(
              scope.getByText("cardex couldn't use name order just now. Showing best matches.", {
                exact: true
              })
            ).toBeVisible()
            await expectLayout(page, info, `cardex-temporary-sort-${place}-${width}-${theme}`, {
              scope: place === "home" ? "main" : "[data-shell-list]"
            })
            const url = page.url()
            await page.reload()
            if (place === "sidebar" && width === 390) {
              await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
              await showAppNavigation(page)
            }
            await expect(page).toHaveURL(url)
            await expect(search).toHaveValue("synthetic")
            await expect(scope.locator("[data-remote-card]").first()).toBeVisible()
            await expect(
              scope.getByText("cardex couldn't use name order just now. Showing best matches.", { exact: true })
            ).toHaveCount(0)
            await expect(chips).toContainText("Kind: Characters with a lorebook")
            await expect(scope.getByRole("button", { name: "Order: A to Z", exact: true })).toBeVisible()
            await clear()
            await search.scrollIntoViewIfNeeded()
            const results = scope.locator("[data-source-results]")
            await expect(results).toHaveAttribute("aria-busy", "false")
            const cards = scope.locator("[data-remote-card]")
            const expected = (await (
              await fetch(
                `http://127.0.0.1:${port}/api/v1/search?q=synthetic&kind=both&nsfw=include&sort=name&limit=48`
              )
            ).json()) as { items: { slug: string }[] }
            const firstIds = expected.items.map((item) => item.slug)
            await expect
              .poll(() =>
                cards.evaluateAll((nodes) => nodes.slice(0, 48).map((node) => node.getAttribute("data-remote-card")))
              )
              .toEqual(firstIds)
            const firstPageHits = async () => {
              const hits = (await (await fetch(`http://127.0.0.1:${port}/__fake/hits`)).json()) as { paths: string[] }
              return hits.paths.filter(
                (path) =>
                  path.startsWith("/api/v1/search?") && path.includes("q=synthetic") && !path.includes("cursor=")
              ).length
            }
            const beforeReset = await firstPageHits()
            await fetch(`http://127.0.0.1:${port}/__fake/expire-cursors`)
            await cards.last().scrollIntoViewIfNeeded()
            await expect.poll(firstPageHits).toBeGreaterThan(beforeReset)
            await expect(results).toHaveAttribute("aria-busy", "false")
            const restored = await cards.evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute("data-remote-card"))
            )
            expect(restored.slice(0, 48)).toEqual(firstIds)
            expect(new Set(restored).size).toBe(restored.length)
            await expectLayout(page, info, `cardex-sort-${place}-${width}-${theme}`, {
              scope: place === "home" ? "main" : "[data-shell-list]"
            })
            // Every filter type survives one combined URL, reload, a second tab and history.
            const allFilters = {
              nsfw: "only",
              mode: "fts",
              tokens: { min: 100, max: 9000 },
              exclude_forks: true,
              source: ["chub"],
              author: "chub/fable_forge",
              fields: ["name", "character"],
              kind: "character_lorebook",
              not_source: ["risuai", "janitorai"],
              any_tags: "fantasy|magic,adventure|mystery",
              has_cover: "false",
              any_author: "chub/fable_forge,risuai/lumen",
              not_author: "chub/lumen,risuai/fable_forge",
              picture: "a".repeat(64),
              added_after: "2025-01-01",
              added_before: "2027-01-01",
              created_after: "2024-01-01",
              created_before: "2027-01-01",
              deleted_from_source: true,
              deleted_from_any_source: true,
              chub_verified: true,
              chub_recommended: true
            }
            const prefix = place === "home" ? "" : "side"
            const key = (name: string) => (prefix ? prefix + name[0]!.toUpperCase() + name.slice(1) : name)
            const revealSidebar = async (target: typeof page) => {
              if (place !== "sidebar" || width !== 390) return
              await expect(
                target
                  .getByRole("button", { name: /^(Chats and menu|Close the menu)$/ })
                  .filter({ visible: true })
                  .first()
              ).toBeVisible()
              await showAppNavigation(target)
            }
            const combined = new URL(page.url())
            combined.searchParams.set(key("sf"), JSON.stringify(allFilters))
            combined.searchParams.set(key("stags"), JSON.stringify(["magic"]))
            combined.searchParams.set(key("sxtags"), JSON.stringify(["horror"]))
            await page.goto(combined.href)
            await revealSidebar(page)
            const expectFilters = async (target: typeof page) => {
              await expect(target.locator('[aria-label="Filters set"]').filter({ visible: true })).toContainText(
                "Created before: 2027-01-01"
              )
              const restored = new URL(target.url())
              expect(JSON.parse(restored.searchParams.get(key("sf"))!)).toEqual(allFilters)
              expect(JSON.parse(restored.searchParams.get(key("stags"))!)).toEqual(["magic"])
              expect(JSON.parse(restored.searchParams.get(key("sxtags"))!)).toEqual(["horror"])
            }
            await expectFilters(page)
            await page.reload()
            await revealSidebar(page)
            await expectFilters(page)
            const tab = await page.context().newPage()
            await tab.setViewportSize({ width, height: 900 })
            await tab.goto(page.url())
            await revealSidebar(tab)
            await expectFilters(tab)
            await tab.close()
            await page.goBack()
            await expect(page).not.toHaveURL(combined.href)
            await page.goForward()
            await revealSidebar(page)
            await expectFilters(page)
          } finally {
            await server.stop()
          }
        })
      }
}
