// The archive's filter bar on home (spec/CARD-SOURCES.md §3.2) against the fake archive, which
// holds synthetic cards only, laid out as the archive's public search page: Search in and Match
// under the search; on a wide bar a button per panel that says what's chosen and the tag field,
// then the checkboxes; on a narrow one the Filters button's sheet. Applying filters reaches the
// archive and shows as chips beside the archive's own defaults; a reload restores them from the
// URL; a panel's Clear, a chip's Remove and Clear all take them off again.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, closeSheet, filterControls, openPanel, panelSummary } from "./support/sourceFilters.ts"

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

for (const width of [1440, 390])
  test(`${width}: the archive's filter bar applies, clears and round-trips the URL`, async ({ page }, info) => {
    test.setTimeout(240_000)
    const port = await freePort()
    const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
    const searches = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/__fake/hits`)).json()) as { paths: string[] }).paths.filter(
        (path) => path.startsWith("/api/v1/search?")
      )
    try {
      await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(server.url)
      const main = page.getByRole("main")
      await main.getByRole("button", { name: "cardex", exact: true }).click()
      await expect(main.locator("[data-remote-card]").first()).toBeVisible()
      const chips = main.getByRole("group", { name: "Active filters", exact: true })
      const chosen = chips.locator("[data-source-chip]:not([data-default])")

      // Under the search: which parts it looks in and how it matches. The archive's defaults are chips.
      await expect(main.getByRole("button", { name: "Search in: All text", exact: true })).toBeVisible()
      await expect(main.getByRole("group", { name: "Match", exact: true })).toBeVisible()
      await expect(chips).toContainText("Characters under 300 tokens hidden (default)")
      await expect(chips).toContainText("Cards without a cover hidden (default)")
      await expect(chosen).toHaveCount(0)
      const filters = main.getByRole("button", { name: /^Filters/ })
      if (width === 1440) {
        // Wide: every panel says what's chosen, always shown; no Filters button.
        await expect(filters).toBeHidden()
        for (const name of [
          "Creators: Any creator",
          "Sites: All sites",
          "Kind: All kinds",
          "Tokens: ≥ 300 tokens",
          "Added: any date",
          "Created: any date"
        ])
          await expect(main.locator("[data-filter-panels]").getByRole("button", { name, exact: true })).toBeVisible()
        await expect(
          main.locator("[data-filter-panels]").getByRole("button", { name: /^Rating: NSFW (hidden|included|only)$/ })
        ).toBeVisible()
        await expect(main.getByRole("checkbox", { name: "Only cards with a cover", exact: true })).toBeChecked()
      } else await expect(filters).toBeVisible()
      await expectLayout(page, info, `cardex-filters-folded-${width}`, { scope: "main" })

      // Apply: a required tag, a left-out one, a kind, a date range, a token minimum, a checkbox.
      let controls = await filterControls(page, main)
      const tags = controls.getByRole("textbox", { name: "Tags", exact: true })
      await tags.fill("fantasy")
      await tags.press("Enter")
      await tags.fill("-horror")
      await tags.press("Enter")
      await expect(tags).toHaveValue("")
      await tags.press("Escape")
      let panel = await openPanel(page, main, "Kind")
      await panel.getByRole("radio", { name: "Characters", exact: true }).click()
      await closePanel(page, "Kind")
      panel = await openPanel(page, main, "Added")
      await panel.getByRole("textbox", { name: "Added after", exact: true }).fill("2026-01-01")
      await panel.getByRole("textbox", { name: "Added before", exact: true }).fill("2026-03-01")
      await expectLayout(page, info, `cardex-filters-panel-${width}`, { scope: "body" })
      await closePanel(page, "Added")
      panel = await openPanel(page, main, "Tokens")
      await panel.getByRole("spinbutton", { name: "Min tokens", exact: true }).fill("100")
      await closePanel(page, "Tokens")
      controls = await filterControls(page, main)
      await controls.getByRole("checkbox", { name: "Hide forks", exact: true }).click()
      await closeSheet(page)

      const applied = [
        "+fantasy",
        "−horror",
        "Kind: Characters",
        "Added 2026-01-01 – 2026-03-01",
        "At least 100 tokens",
        "Hide forks"
      ]
      for (const text of applied) await expect(chips).toContainText(text)
      // A minimum of its own lifts the archive's; characters only still leave out those without a cover.
      await expect(chips).not.toContainText("tokens hidden")
      await expect(chips).toContainText("Cards without a cover hidden (default)")
      await expect(await panelSummary(page, main, "Kind")).toHaveAccessibleName("Kind: Characters")
      await expect(await panelSummary(page, main, "Tokens")).toHaveAccessibleName("Tokens: ≥ 100 tokens")
      await closeSheet(page)
      await expect
        .poll(async () =>
          (await searches()).some((path) =>
            [
              "tags=fantasy",
              "not_tags=horror",
              "kind=character&",
              "added_after=2026-01-01",
              "added_before=2026-03-01",
              "min_tokens=100",
              "exclude_forks=true"
            ].every((part) => `${path}&`.includes(part))
          )
        )
        .toBe(true)
      await expect(page).toHaveURL(/stags=/)
      await expect(page).toHaveURL(/sxtags=/)
      await expect(page).toHaveURL(/sf=/)
      await chips.scrollIntoViewIfNeeded()
      await expectLayout(page, info, `cardex-filters-applied-${width}`, { scope: "main" })

      // The URL is the state: a reload shows the same chips and typed values.
      const url = page.url()
      await page.reload()
      await expect(page).toHaveURL(url)
      for (const text of applied) await expect(chips).toContainText(text)
      panel = await openPanel(page, main, "Tokens")
      await expect(panel.getByRole("spinbutton", { name: "Min tokens", exact: true })).toHaveValue("100")
      await closePanel(page, "Tokens")

      // Clearing: a panel's Clear, a chip's Remove, then Clear all; the defaults come back.
      panel = await openPanel(page, main, "Added")
      await panel.getByRole("button", { name: "Clear the dates", exact: true }).click()
      await closePanel(page, "Added")
      await expect(chips).not.toContainText("Added")
      await chips
        .locator("[data-source-chip]")
        .filter({ hasText: "Kind: Characters" })
        .getByRole("button", { name: "Remove", exact: true })
        .click()
      await expect(chips).not.toContainText("Kind: Characters")
      await expect(chips).toContainText("+fantasy")
      await chips.getByRole("button", { name: "Clear all", exact: true }).click()
      await expect(chosen).toHaveCount(0)
      await expect(chips).toContainText("Characters under 300 tokens hidden (default)")
      await expect(page).not.toHaveURL(/stags=|sxtags=/)
      await expect(await panelSummary(page, main, "Tokens")).toHaveAccessibleName("Tokens: ≥ 300 tokens")

      // A default's chip removed includes those cards: the cover checkbox follows.
      await closeSheet(page)
      await chips
        .locator("[data-source-chip][data-default]")
        .filter({ hasText: "without a cover" })
        .getByRole("button")
        .last()
        .click()
      await expect(chips).not.toContainText("without a cover")
      controls = await filterControls(page, main)
      await expect(controls.getByRole("checkbox", { name: "Only cards with a cover", exact: true })).not.toBeChecked()
      // Clear all puts every filter back to its default: the box is ticked again, its chip back.
      await closeSheet(page)
      await chips.getByRole("button", { name: "Clear all", exact: true }).click()
      await expect(chips).toContainText("Cards without a cover hidden (default)")
      controls = await filterControls(page, main)
      await expect(controls.getByRole("checkbox", { name: "Only cards with a cover", exact: true })).toBeChecked()

      // On a narrow bar, Show results closes the sheet to the cards.
      if (width === 390) {
        await page.getByRole("button", { name: /^Show results/ }).click()
        await expect(page.locator("[data-filter-sheet]")).toHaveCount(0)
      }
    } finally {
      await server.stop()
    }
  })

// The search's own controls follow the box on its row, and the tag field ends the filter row,
// never alone on one, at every width the filter bar shows its panels (owner: they had wrapped
// under the box). Windows with the sidebar open: content widths 900 to 1600, and wider.
test("the search row and the filter row keep together at every width", async ({ page }) => {
  test.setTimeout(240_000)
  const port = await freePort()
  const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
  try {
    await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto(server.url)
    const main = page.getByRole("main")
    await main.getByRole("button", { name: "cardex", exact: true }).click()
    await expect(main.locator("[data-remote-card]").first()).toBeVisible()
    const box = main.getByRole("searchbox", { name: "Search cardex", exact: true })
    const within = main.getByRole("button", { name: "Search in: All text", exact: true })
    const panels = main.locator("[data-filter-panels]")
    const tag = panels.locator("input")
    const lastPanel = panels.locator(":scope > button").last()
    for (const width of [1024, 1252, 1352, 1452, 1602, 1752, 1952, 2560, 3840]) {
      await page.setViewportSize({ width, height: 900 })
      await expect
        .poll(
          async () => {
            const [b, i, t, l, row] = await Promise.all(
              [box, within, tag, lastPanel, panels].map((at) => at.boundingBox())
            )
            // The tag field takes the next line only when its 10rem don't fit after the last button.
            const room = row!.x + row!.width - (l!.x + l!.width + 8) >= 160
            return [Math.round(i!.y - b!.y), room ? Math.round(t!.y - l!.y) : 0]
          },
          { message: `window ${width}` }
        )
        .toEqual([0, 0])
    }
  } finally {
    await server.stop()
  }
})
