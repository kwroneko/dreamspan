// Actual tile and portrait edges, rather than just the declared CSS gap. Synthetic cards only.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
let chatId: ChatId

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (let i = 0; i < 15; i++) {
    const response = await page.request.post(`${server().url}/library/import?name=Portrait${i}.png`, {
      data: shapeCard({ name: `Portrait ${String(i).padStart(2, "0")}`, width: 160, height: 240 }, i * 7),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.ok()).toBe(true)
  }
  await page.close()
  chatId = await admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const chats = []
      // Two/three/four/many members, enough tiles to wrap even in a wide panel.
      for (const [i, count] of [2, 3, 4, 7, 2, 3, 4, 7].entries()) {
        const chat = yield* api.CreateChat({ title: `Portrait group ${i}` })
        for (const card of cards.slice(0, count))
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        chats.push(chat.id)
      }
      return chats[3]!
    })
  )
})

/** Compare every aligned neighbouring pair, including the last, incomplete row. */
const measure = async (items: Locator) =>
  items.evaluateAll((nodes) => {
    const boxes = nodes.map((node) => node.getBoundingClientRect())
    const horizontal: number[] = []
    const vertical: number[] = []
    for (const a of boxes) {
      const right = boxes.filter((b) => Math.abs(a.top - b.top) < 1 && b.left > a.right - 1)
      if (right.length) horizontal.push(Math.min(...right.map((b) => b.left - a.right)))
      const below = boxes.filter(
        (b) => b.top > a.bottom - 1 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      )
      if (below.length) vertical.push(Math.min(...below.map((b) => b.top - a.bottom)))
    }
    let grid = nodes[0]?.parentElement
    while (grid && getComputedStyle(grid).display !== "grid") grid = grid.parentElement
    const css = grid ? getComputedStyle(grid) : null
    const declared = css ? [parseFloat(css.columnGap), parseFloat(css.rowGap)] : []
    return { horizontal, vertical, declared }
  })

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" })
}

