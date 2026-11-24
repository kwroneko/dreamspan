// The character grids' sort and toggles on every tab, on Home and in the left panel (owner,
// 2026-11-23): "We *cannot* have random blank gaps appear between buttons. That is a hard rule."
// and "We also need to avoid layout shifts." Every tab shows the same buttons in the same places
// (Include personas and Group forks disabled with why where they do nothing), so switching tabs
// moves neither the sort nor its direction button, and nothing invisible sits between buttons.
// GRID_TOGGLES_SHOTS=<folder> keeps a 1340 px dark window screenshot of each tab there.
import { createServer } from "node:net"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { apiLogin, ADMIN, startServer, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { seedCardArchive } from "./support/cardArchive.ts"
import { hideAppNavigation, showAppNavigation } from "./support/appMenu.ts"

test.setTimeout(600_000)

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

const TABS = ["All", "With chats", "Never used", "Favourites", "Personas", "Groups", "Archived", "cardex"] as const
const WIDTHS = [1440, 1340, 1024, 768, 600, 390] as const
const shots = process.env.GRID_TOGGLES_SHOTS

type Box = { x: number; y: number; width: number; height: number }
const box = async (locator: Locator): Promise<Box> => {
  const b = await locator.boundingBox()
  expect(b, "laid out").not.toBeNull()
  return b!
}
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
const same = (actual: Box, expected: Box, what: string) => {
  for (const key of ["x", "y", "width", "height"] as const)
    expect
      .soft(Math.abs(actual[key] - expected[key]), `${what}: ${key} ${actual[key]} vs ${expected[key]}`)
      .toBeLessThan(0.5)
}
const sameRight = (actual: Box, expected: Box, what: string) => {
  expect
    .soft(Math.abs(actual.x + actual.width - (expected.x + expected.width)), `${what}: right edge`)
    .toBeLessThan(0.5)
  expect.soft(Math.abs(actual.y - expected.y), `${what}: top`).toBeLessThan(0.5)
}

/** The toggles are shown on every tab: enabled where they act, disabled with why where they don't. */
const expectToggles = async (scope: Locator, tab: (typeof TABS)[number]) => {
  const personas = scope.getByRole("button", { name: "Include personas", exact: true })
  const forks = scope.getByRole("button", { name: "Group forks", exact: true })
  await expect(personas).toBeVisible()
  await expect(forks).toBeVisible()
  if (["Personas", "Groups", "Archived", "cardex"].includes(tab)) await expect(personas).toBeDisabled()
  else await expect(personas).toBeEnabled()
  if (["Groups", "cardex"].includes(tab)) await expect(forks).toBeDisabled()
  else await expect(forks).toBeEnabled()
}

for (const theme of ["light", "dark"] as const)
  test(`grid toggles keep their places on every tab: ${theme}`, async ({ page }, info) => {
    const port = await freePort()
    const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
    try {
      await seedCardArchive(server)
      await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      if (shots) mkdirSync(shots, { recursive: true })
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${server.url}/?side=characters`)
        await hideAppNavigation(page)

        // Home: click through the tabs; the sort and its direction never move.
        const main = page.getByRole("main")
        const controls = main.locator("[data-card-grid-controls]")
        const show = controls.getByRole("group", { name: "Show", exact: true })
        // The sort bar as seen: its choices' scroller (a source's longer list scrolls inside it).
        const sort = controls.locator(".card-grid-sort [data-scroll-keep]")
        const direction = controls.locator(".card-grid-sort").getByRole("button", { name: /^Order: / })
        // Archive unused… (owner, 2026-11-24): a button on the sort's other side from the toggles,
        // on every tab, enabled, the row's gap before the sort.
        const archive = controls.getByRole("button", { name: "Archive unused…", exact: true })
        const rowGap = await controls
          .locator(".card-grid-controls")
          .evaluate((row) => parseFloat(getComputedStyle(row).columnGap))
        await expect(show.getByRole("button", { name: "cardex", exact: true })).toBeVisible()
        let home: { sort: Box; direction: Box } | null = null
        for (const tab of TABS) {
          await show.getByRole("button", { name: tab, exact: true }).click()
          await expect(show.getByRole("button", { name: tab, exact: true })).toHaveAttribute("aria-pressed", "true")
          if (tab === "cardex")
            await expect(main.locator("[data-remote-card]").first()).toBeVisible({ timeout: 30_000 })
          await expectToggles(controls, tab)
          await settle(page)
          const now = { sort: await box(sort), direction: await box(direction) }
          home ??= now
          const what = `home ${width} ${theme} ${tab}`
          await expect(archive).toBeEnabled()
          const archived = await box(archive)
          expect
            .soft(
              Math.abs(archived.x + archived.width + rowGap - now.sort.x),
              `${what} archive button: gap to the sort`
            )
            .toBeLessThan(0.5)
          expect.soft(Math.abs(archived.y - now.sort.y), `${what} archive button: top`).toBeLessThan(0.5)
          if (tab === "All" || tab === "cardex") {
            await archive.click()
            const dialog = page.getByRole("dialog", { name: "Archive unused cards", exact: true })
            await expect(dialog).toBeVisible()
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
            await expect(dialog).toBeHidden()
            await settle(page)
          }
          // cardex has its own sorts, so its bar is wider: its right end and the direction stay.
          if (tab === "cardex") sameRight(now.sort, home.sort, `${what} sort`)
          else same(now.sort, home.sort, `${what} sort`)
          same(now.direction, home.direction, `${what} direction`)
          // The divider before cardex has the same room on both sides, and its count sits as the
          // filters' counts do (the gap between a label and its count).
          const strip = await show.evaluate((group) => {
            const divider = group.querySelector("[data-segment-divider]")!.getBoundingClientRect()
            const buttons = [...group.querySelectorAll("button")]
            const source = buttons.at(-1)!
            const before = buttons.at(-2)!.getBoundingClientRect()
            const countGap = (button: HTMLButtonElement) => {
              const spans = button.querySelectorAll("span[aria-hidden]")
              const count = spans[spans.length - 1]
              if (!count) return null
              const range = document.createRange()
              range.selectNodeContents(button.firstChild!)
              return count.getBoundingClientRect().left - range.getBoundingClientRect().right
            }
            return {
              left: divider.left - before.right,
              right: source.getBoundingClientRect().left - divider.right,
              sourceCount: countGap(source),
              filterCount: countGap(buttons[0]!)
            }
          })
          expect
            .soft(
              Math.abs(strip.left - strip.right),
              `home ${width} ${tab}: divider room ${strip.left} / ${strip.right}`
            )
            .toBeLessThan(0.5)
          if (strip.sourceCount !== null)
            expect
              .soft(Math.abs(strip.sourceCount - strip.filterCount!), `home ${width} ${tab}: cardex count gap`)
              .toBeLessThan(0.5)
          await expectLayout(page, info, `home-${tab}-${width}-${theme}`, { scope: "[data-card-grid-controls]" })
          if (shots && width === 1340 && theme === "dark")
            await page.screenshot({ path: join(shots, `home-${tab.replace(/ /g, "-").toLowerCase()}.png`) })
        }

        // The left panel: the same through its Show menu.
        await page.goto(`${server.url}/?side=characters`)
        await expect(main.locator("[data-card-grid-controls]")).toBeVisible()
        await showAppNavigation(page)
        const bar = page.locator("[data-card-browse-bar]").filter({ visible: true })
        await expect(bar).toBeVisible()
        const sideSort = bar.getByRole("button", { name: /^Sort by: / })
        const sideDirection = bar.getByRole("button", { name: /^Order: / })
        let side: { sort: Box; direction: Box } | null = null
        for (const tab of TABS) {
          await bar.getByRole("combobox", { name: "Show", exact: true }).click()
          await page.getByRole("option", { name: new RegExp(`^${tab}( ·|$)`) }).click()
          await expect(bar.getByRole("combobox", { name: "Show", exact: true })).toContainText(tab)
          if (tab === "cardex")
            await expect(
              page.locator("[data-shell-list] [data-remote-card]").filter({ visible: true }).first()
            ).toBeVisible({
              timeout: 30_000
            })
          await expectToggles(bar, tab)
          await settle(page)
          const now = { sort: await box(sideSort), direction: await box(sideDirection) }
          side ??= now
          const what = `side ${width} ${theme} ${tab}`
          // cardex's sort names its own choice ("Popular"): its right end and the direction stay.
          if (tab === "cardex") sameRight(now.sort, side.sort, `${what} sort`)
          else same(now.sort, side.sort, `${what} sort`)
          same(now.direction, side.direction, `${what} direction`)
          await expectLayout(page, info, `side-${tab}-${width}-${theme}`, { scope: "[data-card-browse-bar]" })
          if (shots && width === 1340 && theme === "dark")
            await page.screenshot({ path: join(shots, `sidebar-${tab.replace(/ /g, "-").toLowerCase()}.png`) })
        }
        await hideAppNavigation(page)
      }
    } finally {
      await server.stop()
    }
  })
