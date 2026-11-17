// The chat panel's tools in the user's order (owner, 2026-11-17, DESIGN §10.1 "Tab order"): one
// list, as many as fit in the row and the rest under More in the same order. Dragging reorders
// them in the row, onto More (the end), inside More and back up; each tool's own menu and
// Arrange tabs… do the same without a drag. The open tool, while its place is under More, shows
// as a guest before More and goes when another opens; the row never flips between layouts at a
// boundary width. The order is the account's, so it survives a reload. Every card is made up.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

let chat = ""
test.beforeAll(async () => {
  chat = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Odile", name: "Odile" })
      const created = yield* api.CreateChat({ title: "Tide tables" })
      yield* api.ChangeCast({ chatId: created.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      return created.id
    })
  )
})
test.beforeEach(async () => {
  await admin((api) => api.SetDisplayPrefs({ prefs: { panelTabOrder: [] } }))
})

const open = async (page: Page, width = 1440) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat}`)
  await openPanel(page, "This chat")
}

const strip = (page: Page) => page.getByRole("tablist", { name: "Chat panel" })
const more = (page: Page) => page.getByRole("button", { name: "More tools", exact: true })
const moreMenu = (page: Page) => page.getByRole("menu", { name: "More tools", exact: true })
const tool = (page: Page, value: string) => strip(page).locator(`[role="tab"][data-tab-value="${value}"]`)
const guest = (page: Page) => strip(page).locator("[data-tab-guest]")

/** The row's tools in order, the guest left out. */
const rowValues = (page: Page) =>
  strip(page)
    .locator('[role="tab"]:not([data-tab-guest])')
    .evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).dataset.tabValue!))
/** More's tools in order, with More opened and left open. */
const moreValues = async (page: Page) => {
  if (!(await moreMenu(page).isVisible())) await more(page).click()
  await expect(moreMenu(page)).toBeVisible()
  return moreMenu(page)
    .locator('[role="menuitem"][data-tab-value]')
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.tabValue!))
}
const closeMore = async (page: Page) => {
  if (await moreMenu(page).isVisible()) await page.keyboard.press("Escape")
  await expect(moreMenu(page)).toHaveCount(0)
}
/** Every tool, the row's then More's. */
const allValues = async (page: Page) => {
  const row = await rowValues(page)
  const rest = (await more(page).isVisible()) ? await moreValues(page) : []
  await closeMore(page)
  return [...row, ...rest]
}
const stored = () => admin((api) => api.GetDisplayPrefs({})).then((prefs) => prefs.panelTabOrder)

const center = async (locator: Locator) => {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** Presses on `source`, moves past the drag threshold, then to (x, y), and drops there. */
const drag = async (page: Page, source: Locator, to: { x: number; y: number }, beforeDrop?: () => Promise<void>) => {
  const from = await center(source)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 8, from.y + 2, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await beforeDrop?.()
  await page.mouse.up()
}
const leftEdgeOf = async (locator: Locator) => {
  const box = (await locator.boundingBox())!
  return { x: box.x + 3, y: box.y + box.height / 2 }
}

test("dragging a tool within the row reorders it, and the drop doesn't open it", async ({ page }, info) => {
  await open(page)
  const before = await allValues(page)
  const row = await rowValues(page)
  expect(row.length).toBeGreaterThanOrEqual(4)
  const [first, , third] = row as [string, string, string]
  await drag(page, tool(page, third), await leftEdgeOf(tool(page, first)), async () => {
    // While it's held: the floating tool, and the mark where it would land.
    await expect(page.locator('[data-layout-overlay="A dragged tab follows the pointer"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath("drag-in-row-1440.png") })
  })
  await expect.poll(() => rowValues(page)).toEqual([third, first, ...row.filter((v) => v !== first && v !== third)])
  await expect(tool(page, "chat")).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-layout-overlay="A dragged tab follows the pointer"]')).toHaveCount(0)
  await expect.poll(stored).toEqual([third, ...before.filter((v) => v !== third)])
  // A plain click still opens a tool.
  await tool(page, third).click()
  await expect(tool(page, third)).toHaveAttribute("aria-selected", "true")
})

test("each tool's menu moves it, and Reset tab order puts the usual order back", async ({ page }) => {
  await open(page)
  const usual = await allValues(page)
  const row = await rowValues(page)
  const second = row[1]!
  await tool(page, second).click({ button: "right" })
  const menu = page.getByRole("menu", { name: new RegExp(`^Actions for `) })
  await expect(menu.getByRole("menuitem", { name: "Move left", exact: true })).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: "Move to More", exact: true })).toBeVisible()
  await menu.getByRole("menuitem", { name: "Move to start", exact: true }).click()
  await expect.poll(() => rowValues(page).then((values) => values[0])).toBe(second)
  // Move right, then Move to More: last of all.
  await tool(page, second).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Move right", exact: true }).click()
  await expect.poll(() => rowValues(page).then((values) => values[1])).toBe(second)
  await tool(page, second).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Move to More", exact: true }).click()
  await expect.poll(() => allValues(page).then((values) => values.at(-1))).toBe(second)
  // From inside More: Move out of More brings it back to the row's end.
  await more(page).click()
  await moreMenu(page).locator(`[data-tab-value="${second}"]`).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Move out of More", exact: true }).click()
  await closeMore(page)
  await expect.poll(() => rowValues(page).then((values) => values.includes(second))).toBe(true)
  // Reset.
  await tool(page, second).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Reset tab order", exact: true }).click()
  await expect.poll(() => allValues(page)).toEqual(usual)
  await expect.poll(stored).toEqual([])
  // With the usual order, Reset has nothing to do.
  await tool(page, second).click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Reset tab order", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")
})

test("dragging onto More sends a tool to the end; More's tools drag among themselves and up into the row", async ({
  page
}) => {
  await open(page)
  const first = (await rowValues(page))[0]!
  // Onto More: last.
  await drag(page, tool(page, first), await center(more(page)))
  await expect.poll(() => allValues(page).then((values) => values.at(-1))).toBe(first)
  expect(await rowValues(page)).not.toContain(first)
  // Inside More: the last before the first.
  const inMore = await moreValues(page)
  expect(inMore.length).toBeGreaterThanOrEqual(2)
  const last = inMore.at(-1)!
  const top = moreMenu(page).locator(`[data-tab-value="${inMore[0]}"]`)
  const topBox = (await top.boundingBox())!
  await drag(page, moreMenu(page).locator(`[data-tab-value="${last}"]`), { x: topBox.x + 20, y: topBox.y + 3 })
  await expect.poll(() => moreValues(page).then((values) => values[0])).toBe(last)
  // Up into the row, before its first tool: More closes, and the tool leads the row.
  const lead = (await rowValues(page))[0]!
  await drag(page, moreMenu(page).locator(`[data-tab-value="${last}"]`), await leftEdgeOf(tool(page, lead)))
  await expect(moreMenu(page)).toHaveCount(0)
  await expect.poll(() => rowValues(page).then((values) => values[0])).toBe(last)
  // A tool held on More opens it, to drop at a place inside.
  const second = (await rowValues(page))[1]!
  await drag(page, tool(page, second), await center(more(page)), async () => {
    await expect(moreMenu(page)).toBeVisible()
    const target = moreMenu(page).locator('[role="menuitem"][data-tab-value]').first()
    const box = (await target.boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 3, { steps: 6 })
  })
  await expect.poll(() => moreValues(page).then((values) => values[0])).toBe(second)
  await closeMore(page)
})

test("the open tool past the row shows as a guest before More, and goes when another opens", async ({ page }) => {
  await open(page)
  const hidden = await moreValues(page)
  const target = hidden.at(-1)!
  await moreMenu(page).locator(`[data-tab-value="${target}"]`).click()
  await expect(guest(page)).toHaveAttribute("data-tab-value", target)
  await expect(guest(page)).toHaveAttribute("aria-selected", "true")
  await expect(strip(page).locator("[data-tab-guest-divider]")).toHaveCount(1)
  // Just before More, after the row's tools.
  const guestBox = (await guest(page).boundingBox())!
  const moreBox = (await more(page).boundingBox())!
  const lastRow = (await rowValues(page)).at(-1)!
  expect(guestBox.x).toBeGreaterThan((await tool(page, lastRow).boundingBox())!.x)
  expect(guestBox.x + guestBox.width).toBeLessThanOrEqual(moreBox.x + 1)
  // Its own place in More stays, marked.
  expect(await moreValues(page)).toContain(target)
  await expect(moreMenu(page).locator(`[data-tab-value="${target}"]`)).toHaveAttribute("data-shown-above")
  await expect(moreMenu(page).locator(`[data-tab-value="${target}"]`)).toContainText("Shown above")
  await closeMore(page)
  // Another tool: the guest goes.
  await tool(page, "chat").click()
  await expect(guest(page)).toHaveCount(0)
  await expect(strip(page).locator("[data-tab-guest-divider]")).toHaveCount(0)
  // Dragging the guest drops it at its new real place.
  await more(page).click()
  await moreMenu(page).locator(`[data-tab-value="${target}"]`).click()
  await expect(guest(page)).toHaveCount(1)
  await drag(page, guest(page), await leftEdgeOf(tool(page, "chat")))
  await expect.poll(() => rowValues(page).then((values) => values[0])).toBe(target)
  await expect(guest(page)).toHaveCount(0)
  await expect(tool(page, target)).toHaveAttribute("aria-selected", "true")
})

test("with a guest shown, the row settles at every width: no flipping at the boundaries", async ({ page }) => {
  await open(page)
  const hidden = await moreValues(page)
  await moreMenu(page).locator(`[data-tab-value="${hidden.at(-1)}"]`).click()
  await expect(guest(page)).toHaveCount(1)
  // Count changes to the row's tools after each pixel of resizing.
  await strip(page).evaluate((list) => {
    const counter = { changes: 0 }
    ;(window as unknown as { tabChanges: typeof counter }).tabChanges = counter
    new MutationObserver((records) => (counter.changes += records.length)).observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-tab-guest", "data-tab-value"]
    })
  })
  const grip = page.getByRole("separator", { name: "Resize chat panel" })
  const at = await center(grip)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  const counts = new Set<string>()
  for (let step = 1; step <= 120; step++) {
    await page.mouse.move(at.x + step, at.y)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.evaluate(() => ((window as unknown as { tabChanges: { changes: number } }).tabChanges.changes = 0))
    await page.waitForTimeout(60)
    expect(await page.evaluate(() => (window as unknown as { tabChanges: { changes: number } }).tabChanges.changes)).toBe(
      0
    )
    // Everything shown is inside the row.
    const row = (await strip(page).boundingBox())!
    const panel = (await page.locator("[data-chat-panel-tabs]").boundingBox())!
    for (const box of await strip(page)
      .locator('[role="tab"]')
      .evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().right)))
      expect(box).toBeLessThanOrEqual(panel.x + panel.width + 1)
    expect(row.width).toBeGreaterThan(0)
    counts.add(`${(await rowValues(page)).length}:${await guest(page).count()}`)
  }
  await page.mouse.up()
  // The sweep crossed at least one boundary, and the guest stayed while its place was in More.
  expect(counts.size).toBeGreaterThan(1)
})

test("the order is the account's: it survives a reload", async ({ page }) => {
  await open(page)
  const row = await rowValues(page)
  await tool(page, row[2]!).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Move to start", exact: true }).click()
  await expect.poll(() => rowValues(page).then((values) => values[0])).toBe(row[2])
  const arranged = await allValues(page)
  await expect.poll(stored).toEqual(arranged)
  await page.reload()
  await openPanel(page, "This chat")
  await expect.poll(() => allValues(page)).toEqual(arranged)
})

test("Arrange tabs… lists every tool to move with buttons", async ({ page }) => {
  await open(page)
  const usual = await allValues(page)
  await more(page).click()
  await page.getByRole("menuitem", { name: "Arrange tabs…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Arrange tabs" })
  await expect(dialog.getByRole("listitem")).toHaveCount(usual.length)
  await expect(dialog.getByText("In More").first()).toBeVisible()
  await dialog
    .getByRole("listitem")
    .nth(1)
    .getByRole("button", { name: /^Move .+ up$/ })
    .click()
  await expect.poll(() => rowValues(page).then((values) => values[0])).toBe(usual[1])
  await expect(dialog.getByRole("button", { name: "Reset tab order", exact: true })).toBeEnabled()
  await dialog.getByRole("button", { name: "Reset tab order", exact: true }).click()
  await expect.poll(() => rowValues(page).then((values) => values[0])).toBe(usual[0])
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the guest, More and the tool menus lay out at ${width} in ${theme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await open(page, width)
      const hidden = await moreValues(page)
      await moreMenu(page).locator(`[data-tab-value="${hidden.at(-1)}"]`).click()
      await expect(guest(page)).toHaveCount(1)
      await expectLayout(page, info, `tabs-guest-${width}-${theme}`, { scope: "[data-chat-panel-tabs]" })
      await page.screenshot({ path: info.outputPath(`guest-${width}-${theme}.png`) })
      await more(page).click()
      await expect(moreMenu(page)).toBeVisible()
      await expectLayout(page, info, `tabs-more-${width}-${theme}`, { scope: '[role="menu"]' })
      await page.screenshot({ path: info.outputPath(`more-${width}-${theme}.png`) })
      await closeMore(page)
      await tool(page, (await rowValues(page))[1]!).click({ button: "right" })
      const actions = page.getByRole("menu", { name: /^Actions for / })
      await expect(actions).toBeVisible()
      await expectLayout(page, info, `tabs-actions-${width}-${theme}`, { scope: '[role="menu"]' })
      await page.screenshot({ path: info.outputPath(`actions-${width}-${theme}.png`) })
      await actions.getByRole("menuitem", { name: "Arrange tabs…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Arrange tabs" })
      await expect(dialog).toBeVisible()
      await expectLayout(page, info, `tabs-arrange-${width}-${theme}`, { scope: '[role="dialog"]' })
      await page.screenshot({ path: info.outputPath(`arrange-${width}-${theme}.png`) })
    })

test.describe("on touch", () => {
  test.use({ hasTouch: true })
  test("a long press then a move drags a tool; a long press alone opens its menu", async ({ page }) => {
    await open(page, 390)
    const row = await rowValues(page)
    const [first, second] = row as [string, string]
    const client = await page.context().newCDPSession(page)
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      client.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }]
      })
    // A long press alone: the tool's menu.
    const from = await center(tool(page, second))
    await touch("touchStart", from.x, from.y)
    await page.waitForTimeout(800)
    await touch("touchEnd", from.x, from.y)
    await expect(page.getByRole("menu", { name: /^Actions for / })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu", { name: /^Actions for / })).toHaveCount(0)
    // A long press, then a move: a drag, before the first tool.
    const to = await leftEdgeOf(tool(page, first))
    await touch("touchStart", from.x, from.y)
    await page.waitForTimeout(800)
    for (let step = 1; step <= 10; step++)
      await touch("touchMove", from.x + ((to.x - from.x) * step) / 10, from.y + ((to.y - from.y) * step) / 10)
    await touch("touchEnd", to.x, to.y)
    await expect.poll(() => rowValues(page).then((values) => values[0])).toBe(second)
    await expect(page.getByRole("menu", { name: /^Actions for / })).toHaveCount(0)
  })
})
