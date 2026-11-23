// The archive's filter bar on home (spec/CARD-SOURCES.md §3.2) against the fake archive, which
// holds synthetic cards only: the tag field first, a section per group of criteria (a popover on
// a wide bar, a folding row on a narrow one) that says what's chosen, the switches, More filters
// folded. Applying filters reaches the archive and shows as chips; a reload restores them from
// the URL; a section's Clear, a chip's Remove and Clear filters take them off again.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closeSection, openSection, sectionTrigger } from "./support/sourceFilters.ts"

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
      const filters = main.getByRole("button", { name: /^Filters/ })
      await filters.click()
      const panel = main.getByRole("region", { name: "cardex filters", exact: true })
      const chips = main.getByLabel("Filters set", { exact: true })

      // Folded: the tag field, the sections saying what's chosen, the switches; the rest under More filters.
      await expect(panel.getByRole("textbox", { name: "Tags", exact: true })).toBeVisible()
      for (const [label, summary] of [
        ["Sites", "Any"],
        ["Kind", "Any"],
        ["Rating", "Everything"],
        ["Tokens", "Any"],
        ["Creators", "Any"],
        ["Added", "Any"],
        ["Created", "Any"]
      ])
        await expect(sectionTrigger(panel, label!)).toHaveAccessibleName(`${label}: ${summary}`)
      await expect(panel.getByRole("switch", { name: "Leave out forks", exact: true })).toBeVisible()
      await expect(panel.getByRole("textbox", { name: "Picture", exact: true })).toHaveCount(0)
      await expect(panel.getByRole("button", { name: "More filters", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false"
      )
      await expect(chips).toHaveCount(0)
      await expectLayout(page, info, `cardex-filters-folded-${width}`, { scope: "main" })

      // Apply: a required tag, a left-out one, a kind, a date range, a token minimum, a switch.
      const tags = panel.getByRole("textbox", { name: "Tags", exact: true })
      await tags.fill("fantasy")
      await tags.press("Enter")
      await tags.fill("-horror")
      await tags.press("Enter")
      await expect(tags).toHaveValue("")
      const kind = await openSection(page, panel, "Kind")
      await kind
        .getByRole("group", { name: "Kind", exact: true })
        .getByRole("button", { name: "Characters", exact: true })
        .click()
      await closeSection(page, "Kind")
      const added = await openSection(page, panel, "Added")
      await added.getByLabel("Added after", { exact: true }).fill("2026-01-01")
      await added.getByLabel("Added before", { exact: true }).fill("2026-03-01")
      await expectLayout(page, info, `cardex-filters-section-${width}`, { scope: width === 1440 ? "body" : "main" })
      await closeSection(page, "Added")
      const tokens = await openSection(page, panel, "Tokens")
      await tokens.getByRole("spinbutton", { name: "Tokens: at least (tokens)", exact: true }).fill("100")
      await closeSection(page, "Tokens")
      await panel.getByRole("switch", { name: "Leave out forks", exact: true }).click()

      const applied = [
        "+fantasy",
        "−horror",
        "Kind: Characters",
        "Added: 2026-01-01 – 2026-03-01",
        "Tokens ≥ 100",
        "Leave out forks"
      ]
      for (const text of applied) await expect(chips).toContainText(text)
      await expect(sectionTrigger(panel, "Kind")).toHaveAccessibleName("Kind: Characters")
      await expect(sectionTrigger(panel, "Added")).toHaveAccessibleName("Added: 2026-01-01 – 2026-03-01")
      await expect(sectionTrigger(panel, "Tokens")).toHaveAccessibleName("Tokens: ≥ 100")
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

      // The URL is the state: a reload shows the same chips, sections and typed values.
      const url = page.url()
      await page.reload()
      await expect(page).toHaveURL(url)
      for (const text of applied) await expect(chips).toContainText(text)
      await filters.click()
      await expect(sectionTrigger(panel, "Added")).toHaveAccessibleName("Added: 2026-01-01 – 2026-03-01")
      const reopened = await openSection(page, panel, "Tokens")
      await expect(reopened.getByRole("spinbutton", { name: "Tokens: at least (tokens)", exact: true })).toHaveValue(
        "100"
      )
      await closeSection(page, "Tokens")

      // Clearing: a section's Clear, a chip's Remove, then Clear filters.
      const again = await openSection(page, panel, "Added")
      await again.getByRole("button", { name: "Clear added", exact: true }).click()
      await closeSection(page, "Added")
      await expect(chips).not.toContainText("Added:")
      await expect(sectionTrigger(panel, "Added")).toHaveAccessibleName("Added: Any")
      await chips
        .locator("[data-source-chip]")
        .filter({ hasText: "Kind: Characters" })
        .getByRole("button", { name: "Remove", exact: true })
        .click()
      await expect(chips).not.toContainText("Kind: Characters")
      await expect(chips).toContainText("+fantasy")
      await chips.getByRole("button", { name: "Clear filters", exact: true }).click()
      await expect(chips).toHaveCount(0)
      await expect(page).not.toHaveURL(/stags=|sxtags=/)
      await expect(sectionTrigger(panel, "Tokens")).toHaveAccessibleName("Tokens: Any")
      await expect(filters).toHaveAccessibleName("Filters")

      // On a narrow bar, Show results closes the filters to the cards.
      if (width === 390) {
        await panel.getByRole("button", { name: /^Show .*results$/ }).click()
        await expect(panel).toHaveCount(0)
      } else await expect(panel.getByRole("button", { name: /^Show .*results$/ })).toBeHidden()
    } finally {
      await server.stop()
    }
  })
