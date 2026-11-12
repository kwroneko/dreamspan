// Browsing a card source (spec/CARD-SOURCES.md phase 2) against the fake archive, which holds
// synthetic cards only: nothing reaches it until the cardex option is opened; then the search,
// the source's sorts, the generated Filters panel and its chips, pages as the grid scrolls, a
// card's page and the recently viewed row, an error with Retry, on home and in the side panel.
// The user's own cards never show among the results. Phase 3: a click opens the card's draft
// chat, whose first send adds it; Inspect's page adds one without a chat; an edit in the draft
// chat's character tab, saved, adds one too; each shows as held.
import { createServer } from "node:net"
import { expect, test, type Page } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { hideAppNavigation, showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { UNSAVED, expectSaveState, saveRevision } from "./support/saveRevision.ts"
import { Effect } from "effect"

// Each test walks home and the side panel at one width and theme; a loaded machine needs the room.
test.setTimeout(480_000)

/** A free loopback port for the fake archive, so the test can ask it what it was sent. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

const archive = (port: number) => ({
  hits: async () => ((await (await fetch(`http://127.0.0.1:${port}/__fake/hits`)).json()) as { hits: number }).hits,
  fail: (status: number, times = 1, path = "") =>
    fetch(`http://127.0.0.1:${port}/__fake/fail?status=${status}&times=${times}${path ? `&path=${path}` : ""}`)
})

const tiles = (scope: ReturnType<Page["locator"]>) => scope.locator("[data-remote-card]")

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: cardex on home and in the side panel`, async ({ page }, info) => {
      const port = await freePort()
      const fake = archive(port)
      const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
      try {
        await asUser(server, ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: "Ava Local", name: "Ava" }))
        const labels = async () =>
          (
            await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
              api.ListLibrary({ kind: "card", archived: false })
            )
          )
            .map((c) => c.label)
            .sort()
        const before = await labels()
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(server.url)
        const main = page.getByRole("main")
        const show = main.getByRole("group", { name: "Show", exact: true })
        await expect(show.getByRole("button", { name: "cardex", exact: true })).toBeVisible()
        // Consent (§5.1): home, the side panel's characters and Settings send nothing.
        await showAppNavigation(page)
        await page
          .getByRole("group", { name: "Left panel", exact: true })
          .filter({ visible: true })
          .getByRole("button", { name: "Characters", exact: true })
          .click()
        await hideAppNavigation(page)
        await page.goto(`${server.url}/settings/card-sources`)
        await expect(page.getByText("Show cardex", { exact: true })).toBeVisible()
        await page.goto(server.url)
        await expect(show.getByRole("button", { name: "cardex", exact: true })).toBeVisible()
        expect(await fake.hits()).toBe(0)

        // Open it: the source's cards only, never the user's.
        await show.getByRole("button", { name: "cardex", exact: true }).click()
        await expect(page).toHaveURL(/show=src\.cardex/)
        await expect(tiles(main).first()).toBeVisible()
        expect(await fake.hits()).toBeGreaterThan(0)
        await expect(main.getByRole("link", { name: "Open Ava Local", exact: true })).toHaveCount(0)
        // Browsing adds nothing: the library holds what it held.
        expect(await labels()).toEqual(before)
        await expect(main.getByRole("button", { name: "Include personas", exact: true })).toBeDisabled()
        // Its total shows on the option once open.
        await expect(show.getByRole("button", { name: "cardex", exact: true })).toContainText(/\d/)
        const first = await tiles(main).count()
        expect(first).toBe(48)
        // The next page comes as the end nears.
        await tiles(main).last().scrollIntoViewIfNeeded()
        await expect.poll(() => tiles(main).count()).toBeGreaterThan(first)

        // Search and the source's sorts.
        const search = main.getByRole("searchbox", { name: "Search cardex", exact: true })
        await search.fill("lantern")
        await expect.poll(async () => (await tiles(main).allInnerTexts()).every((t) => /lantern/i.test(t))).toBe(true)
        await expect(page).toHaveURL(/sq=lantern/)
        await main.getByRole("group", { name: "Sort by", exact: true }).getByRole("button", { name: "Name" }).click()
        await expect(page).toHaveURL(/ssort=name/)
        await search.fill("")

        // Filters: the panel below the controls, chips for what's set, Clear filters.
        const filters = main.getByRole("button", { name: /^Filters/ })
        await filters.click()
        await expect(filters).toHaveAttribute("aria-pressed", "true")
        const panel = main.getByRole("region", { name: "cardex filters", exact: true })
        await expect(panel).toBeVisible()
        await panel.getByRole("switch", { name: "Leave out forks" }).click()
        const chips = main.getByLabel("Filters set", { exact: true })
        await expect(chips.getByText("Leave out forks", { exact: true })).toBeVisible()
        await panel.getByRole("textbox", { name: "Tags", exact: true }).fill("mystery")
        await panel.getByRole("textbox", { name: "Tags", exact: true }).press("Enter")
        await expect(chips.getByText("+mystery", { exact: true })).toBeVisible()
        await expect(page).toHaveURL(/stags=/)
        await expectLayout(page, info, `home-cardex-filters-${width}-${theme}`, { scope: "main" })
        await main.screenshot({ path: info.outputPath("home-filters.png") })
        await chips.getByRole("button", { name: "Clear filters", exact: true }).click()
        await expect(chips).toHaveCount(0)
        await panel.getByRole("button", { name: "Close", exact: true }).click()
        await expect(panel).toHaveCount(0)
        await expect(filters).toHaveAttribute("aria-pressed", "false")

        // An error says what the user can do, and Retry asks again.
        // Pictures are in by now, so the failure meets the search.
        await page.waitForLoadState("networkidle")
        // Both the requested order and its one substitute fail; Retry remains available.
        await fake.fail(503, 2, "/api/v1/search")
        await search.fill("amber")
        await expect(main.getByText("Can't reach cardex right now.", { exact: true })).toBeVisible()
        await main.getByRole("button", { name: "Retry", exact: true }).click()
        await expect(tiles(main).first()).toBeVisible()
        await search.fill("")
        await expect(tiles(main)).toHaveCount(48)
        await expectLayout(page, info, `home-cardex-${width}-${theme}`, { scope: "main" })
        await main.screenshot({ path: info.outputPath("home.png") })

        // A click opens the card's draft chat: the pending chat, saying where the card is from.
        const tried = (await tiles(main).first().getByRole("link").getAttribute("aria-label"))!.replace(/^Open /, "")
        await tiles(main).first().getByRole("link").click()
        await expect(page).toHaveURL(/\/sources\/cardex\/cards\/[^/]+\/chat/)
        await expect(page.locator("[data-remote-source]").getByText("cardex", { exact: true })).toBeVisible()
        await expect(main.getByText("looks up from a stack of notes", { exact: false }).first()).toBeVisible()
        expect(await labels()).toEqual(before)
        await expectLayout(page, info, `remote-chat-${width}-${theme}`, { scope: "main" })
        await page.screenshot({ path: info.outputPath("draft-chat.png") })
        // The first send adds the card, and the chat is saved with it.
        await page.getByTestId("composer").fill("Hello there")
        await page.getByRole("button", { name: "Send", exact: true }).click()
        await expect(page).toHaveURL(/\/chats\//)
        await expect(page.getByText(`Added ${tried} to your cards.`, { exact: true })).toBeVisible()
        expect(await labels()).toEqual([...before, tried].sort())
        await page.goBack()
        await expect(tiles(main).first()).toHaveAttribute("data-held", "true")
        await expect(tiles(main).first().getByLabel("You have this card", { exact: true })).toBeVisible()

        // Inspect: a card's page, where Add to my cards adds it without a chat.
        const second = tiles(main).nth(1)
        const name = (await second.getByRole("link").getAttribute("aria-label"))!.replace(/^Open /, "")
        await second.getByRole("link").click({ button: "right" })
        await page.getByRole("menuitem", { name: "Inspect", exact: true }).click()
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
        await expect(page.getByText("On cardex. It isn't in your cards.", { exact: true })).toBeVisible()
        await expect(page.getByRole("heading", { name: "Description · 40 tokens", exact: true })).toBeVisible()
        await expect(
          page.getByRole("link", { name: "Earlier listing on Synthetic site", exact: true })
        ).toHaveAttribute("href", /\/o\//)
        await expect(page.getByRole("link", { name: "Start a chat", exact: true })).toBeVisible()
        await page.getByRole("button", { name: "Add to my cards", exact: true }).click()
        await expect(page.getByText(`Added ${name} to your cards.`, { exact: true })).toBeVisible()
        await expect(page.getByText("On cardex. You have it in your cards.", { exact: true })).toBeVisible()
        await expect(page.getByRole("link", { name: "Open your card", exact: true })).toBeVisible()
        expect(await labels()).toEqual([...before, tried, name].sort())
        await expectLayout(page, info, `remote-card-${width}-${theme}`, { scope: "main" })
        await page.screenshot({ path: info.outputPath("card-added.png") })
        await page.goBack()
        await expect(tiles(main).nth(1)).toHaveAttribute("data-held", "true")
        const recent = main.locator("[data-source-recent]")
        await expect(recent).toContainText("Recently viewed on cardex")
        await recent.locator("summary").click()
        await expect(recent.getByRole("link").filter({ hasText: name })).toBeVisible()

        // The draft chat's character tab is the card editor on the source's copy: a change is
        // kept as a draft, and Save adds the card with it as its revision 2.
        const third = tiles(main).nth(2).getByRole("link")
        const edited = (await third.getAttribute("aria-label"))!.replace(/^Open /, "")
        await third.click()
        await expect(page).toHaveURL(/\/sources\/cardex\/cards\/[^/]+\/chat/)
        // The header's portrait opens the card's tab; a phone's header leaves it to the panel's link.
        if (width === 1440) await page.getByRole("button", { name: `Show ${edited}'s card`, exact: true }).click()
        else
          await page.goto(
            `${page.url().split("?")[0]}?panel=${encodeURIComponent(`card:src:cardex:${/\/cards\/([^/]+)\/chat/.exec(page.url())![1]}`)}`
          )
        await expect(page).toHaveURL(/panel=card(:|%3A)src/)
        const tab = page.getByRole("tabpanel", { name: edited, exact: true })
        await expect(tab.getByText("From cardex · not in your cards", { exact: true })).toBeVisible({
          timeout: 30_000
        })
        const description = tab.getByRole("textbox", { name: "Description", exact: true })
        await expect(description).toBeVisible()
        await description.click()
        await page.keyboard.press("Control+End")
        await page.keyboard.type(" Edited before adding.")
        await expectSaveState(tab, UNSAVED)
        await expect(tab.getByRole("button", { name: /^Export/ })).toBeDisabled()
        // Nothing that needs a saved card complains: there's nothing to merge yet.
        await expect(tab.getByText(/^Couldn.t/)).toHaveCount(0)
        expect(await labels()).toEqual([...before, tried, name].sort())
        await expectLayout(page, info, `remote-edit-${width}-${theme}`, { scope: "[role=tabpanel]" })
        await page.screenshot({ path: info.outputPath("remote-edit.png") })
        await saveRevision(tab)
        await expect(page.getByText(`Added ${edited} to your cards.`, { exact: true })).toBeVisible()
        // The tab goes on with the user's card; the chat is still a draft.
        await expect(tab.getByText("From cardex · not in your cards", { exact: true })).toHaveCount(0)
        await expect(page).toHaveURL(/panel=card(:|%3A)(?!src)/)
        await expect(page).toHaveURL(/\/sources\/cardex\/cards\/[^/]+\/chat/)
        await expect(tab.getByRole("textbox", { name: "Description", exact: true })).toContainText(
          "Edited before adding."
        )
        expect(await labels()).toEqual([...before, tried, name, edited].sort())
        const own = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const ref = (yield* api.ListLibrary({ kind: "card", archived: false })).find((c) => c.label === edited)!
            return yield* api.OpenEditor({ refId: ref.id })
          })
        )
        expect(own.revisionNumber).toBe(2)
        expect((own.doc as { description?: string }).description).toContain("Edited before adding.")
        await page.goto(server.url)
        await show.getByRole("button", { name: "cardex", exact: true }).click()
        await main.getByRole("searchbox", { name: "Search cardex", exact: true }).fill(edited)
        await expect(
          tiles(main).filter({ has: page.getByRole("link", { name: `Open ${edited}`, exact: true }) })
        ).toHaveAttribute("data-held", "true")
        await main.getByRole("searchbox", { name: "Search cardex", exact: true }).fill("")

        // The side panel's Show offers it too, after a separator, and lists its cards.
        await showAppNavigation(page)
        // Characters is usually still chosen from the consent check.
        const characters = page
          .getByRole("group", { name: "Left panel", exact: true })
          .filter({ visible: true })
          .getByRole("button", { name: "Characters", exact: true })
        if ((await characters.getAttribute("aria-pressed")) !== "true") await characters.click()
        const selector = page.getByRole("combobox", { name: "Show", exact: true }).filter({ visible: true })
        await selector.click()
        await page.getByRole("option", { name: /^cardex/ }).click()
        await expect(page).toHaveURL(/sideShow=src\.cardex/)
        const list = page.locator("[data-shell-list]").filter({ visible: true })
        await expect(tiles(list).first()).toBeVisible()
        await expect(list.getByRole("link", { name: "Open Ava Local", exact: true })).toHaveCount(0)
        await expectLayout(page, info, `sidebar-cardex-${width}-${theme}`, { scope: "[data-shell-list]" })
        await list.screenshot({ path: info.outputPath("sidebar.png") })
        await hideAppNavigation(page)
      } finally {
        await server.stop()
      }
    })
  }

test("Settings → Card sources: the switch hides the option and nothing is sent", async ({ page }) => {
  const port = await freePort()
  const fake = archive(port)
  const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
  try {
    // A card of the user's own, so home shows its grid and Show rather than the first-run intro.
    await asUser(server, ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: "Ava Local", name: "Ava" }))
    await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
    await page.goto(`${server.url}/settings/card-sources`)
    const card = page.locator('[data-card-source="cardex"]')
    await card.getByRole("switch", { name: "Show cardex" }).click()
    await expect(card.getByRole("switch", { name: "Show cardex" })).not.toBeChecked()
    await page.goto(`${server.url}/?show=src.cardex`)
    const show = page.getByRole("main").getByRole("group", { name: "Show", exact: true })
    await expect(show.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(show.getByRole("button", { name: "cardex", exact: true })).toHaveCount(0)
    // The admin's switch turns it off for everyone; the user's stays in place, disabled.
    await page.goto(`${server.url}/settings/card-sources`)
    await card.getByRole("switch", { name: "Show cardex" }).click()
    await card.getByRole("switch", { name: "Allow cardex on this server" }).click()
    await expect(card.getByRole("switch", { name: "Show cardex" })).toBeDisabled()
    await expect(card.getByText("An admin turned cardex off for this server.")).toBeVisible()
    expect(await fake.hits()).toBe(0)
  } finally {
    await server.stop()
  }
})
