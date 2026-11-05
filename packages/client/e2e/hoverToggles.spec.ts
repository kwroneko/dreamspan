// Synthetic cards only. BEFORE_TOGGLES records the unchanged build for visual comparison.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const before = !!process.env.BEFORE_TOGGLES
test.setTimeout(120_000)

test.beforeAll(async () => {
  await admin((api) =>
    Effect.gen(function* () {
      const ids = []
      for (const name of ["Ava", "Bram", "Cleo", "Dora", "Ember", "Finn", "Gale", "Hana"])
        ids.push((yield* api.CreateCard({ label: name, name })).entityId)
      const chat = yield* api.CreateChat({ title: "The pair" })
      for (const entityId of ids.slice(0, 2))
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
    })
  )
})

const shot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" })
}

/** Opacity preserves geometry, accessibility and sequential keyboard focus. */
const reveal = async (page: Page, surface: Locator, toggle: Locator, opener: Locator) => {
  await surface.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await expect(toggle).toHaveCSS("opacity", "0")
  const box = await toggle.boundingBox()
  await surface.hover()
  await expect(toggle).toHaveCSS("opacity", "1")
  expect(await toggle.boundingBox()).toEqual(box)
  await page.mouse.move(0, 0)
  await opener.focus()
  await expect(toggle).toHaveCSS("opacity", "1")
  await page.keyboard.press("Tab")
  await expect(toggle).toBeFocused()
  expect(await toggle.boundingBox()).toEqual(box)
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`grid toggle visibility ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await admin((api) =>
        Effect.gen(function* () {
          for (const c of (yield* api.GetShellLibrary()).cards)
            yield* api.SetCardFavourite({ entityId: c.card.entityId, favourite: false })
        })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(server().url)
      const main = page.getByRole("main")
      const open = main.getByRole("button", { name: "Open Ava", exact: true })
      const tile = open.locator("..")
      const off = main.getByRole("button", { name: "Add Ava to favourites", exact: true })
      await expect(open).toBeVisible()
      await page.mouse.move(0, 0)
      await shot(page, `idle-${width}-${theme}`)
      if (!before) {
        await reveal(page, tile, off, open)
        await expect(page.getByText("Click to add to favourites", { exact: true })).toBeVisible()
      }
      await off.blur()
      await tile.hover()
      await shot(page, `hover-${width}-${theme}`)
      await off.click()
      const on = main.getByRole("button", { name: "Remove Ava from favourites", exact: true })
      await expect(on).toHaveAttribute("aria-pressed", "true")
      await on.blur()
      await page.mouse.move(0, 0)
      await expect(on).toHaveCSS("opacity", "1")
      await shot(page, `favourites-${width}-${theme}`)
      if (before) return
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)

      await page.goto(`${server().url}/library`)
      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Grid", exact: true }).click()
      const libraryTile = page.getByRole("list", { name: "Cards" }).locator("li").filter({ hasText: "Bram" })
      await reveal(
        page,
        libraryTile,
        libraryTile.getByRole("button", { name: "Add Bram to favourites", exact: true }),
        libraryTile.getByRole("link", { name: "Bram", exact: true })
      )
    })

test("sidebar character and group tiles reveal their toggles", async ({ page }) => {
  test.skip(before)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const panel = page.getByRole("complementary").first()
  await panel.getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
  const open = panel.getByRole("button", { name: "Open Bram", exact: true })
  await reveal(page, open.locator(".."), panel.getByRole("button", { name: "Add Bram to favourites" }), open)
  await panel.getByRole("combobox", { name: "Show" }).click()
  await page.getByRole("option", { name: "Groups · 1" }).click()
  const group = panel.getByRole("link", { name: "Open chat The pair" })
  const tile = group.locator("..")
  const pin = tile.getByRole("button", { name: /^Pin / })
  await reveal(page, tile, pin, group)
  await pin.click()
  const pinned = tile.getByRole("button", { name: /^Unpin / })
  await expect(pinned).toHaveAttribute("aria-pressed", "true")
  await pinned.blur()
  await page.mouse.move(0, 0)
  await expect(pinned).toHaveCSS("opacity", "1")
  await pinned.focus()
  await pinned.click()
  await expect(pin).toHaveAttribute("aria-pressed", "false")
  await page.goto(`${server().url}/chats`)
  const chat = page.getByRole("main").getByRole("link", { name: /The pair/ })
  const chatTile = chat.locator("..")
  await reveal(page, chatTile, chatTile.getByRole("button", { name: /^Pin / }), chat)
})

test("touch keeps off stars reachable without opening the tile", async ({ browser }) => {
  test.skip(before)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)).toBe(true)
  const off = page.getByRole("main").getByRole("button", { name: "Add Bram to favourites", exact: true })
  await expect(off).toHaveCSS("opacity", "1")
  await off.tap()
  await expect(page.getByRole("main").getByRole("button", { name: "Remove Bram from favourites" })).toBeVisible()
  await expect(page).toHaveURL(`${server().url}/`)
  await page.goto(`${server().url}/chats`)
  const chat = page.getByRole("main").getByRole("link", { name: /The pair/ })
  const pin = chat.locator("..").getByRole("button", { name: /^Pin / })
  await expect(pin).toHaveCSS("opacity", "1")
  const pinBox = await pin.boundingBox()
  const deleteBox = await chat.locator("..").getByRole("button", { name: "Delete The pair", exact: true }).boundingBox()
  expect(deleteBox!.y + deleteBox!.height).toBeLessThanOrEqual(pinBox!.y)
  await pin.tap()
  await expect(chat.locator("..").getByRole("button", { name: /^Unpin / })).toHaveCSS("opacity", "1")
  await expect(page).toHaveURL(`${server().url}/chats`)
  await context.close()
})
