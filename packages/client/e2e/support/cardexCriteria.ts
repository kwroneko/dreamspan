// All public v1 card criteria in the generated filter bar: its panels, the options under the
// search, the tag field and the checkboxes, on a wide bar and in the narrow sheet. Synthetic archive only.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, startServer, withAdmin } from "./server.ts"
import { showAppNavigation } from "./appMenu.ts"
import { expectLayout } from "./layoutAudit.ts"
import { closePanel, closeSheet, filterControls, openPanel } from "./sourceFilters.ts"

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
            const chips = scope.getByRole("group", { name: "Active filters", exact: true })
            const chosen = chips.locator("[data-source-chip]:not([data-default])")
            const clear = async () => {
              await closeSheet(page)
              const all = chips.getByRole("button", { name: "Clear all", exact: true })
              if (await all.count()) await all.click()
              await expect(chosen).toHaveCount(0)
            }
            const check = async (label: string) => {
              await closeSheet(page)
              await expect(chips).toContainText(label)
              await expect(scope.getByText("cardex sent something this app can't read.", { exact: true })).toHaveCount(
                0
              )
              await clear()
            }
            // Both pickers reach values beyond their first page. Tag suggestions show while the
            // tag field is in use.
            let controls = await filterControls(page, scope)
            const suggestedTags = controls.getByLabel("Suggested tags", { exact: true })
            await expect(suggestedTags).toHaveCount(0)
            await controls.getByRole("textbox", { name: "Tags", exact: true }).focus()
            // More load as the list scrolls to its end (no More button).
            await expect(suggestedTags.getByRole("listitem").first()).toBeVisible()
            // To the list's end, as a user scrolls: the last row in view can leave the sentinel under it just out.
            await suggestedTags.evaluate((list) => {
              let scroller = list.parentElement
              while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
                scroller = scroller.parentElement
              scroller?.scrollTo({ top: scroller.scrollHeight })
            })
            await expect.poll(() => suggestedTags.getByRole("listitem").count()).toBeGreaterThanOrEqual(20)
            // Escape closes the list (and only the list).
            await controls.getByRole("textbox", { name: "Tags", exact: true }).press("Escape")
            await expect(suggestedTags).toHaveCount(0)
            await expect(controls).toBeVisible()
            await closeSheet(page)
            let panel = await openPanel(page, scope, "Creators")
            await panel.getByRole("searchbox", { name: "Add a creator", exact: true }).fill("/")
            const creatorList = panel.getByRole("list", { name: "Creators", exact: true })
            // More load as the list scrolls to its end.
            const rows = creatorList.getByRole("button")
            await expect(rows.first()).toBeVisible()
            const firstPage = await rows.count()
            await rows.last().scrollIntoViewIfNeeded()
            await expect.poll(() => rows.count()).toBeGreaterThan(firstPage)
            // Two chosen are by any of them; Not by any of turns the same two into those left out.
            await rows.nth(0).click()
            await rows.nth(1).click()
            await expect(
              panel.getByRole("list", { name: "Chosen creators", exact: true }).getByRole("listitem")
            ).toHaveCount(2)
            await panel.getByRole("button", { name: "Not by any of", exact: true }).click()
            await closePanel(page, "Creators")
            await expect(chips.locator("[data-source-chip]").filter({ hasText: /^Not by / })).toHaveCount(2)
            await clear()
            // Sites: included, or left out.
            const pickSite = async (mode: "Include" | "Exclude", site: string) => {
              const sites = await openPanel(page, scope, "Sites")
              await sites.getByRole("button", { name: mode, exact: true }).click()
              await sites.getByRole("checkbox", { name: site, exact: true }).click()
              await closePanel(page, "Sites")
            }
            await pickSite("Include", "Chub")
            await check("Chub")
            await pickSite("Exclude", "Chub")
            await check("Not Chub")
            // Each single choice has a chip and can be cleared again.
            for (const [title, option, chip] of [
              ["Rating", "Hide NSFW", "Hide NSFW"],
              ["Kind", "Characters with a lorebook", "Kind: Characters with a lorebook"]
            ]) {
              panel = await openPanel(page, scope, title!)
              await panel.getByRole("radio", { name: option!, exact: true }).click()
              await closePanel(page, title!)
              await check(chip!)
            }
            // Under the search: Match, and the parts searched.
            await scope
              .getByRole("group", { name: "Match", exact: true })
              .getByRole("button", { name: "Meaning", exact: true })
              .click()
            await check("Match: Meaning")
            await scope.getByRole("button", { name: "Search in: All text", exact: true }).click()
            const parts = page.getByRole("dialog", { name: "Search in", exact: true })
            await parts.getByRole("checkbox").first().click()
            await page.keyboard.press("Escape")
            await expect(parts).toHaveCount(0)
            await check("Search in: ")
            // The cover default: unticked, its chip goes and cards without one are included.
            controls = await filterControls(page, scope)
            await controls.getByRole("checkbox", { name: "Only cards with a cover", exact: true }).click()
            await closeSheet(page)
            await expect(chips).not.toContainText("without a cover")
            await expect(page).toHaveURL(/has_cover%22%3A%22false|has_cover":"false/)
            // Clear all puts it back to its default, ticked again.
            await chips.getByRole("button", { name: "Clear all", exact: true }).click()
            await expect(chips).toContainText("Cards without a cover hidden (default)")
            controls = await filterControls(page, scope)
            await expect(controls.getByRole("checkbox", { name: "Only cards with a cover", exact: true })).toBeChecked()
            await closeSheet(page)
            // Alternatives: "or" makes a tag an alternative to one required.
            controls = await filterControls(page, scope)
            const tagField = controls.getByRole("textbox", { name: "Tags", exact: true })
            await tagField.fill("fantasy")
            await tagField.press("Enter")
            await tagField.fill("ma")
            await controls
              .getByRole("button", { name: "Add tag magic as an alternative to fantasy", exact: true })
              .click()
            await tagField.press("Escape")
            await check("Any of fantasy or magic")
            // Dates are date fields.
            for (const [title, label, value, chip] of [
              ["Added", "Added after", "2026-01-01", "Added from 2026-01-01"],
              ["Added", "Added before", "2026-02-01", "Added until 2026-02-01"],
              ["Created", "Created after", "2025-01-01", "Created from 2025-01-01"],
              ["Created", "Created before", "2026-01-01", "Created until 2026-01-01"]
            ]) {
              panel = await openPanel(page, scope, title!)
              const date = panel.getByRole("textbox", { name: label!, exact: true })
              await expect(date).toHaveAttribute("type", "date")
              await date.fill(value!)
              await closePanel(page, title!)
              await check(chip!)
            }
            panel = await openPanel(page, scope, "Tokens")
            await panel.getByRole("spinbutton", { name: "Min tokens", exact: true }).fill("100")
            await panel.getByRole("spinbutton", { name: "Max tokens", exact: true }).fill("2000")
            await closePanel(page, "Tokens")
            await check("100–2,000 tokens")
            for (const label of ["Hide forks", "Deleted from all sites", "Deleted from a site"]) {
              controls = await filterControls(page, scope)
              await controls.getByRole("checkbox", { name: label, exact: true }).click()
              await check(label)
            }
            panel = await openPanel(page, scope, "Sites")
            await expect(panel.getByRole("checkbox", { name: "Chub verified", exact: true })).toBeDisabled()
            await closePanel(page, "Sites")
            await pickSite("Include", "Chub")
            panel = await openPanel(page, scope, "Sites")
            await panel.getByRole("checkbox", { name: "Chub verified", exact: true }).click()
            await panel.getByRole("checkbox", { name: "Chub recommended", exact: true }).click()
            await closePanel(page, "Sites")
            await expect(chips).toContainText("Chub verified")
            await expect(chips).toContainText("Chub recommended")
            // Another site too removes the marks, rather than asking a refused query.
            await pickSite("Include", "RisuRealm")
            await expect(chips).not.toContainText("Chub verified")
            await clear()
            // Enter requires a tag, a leading "-" leaves it out; a chip's click switches between the two.
            controls = await filterControls(page, scope)
            const tags = controls.getByRole("textbox", { name: "Tags", exact: true })
            await tags.fill("fantasy")
            await tags.press("Enter")
            await tags.fill("-horror")
            await tags.press("Enter")
            await tags.press("Escape")
            await closeSheet(page)
            await expect(chips.getByRole("button", { name: "Not horror", exact: true })).toBeVisible()
            await chips.getByRole("button", { name: "+fantasy", exact: true }).click()
            await expect(chips.getByRole("button", { name: "Not fantasy", exact: true })).toBeVisible()
            await chips.getByRole("button", { name: "Not fantasy", exact: true }).click()
            await expect(chips.getByRole("button", { name: "+fantasy", exact: true })).toBeVisible()
            await clear()
            // The sidebar's narrow bar (Show, sort, Filters) and its cards, with the sheet closed.
            const sidebarBar = ":has(> [data-shell-list])"
            // Audit the bar, and with a panel open: its popover, or the sheet that covers the page.
            for (const title of ["", "Sites", "Creators", "Tokens", "Created"]) {
              if (title) await openPanel(page, scope, title)
              const inSheet = await page.locator("[data-filter-sheet]").isVisible()
              await expectLayout(page, info, `cardex-panel-${place}-${title || "folded"}-${width}-${theme}`, {
                scope: inSheet ? "[data-filter-sheet]" : title ? "body" : place === "home" ? "main" : sidebarBar
              })
              if (title) await closePanel(page, title)
            }
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
            panel = await openPanel(page, scope, "Kind")
            await panel.getByRole("radio", { name: "Characters with a lorebook", exact: true }).click()
            await closePanel(page, "Kind")
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
              await expect(
                target.getByRole("group", { name: "Active filters", exact: true }).filter({ visible: true })
              ).toContainText("Created 2024-01-01 – 2027-01-01")
              const restored = new URL(target.url())
              expect(JSON.parse(restored.searchParams.get(key("sf"))!)).toEqual(allFilters)
              expect(JSON.parse(restored.searchParams.get(key("stags"))!)).toEqual(["magic"])
              expect(JSON.parse(restored.searchParams.get(key("sxtags"))!)).toEqual(["horror"])
            }
            await expectFilters(page)
            // Every chip at once, the long ones included, and the sidebar's bar with its count.
            await expectLayout(page, info, `cardex-all-chips-${place}-${width}-${theme}`, {
              scope: place === "home" ? "main" : sidebarBar
            })
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
