// A character tile's two toggles over its picture (owner, 2026-11-06: the archive toggle showed
// on every tile, under the star's empty place, its backing on some tiles and not others). The
// star keeps the top left corner and the archive takes the top right; each is hidden at rest
// unless on, shown while the tile is hovered or holds focus, the same size, with one backing
// on the button itself. On a touch screen both stay shown. Synthetic cards only.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { seedCardArchive } from "./support/cardArchive.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, type TestServer, withAdmin } from "./support/server.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"

test.setTimeout(180_000)
let server: TestServer
test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await startServer(withAdmin)
  await seedCardArchive(server)
  // An archived favourite too: its star and its archive both stay on.
  await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
    api.SetCardFavourite({ entityId: "archive-e-002" as EntityId, favourite: true })
  )
})
test.afterAll(async () => server?.stop())

const tile = (page: Page, name: string) =>
  page
    .getByRole("main")
    .locator(".tile-toggle-surface")
    .filter({ has: page.getByRole("link", { name: `Open ${name}`, exact: true }) })
const star = (t: Locator) => t.getByRole("button", { name: /favourites$/ })
const archive = (t: Locator) => t.getByRole("button", { name: /^(Unarchive|Archive) / })

/** Each toggle's opacity, its offset from its own corner of the tile, its size and its backing. */
const measure = (t: Locator) =>
  t.evaluate((el) => {
    const tile = el.getBoundingClientRect()
    const read = (button: Element | null) => {
      if (!button) return null
      const r = button.getBoundingClientRect()
      const s = getComputedStyle(button)
      const wrapper = getComputedStyle(button.parentElement!)
      return {
        opacity: Number(s.opacity),
        clicks: s.pointerEvents !== "none",
        left: Math.round(r.left - tile.left),
        right: Math.round(tile.right - r.right),
        top: Math.round(r.top - tile.top),
        size: `${Math.round(r.width)}×${Math.round(r.height)}`,
        backing: s.backgroundColor,
        wrapperBacking: wrapper.backgroundColor
      }
    }
    return {
      star: read(el.querySelector('button[aria-label$="favourites"]')),
      archive: read(el.querySelector('button[aria-label^="Archive "], button[aria-label^="Unarchive "]'))
    }
  })

const expectPlaced = (m: Awaited<ReturnType<typeof measure>>) => {
  expect(m.star).toMatchObject({ left: 8, top: 8, size: "32×32", wrapperBacking: "rgba(0, 0, 0, 0)" })
  expect(m.archive).toMatchObject({ right: 8, top: 8, size: "32×32", wrapperBacking: "rgba(0, 0, 0, 0)" })
  expect(m.star!.backing).toMatch(/\/ 0\.85\)$/)
  expect(m.archive!.backing).toBe(m.star!.backing)
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: tile toggles at rest, hovered and focused`, async ({ page }, info) => {
      await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.goto(`${server.url}/`)
      const main = page.getByRole("main")
      const ordinary = tile(page, "Pilot 007")
      const favourite = tile(page, "Pilot 006")
      await expect(ordinary).toBeVisible()
      await page.mouse.move(0, 0)
      await ordinary.scrollIntoViewIfNeeded()
      await main.screenshot({ path: info.outputPath("all-rest.png") })

      // At rest only a toggle that's on shows: the favourite's star; no archive anywhere.
      const rest = await measure(ordinary)
      expectPlaced(rest)
      expect([rest.star!.opacity, rest.archive!.opacity]).toEqual([0, 0])
      // Hidden, they take no clicks: whatever is under them is the tile.
      expect([rest.star!.clicks, rest.archive!.clicks]).toEqual([false, false])
      const fav = await measure(favourite)
      expectPlaced(fav)
      expect([fav.star!.opacity, fav.archive!.opacity]).toEqual([1, 0])

      // Hovered, both show in their corners; nothing else moved.
      await ordinary.hover()
      await expect(archive(ordinary)).toHaveCSS("opacity", "1")
      await main.screenshot({ path: info.outputPath("all-hovered.png") })
      const hovered = await measure(ordinary)
      expectPlaced(hovered)
      expect([hovered.star!.opacity, hovered.archive!.opacity]).toEqual([1, 1])
      expect([hovered.star!.clicks, hovered.archive!.clicks]).toEqual([true, true])
      await archive(ordinary).hover()
      await expect(
        page.getByText("Click to archive Pilot 007: hidden from All and searches, found under Archived", {
          exact: true
        })
      ).toBeVisible()
      await ordinary.screenshot({ path: info.outputPath("archive-hover.png") })

      // Focus inside reveals them too, so the keyboard reaches them.
      await page.mouse.move(0, 0)
      await ordinary.getByRole("link").focus()
      await expect(archive(ordinary)).toHaveCSS("opacity", "1")
      await expect(star(ordinary)).toHaveCSS("opacity", "1")
      await page.keyboard.press("Tab")
      await expect(star(ordinary)).toBeFocused()
      await page.keyboard.press("Tab")
      await expect(archive(ordinary)).toBeFocused()
      expectPlaced(await measure(ordinary))

      // Archived: the archive stays on in its corner; an archived favourite keeps both.
      await page.goto(`${server.url}/?show=archived`)
      const archived = tile(page, "Pilot 001")
      const archivedFavourite = tile(page, "Pilot 002")
      await expect(archived).toBeVisible()
      await page.mouse.move(0, 0)
      await main.screenshot({ path: info.outputPath("archived-rest.png") })
      const a = await measure(archived)
      expectPlaced(a)
      expect([a.star!.opacity, a.archive!.opacity]).toEqual([0, 1])
      const af = await measure(archivedFavourite)
      expectPlaced(af)
      expect([af.star!.opacity, af.archive!.opacity]).toEqual([1, 1])
      await archived.hover()
      await expect(star(archived)).toHaveCSS("opacity", "1")
      await archive(archived).hover()
      await expect(
        page.getByText("Click to unarchive Pilot 001: back in All and searches", { exact: true })
      ).toBeVisible()
      await main.screenshot({ path: info.outputPath("archived-hovered.png") })
      expectPlaced(await measure(archived))
    })

test("390 touch: both toggles stay shown, in their corners", async ({ browser }, info) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce"
  })
  const page = await context.newPage()
  try {
    await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
    await page.goto(`${server.url}/`)
    const ordinary = tile(page, "Pilot 007")
    await expect(ordinary).toBeVisible()
    const m = await measure(ordinary)
    expectPlaced(m)
    expect([m.star!.opacity, m.archive!.opacity]).toEqual([1, 1])
    await page.getByRole("main").screenshot({ path: info.outputPath("touch.png") })
  } finally {
    await context.close()
  }
})
