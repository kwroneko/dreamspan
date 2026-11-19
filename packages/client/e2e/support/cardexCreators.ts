// A creator's cards on cardex: from a result's menu or a card's page, the browsing view narrowed
// to them with their profile, kept by the URL (a reload and a second tab), every sort still
// there, and Not by this creator. Synthetic archive only.
import { createServer } from "node:net"
import { expect, type Locator, type Page, test } from "@playwright/test"
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

/** Every tile's "by <creator>" line. */
const creatorsOf = (scope: Locator) =>
  scope
    .locator("[data-remote-card] [data-remote-creator]")
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").replace(/^by /, "").trim()))

/**
 * The app's navigation, once the page has drawn its menu button: on a phone the side panel is in
 * the menu sheet, which `showAppNavigation` opens only if the button is already there.
 */
const navigation = async (page: Page) => {
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await expect(
      page
        .getByRole("button", { name: /^(Chats and menu|Close the menu)$/ })
        .filter({ visible: true })
        .first()
    ).toBeVisible()
  await showAppNavigation(page)
}

const openCardex = async (page: Page, place: "home" | "sidebar") => {
  const home = page.getByRole("main")
  if (place === "home") {
    await home.getByRole("button", { name: "cardex", exact: true }).click()
    return home
  }
  await navigation(page)
  await page
    .getByRole("group", { name: "Left panel", exact: true })
    .filter({ visible: true })
    .getByRole("button", { name: "Characters", exact: true })
    .click()
  await page.getByRole("combobox", { name: "Show", exact: true }).filter({ visible: true }).click()
  await page.getByRole("option", { name: /^cardex/ }).click()
  return page.locator("[data-shell-list]").filter({ visible: true }).locator("..")
}

export function cardexCreatorTests() {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      for (const place of ["home", "sidebar"] as const) {
        test(`cardex creators: ${place} ${width} ${theme}`, async ({ page, context }, info) => {
          test.setTimeout(300_000)
          const port = await freePort()
          const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
          try {
            await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
            await page.setViewportSize({ width, height: 900 })
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
            await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
            await page.goto(server.url)
            const scope = await openCardex(page, place)
            const tiles = scope.locator("[data-remote-card]")
            await expect(tiles.first()).toBeVisible()
            const creator = (await creatorsOf(scope))[0]!
            // From a result's menu: Cards by <creator>.
            await tiles.first().getByRole("link").click({ button: "right" })
            await page.getByRole("menuitem", { name: `Cards by ${creator}`, exact: true }).click()
            const header = scope.locator("[data-source-creator]")
            await expect(header.getByRole("heading", { name: `Cards by ${creator} (synthetic)` })).toBeVisible()
            await expect(header).toContainText(/On Synthetic \w+ · \d+ cards?/)
            await expect(header.locator("[data-creator-bio]")).toContainText("A synthetic creator")
            await expect(header.getByRole("link", { name: "Open on cardex", exact: true })).toHaveAttribute(
              "href",
              /\/u\//
            )
            await expect.poll(async () => (await creatorsOf(scope)).every((c) => c === creator)).toBe(true)
            await expect(page).toHaveURL(/(?:sf|sideSf)=/)
            await expectLayout(page, info, `cardex-creator-${place}-${width}-${theme}`, {
              scope: place === "home" ? "main" : "[data-shell-list]"
            })
            await page.screenshot({ path: info.outputPath("creator.png") })
            // Every sort still applies to their cards.
            if (place === "home")
              await scope
                .getByRole("group", { name: "Sort by", exact: true })
                .getByRole("button", { name: "Name", exact: true })
                .click()
            else {
              await scope.getByRole("button", { name: /^Sort by:/ }).click()
              await page.getByRole("menuitemcheckbox", { name: "Name", exact: true }).click()
            }
            await expect(page).toHaveURL(/(?:ssort|sideSsort)=name/)
            await expect(header).toBeVisible()
            // The URL is the view: a reload, and a second tab, show the same creator.
            const url = page.url()
            await page.reload()
            if (place === "sidebar") await navigation(page)
            await expect(header.getByRole("heading", { name: `Cards by ${creator} (synthetic)` })).toBeVisible()
            const second = await context.newPage()
            await second.setViewportSize({ width, height: 900 })
            await second.goto(url)
            if (place === "sidebar") await navigation(second)
            await expect(
              second
                .locator("[data-source-creator]")
                .filter({ visible: true })
                .getByRole("heading", { name: `Cards by ${creator} (synthetic)` })
            ).toBeVisible()
            await second.close()
            // Not by this creator: their cards leave, the rest stay, and the chip says why. (Another
            // site may have a creator of the same name: the cards are compared, not the names.)
            const theirs = new Set(
              await tiles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-remote-card")))
            )
            await header.getByRole("button", { name: "Not by this creator", exact: true }).click()
            await expect(header).toHaveCount(0)
            await expect(scope.getByLabel("Filters set", { exact: true })).toContainText("Exclude creators")
            await expect(tiles.first()).toBeVisible()
            await expect
              .poll(async () =>
                (await tiles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-remote-card")))).some(
                  (slug) => theirs.has(slug)
                )
              )
              .toBe(false)
            // Creator navigation is reversible. Back restores the URL's creator; Forward
            // restores the exclusion, in both home and the sidebar.
            const excludedUrl = page.url()
            await page.goBack()
            if (place === "sidebar") await navigation(page)
            await expect(header.getByRole("heading", { name: `Cards by ${creator} (synthetic)` })).toBeVisible()
            await page.goForward()
            if (place === "sidebar") await navigation(page)
            await expect(page).toHaveURL(excludedUrl)
            await expect(header).toHaveCount(0)
            // From a card's page, its creator's name opens the same view on home.
            if (place === "home") {
              await page.goto(
                `${server.url}/sources/cardex/cards/${await tiles.first().getAttribute("data-remote-card")}`
              )
              const card = page.locator("[data-remote-card-page]")
              const by = card.getByText(/^by /)
              const name = (await by.getByRole("link").innerText()).trim()
              await by.getByRole("link").click()
              await expect(
                page
                  .getByRole("main")
                  .locator("[data-source-creator]")
                  .getByRole("heading", { name: `Cards by ${name} (synthetic)` })
              ).toBeVisible()
              await expect(page).toHaveURL(/show=src\.cardex/)
            }
          } finally {
            await server.stop()
          }
        })
      }
}
