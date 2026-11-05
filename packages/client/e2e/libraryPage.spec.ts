// The library at a heavy user's scale (support/librarySeed.ts): 438 cards with pictures, long
// names, personas and forks, at 1440 and 390 px in light and dark.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { seedLibrary } from "./support/librarySeed.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test.beforeAll(async ({ browser }) => {
  test.setTimeout(400_000)
  const page = await browser.newPage()
  await seedLibrary(page, server())
  await page.close()
})

const shotDir = process.env.LIBRARY_SCREENSHOTS
const shot = async (page: Page, name: string, width: number) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await page.screenshot({ path: join(shotDir, `${name}.png`), animations: "disabled" })
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the library at scale ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library`)
      const list = page.getByRole("list", { name: "Cards" })
      const rows = list.locator(":scope > li")
      await expect(list).toContainText("Aria Vance", { timeout: 60_000 })
      await expect(page.getByRole("tab", { name: /^Cards · 4\d\d$/ })).toBeVisible()
      // No row wraps or clips: the name starts inside the viewport, the actions keep to one line.
      // Rows off screen skip layout (content-visibility) and report a remembered size: lay each
      // out (through the CSSOM: the CSP refuses a style tag), so every row measured is as drawn.
      const layout = await rows.evaluateAll((items) =>
        items.slice(0, 80).map((li) => {
          li.style.setProperty("content-visibility", "visible")
          const box = li.getBoundingClientRect()
          return {
            // Each part's height too, so a row that grew says which part did.
            text: `${li.textContent} [${[...li.children].map((part) => Math.round(part.getBoundingClientRect().height)).join(", ")}]`,
            height: box.height,
            name: li.querySelector("[title]")!.getBoundingClientRect().left,
            right: box.right,
            actions: li.lastElementChild!.getBoundingClientRect().height
          }
        })
      )
      for (const row of layout) {
        expect(row.height, row.text!).toBeLessThan(90)
        expect(row.name, row.text!).toBeGreaterThan(0)
        expect(row.right, row.text!).toBeLessThanOrEqual(width)
        expect(row.actions, row.text!).toBeLessThanOrEqual(40)
      }
      await shot(page, `list-${width}-${theme}`, width)

      const search = page.getByRole("searchbox", { name: "Search cards" })
      await search.fill("Seraphina")
      await expect(rows).toHaveCount(2)
      await expect(page.getByText("2 of ", { exact: false })).toBeVisible()
      const long = rows.filter({
        has: page.getByRole("button", { name: /^Forks of / }).filter({ hasText: /^Fork$/ })
      })
      await expect(long.getByRole("button", { name: /^Forks of / })).toBeVisible()
      await shot(page, `search-${width}-${theme}`, width)
      await long.getByRole("button", { name: /^More actions for / }).click()
      const menu = page.getByRole("menu", { name: /^More actions for/ })
      for (const item of [
        "Fork…",
        "Forks",
        "Compare with parent",
        "Mark as a fork of…",
        "Unlink from parent",
        "Export…"
      ])
        await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible()
      await expect(menu.getByRole("menuitemcheckbox", { name: "Persona" })).not.toBeChecked()
      // A fork has no import line to update from.
      await expect(menu.getByRole("menuitem", { name: /Update from file/ })).toHaveCount(0)
      await shot(page, `menu-${width}-${theme}`, width)
      await menu.getByRole("menuitem", { name: "Export…", exact: true }).hover()
      await expect(
        page.getByRole("menu", { name: "Export…", exact: true }).getByRole("menuitem", { name: "PNG", exact: true })
      ).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(menu).toBeVisible()
      await page.keyboard.press("Escape")
      await search.fill("")

      await page
        .getByRole("group", { name: "Show" })
        .getByRole("button", { name: /^Personas/ })
        .click()
      // Only personas are listed, so none is marked.
      await expect(rows.first()).toBeVisible()
      await expect(rows.locator("[data-persona-badge]")).toHaveCount(0)
      await shot(page, `personas-${width}-${theme}`, width)
      await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click()

      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Grid", exact: true }).click()
      await expect(rows.first()).toBeVisible()
      const tiles = await rows.evaluateAll((items) =>
        items.slice(0, 40).map((li) => ({ text: li.textContent, ...li.getBoundingClientRect().toJSON() }))
      )
      for (const tile of tiles) {
        expect(tile.left, tile.text!).toBeGreaterThanOrEqual(0)
        expect(tile.right, tile.text!).toBeLessThanOrEqual(width)
      }
      await shot(page, `grid-${width}-${theme}`, width)
      // The view is remembered.
      await page.reload()
      await expect(page.getByRole("group", { name: "View" }).getByRole("button", { name: "Grid" })).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 60_000 }
      )

      await page.getByRole("tab", { name: /^Presets/ }).click()
      await expect(page.getByRole("list", { name: "Presets" }).locator(":scope > li").first()).toBeVisible()
      await shot(page, `presets-${width}-${theme}`, width)
    })

test("every item opens at its own address, and a stale address says so", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library`)
  // A card's name is its link: to the character's page.
  const cards = page.getByRole("list", { name: "Cards" })
  await cards.getByRole("link", { name: "Aria Vance", exact: true }).first().click()
  await expect(page).toHaveURL(/\/cards\/[^/]+$/)

  // A lorebook's Edit opens its editor's page; Back returns to the library.
  await page.goto(`${server().url}/library`)
  await page.getByRole("tab", { name: /^Lorebooks/ }).click()
  const lorebooks = page.getByRole("list", { name: "Lorebooks" })
  const book = lorebooks.locator(":scope > li").first()
  const title = (await book.getByRole("link").first().textContent())!
  await book.getByRole("link", { name: `Edit ${title}`, exact: true }).click()
  await expect(page).toHaveURL(/\/library\/[^/]+$/)
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await page.goBack()
  await expect(lorebooks).toBeVisible()

  // A preset's editor is a page too, with its search folded away until asked for.
  await page.getByRole("tab", { name: /^Presets/ }).click()
  const preset = page.getByRole("list", { name: "Presets" }).locator(":scope > li").first()
  const name = (await preset.getByRole("link").first().textContent())!
  await preset.getByRole("link", { name: `Edit ${name}`, exact: true }).click()
  await expect(page).toHaveURL(/\/library\/[^/]+$/)
  const editor = page.getByRole("main")
  await expect(editor.getByRole("heading", { level: 1, name })).toBeVisible()
  await expect(editor.locator("[data-window-close]")).toHaveCount(0)
  await expect(editor.getByRole("textbox", { name: "Find", exact: true })).toHaveCount(0)
  const search = editor.getByRole("button", { name: "Search and replace", exact: true })
  await expect(search).toHaveAttribute("aria-pressed", "false")
  await search.click()
  await expect(search).toHaveAttribute("aria-pressed", "true")
  await expect(editor.getByRole("textbox", { name: "Find", exact: true })).toBeVisible()
  const address = page.url()
  await page.reload()
  await expect(page).toHaveURL(address)
  await expect(editor.getByRole("heading", { level: 1, name })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("list", { name: "Presets" })).toBeVisible()

  await page.goto(`${server().url}/library/0190a5c0-0000-7000-8000-000000000000`)
  await expect(page.getByText("This item was deleted or never existed ·")).toBeVisible()
  await page.getByRole("main").getByRole("link", { name: "Library", exact: true }).click()
  await expect(page).toHaveURL(`${server().url}/library?kind=preset`)
})