for (const mode of ["1440", "390", "wide-panel"] as const)
  for (const theme of ["light", "dark"] as const)
    test(`${mode} ${theme}: portrait and card grids keep equal gaps`, async ({ page }, info) => {
      test.setTimeout(120_000)
      const results: Record<string, Awaited<ReturnType<typeof measure>>> = {}
      const check = async (name: string, items: Locator, twoRows = true) => {
        await expect(items.first()).toBeVisible()
        const gaps = await measure(items)
        results[name] = gaps
        if (twoRows) {
          expect.soft(gaps.horizontal.length, `${name}: horizontal neighbours`).toBeGreaterThan(0)
          expect.soft(gaps.vertical.length, `${name}: vertical neighbours`).toBeGreaterThan(0)
        }
      }
      await page.setViewportSize({ width: mode === "390" ? 390 : mode === "wide-panel" ? 1920 : 1440, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(server().url)
      const main = page.getByRole("main")
      const characters = main.getByLabel("Characters", { exact: true })
      await expect(characters.locator(":scope > div")).toHaveCount(15)
      await check("home-characters", characters.locator(":scope > div"))
      await shoot(page, `${mode}-${theme}-home-characters`)
      await main
        .getByRole("group", { name: "Show", exact: true })
        .getByRole("button", { name: "Groups", exact: true })
        .click()
      const groups = main.getByLabel("Groups", { exact: true })
      await expect(groups.locator(":scope > div")).toHaveCount(8)
      await check("home-groups", groups.locator(":scope > div"))
      const collages = groups.locator("[aria-hidden='true'].grid")
      for (let i = 0; i < 8; i++) {
        const portraits = collages.nth(i).locator("[data-portrait]")
        await check(`collage-${i}`, portraits, (await portraits.count()) > 2)
      }
      await shoot(page, `${mode}-${theme}-home-groups`)

      await page.goto(`${server().url}/chats/${chatId}?side=characters`)
      const cast = await openPanel(page, "Cast")
      if (mode === "wide-panel") {
        const grip = page.getByRole("separator", { name: "Resize chat panel", exact: true })
        await grip.focus()
        await page.keyboard.press("End")
        expect(Number(await grip.getAttribute("aria-valuenow"))).toBeGreaterThan(900)
      }
      await cast.getByRole("button", { name: "Add characters", exact: true }).click()
      const add = cast.getByRole("region", { name: "Add characters", exact: true })
      const addGrid = add.getByLabel("Characters", { exact: true })
      await expect(addGrid.locator(":scope > div")).toHaveCount(15)
      await addGrid.scrollIntoViewIfNeeded()
      await check("cast-add", addGrid.locator(":scope > div"))
      await shoot(page, `${mode}-${theme}-cast-add`)

      {
        if (mode === "390") {
          await closePanel(page)
          await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
        }
        const sidebarGrid = page
          .getByLabel("Characters", { exact: true })
          .filter({ has: page.getByRole("link", { name: "Open Portrait 00", exact: true }) })
          .filter({ hasNot: page.getByRole("button", { name: / to this chat$|: in this chat$/ }) })
        if (mode === "wide-panel") {
          await page.getByRole("separator", { name: "Resize chat panel", exact: true }).dblclick()
          const sidebarGrip = page.getByRole("separator", { name: "Resize sidebar", exact: true })
          await sidebarGrip.focus()
          await page.keyboard.press("End")
        }
        await expect(sidebarGrid.locator(":scope > div")).toHaveCount(15)
        await check("sidebar-characters", sidebarGrid.locator(":scope > div"))
        await shoot(page, `${mode}-${theme}-sidebar-characters`)
        const show = page.getByRole("combobox", { name: "Show", exact: true }).first()
        await show.click()
        await page.getByRole("option", { name: /^Groups/ }).click()
        const sideGroups = page.getByLabel("Groups", { exact: true }).filter({ visible: true })
        await expect(sideGroups.locator(":scope > div")).toHaveCount(8)
        await check("sidebar-groups", sideGroups.locator(":scope > div"))
        const sideCollages = sideGroups.locator("[aria-hidden='true'].grid")
        for (let i = 0; i < 8; i++) {
          const portraits = sideCollages.nth(i).locator("[data-portrait]")
          await check(`sidebar-collage-${i}`, portraits, (await portraits.count()) > 2)
        }
        await shoot(page, `${mode}-${theme}-sidebar-groups`)
      }
      await info.attach("measured-gaps", { body: JSON.stringify(results, null, 2), contentType: "application/json" })
      for (const [name, { horizontal, vertical, declared }] of Object.entries(results)) {
        const gaps = [...horizontal, ...vertical, ...declared]
        expect.soft(Math.min(...gaps), `${name}: nonnegative gaps`).toBeGreaterThanOrEqual(0)
        expect
          .soft(Math.max(...gaps) - Math.min(...gaps), `${name}: equal horizontal/vertical gaps`)
          .toBeLessThanOrEqual(1)
      }
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: library and group pages keep equal gaps`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const results: Record<string, Awaited<ReturnType<typeof measure>>> = {}
      await page.goto(`${server().url}/library`)
      await page
        .getByRole("group", { name: "View", exact: true })
        .getByRole("button", { name: "Grid", exact: true })
        .click()
      const tiles = page.getByRole("main").locator("ul.grid > li")
      await expect(tiles).toHaveCount(15)
      // Let content-visibility measure every tile instead of its placeholder height.
      for (const tile of await tiles.all()) await tile.scrollIntoViewIfNeeded()
      await tiles.first().scrollIntoViewIfNeeded()
      results.library = await measure(tiles)
      await shoot(page, `${width}-${theme}-library`)
      // Only the group's page has the collage: a group's new chat is the chat page, as any chat
      // (DESIGN §2.1 [D] "A pending chat looks and works like any other chat", pendingchat).
      for (const path of [`/groups/${chatId}`]) {
        await page.goto(`${server().url}${path}`)
        const portraits = page.getByRole("main").locator("[aria-hidden='true'].grid [data-portrait]")
        await expect(portraits).toHaveCount(4)
        results[path.endsWith("new") ? "new-group" : "group-page"] = await measure(portraits)
        await shoot(page, `${width}-${theme}-${path.endsWith("new") ? "new-group" : "group-page"}`)
      }
      await info.attach("measured-gaps", { body: JSON.stringify(results, null, 2), contentType: "application/json" })
      for (const [name, { horizontal, vertical, declared }] of Object.entries(results)) {
        expect.soft(horizontal.length, `${name}: horizontal neighbours`).toBeGreaterThan(0)
        expect.soft(vertical.length, `${name}: vertical neighbours`).toBeGreaterThan(0)
        const gaps = [...horizontal, ...vertical, ...declared]
        expect.soft(Math.min(...gaps), `${name}: nonnegative gaps`).toBeGreaterThanOrEqual(0)
        expect
          .soft(Math.max(...gaps) - Math.min(...gaps), `${name}: equal horizontal/vertical gaps`)
          .toBeLessThanOrEqual(1)
      }
    })
