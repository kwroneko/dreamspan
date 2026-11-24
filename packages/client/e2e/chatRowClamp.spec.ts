// Synthetic long names exercise every shared row at the sidebar's minimum width.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { showAppNavigation } from "./support/appMenu.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const title = "Group: Misaka Mikoto: 2024-08-25@03h30m53s"
const token = "x".repeat(200)
let chatId = ""
let characterId = ""

test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      characterId = mira.entityId
      for (const [name, cards] of [
        [title, [mira.entityId, wren.entityId]],
        [token, [mira.entityId]]
      ] as const) {
        const started = yield* api.StartChat({
          cards: [...cards],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic harbor scene.", speakerEntityId: mira.entityId }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name })
        const original = (yield* api.ListForks({ chatId: started.chat.id }))[0]!
        yield* api.PinFork({ forkId: original.id, pinned: true })
        yield* api.SetChatPin({ chatId: started.chat.id, leaf: null, pinned: true })
        if (name !== title) continue
        chatId = started.chat.id
        for (const name of [title, token.slice(0, 90)]) {
          const peer = (yield* api.CreateFork({
            chatId: started.chat.id,
            fromForkId: original.id,
            atSlotId: original.tipSlotId
          })).fork
          yield* api.NameFork({ forkId: peer.id, name })
          yield* api.PinFork({ forkId: peer.id, pinned: true })
        }
      }
    })
  )
})

for (const width of [1440, 390])
  test(`chat titles and corner actions fit at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const geometry: unknown[] = []
    const capture = async (scope: Locator, scene: string) => {
      const buttons = scope.locator(".fork-row-open[data-chat-id]")
      await expect(buttons.first()).toBeVisible()
      for (const button of await buttons.all()) {
        const heading = button.locator("[data-chat-title]")
        const measurement = await heading.evaluate((node) => {
          const box = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          const button = node.closest(".fork-row-open")!
          const row = button.parentElement!
          const rowBox = row.getBoundingClientRect()
          const dateBox = row.querySelector("[data-row-when]")!.getBoundingClientRect()
          const openBox = button.getBoundingClientRect()
          const number = (value: string) => parseFloat(value) || 0
          const vertical = (el: Element) => {
            const css = getComputedStyle(el)
            return (
              number(css.paddingTop) +
              number(css.paddingBottom) +
              number(css.borderTopWidth) +
              number(css.borderBottomWidth)
            )
          }
          const others = [...node.parentElement!.children].filter((el) => el !== node)
          const metadataHeight = others.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
          const portrait = row.querySelector("[data-portrait]")?.getBoundingClientRect()
          const stacked = portrait !== undefined && box.top >= portrait.bottom
          const accessories = [
            ...row.querySelectorAll<HTMLElement>(
              "[data-portrait], [data-branches-button], button[aria-label^='Pin '], button[aria-label^='Unpin ']"
            )
          ].map((el) => {
            const rect = el.getBoundingClientRect()
            return {
              width: rect.width,
              height: rect.height,
              centerOffset: Math.abs(rect.y + rect.height / 2 - (rowBox.y + rowBox.height / 2)),
              portrait: el.hasAttribute("data-portrait"),
              branches: el.hasAttribute("data-branches-button"),
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right
            }
          })
          return {
            title: node.textContent!,
            height: box.height,
            width: box.width,
            lineHeight: number(style.lineHeight),
            clamp: style.webkitLineClamp,
            overflowWrap: style.overflowWrap,
            wordBreak: style.wordBreak,
            ellipsis: style.textOverflow,
            rowHeight: rowBox.height,
            titleTop: box.top,
            stacked,
            rowTop: rowBox.top,
            dateBottom: dateBox.bottom,
            openRight: openBox.right,
            railWidth: row.lastElementChild!.getBoundingClientRect().width,
            maxRowHeight:
              Math.max(
                row.querySelector("[data-branches-button]") ? 72 : 48,
                number(style.lineHeight) * 2 +
                  metadataHeight +
                  number(getComputedStyle(node.parentElement!).rowGap) * others.length
              ) +
              vertical(button) +
              vertical(row) +
              (stacked ? 36 + 8 : 0),
            accessories
          }
        })
        geometry.push({ scene, ...measurement })
        expect(measurement.width).toBeGreaterThan(0)
        expect(measurement.height).toBeLessThanOrEqual(2 * measurement.lineHeight + 1)
        expect(measurement.rowHeight).toBeLessThanOrEqual(measurement.maxRowHeight + 1)
        expect(measurement.clamp).toBe("2")
        expect(measurement.overflowWrap).toBe("normal")
        expect(measurement.wordBreak).toBe("normal")
        expect(measurement.ellipsis).toBe("ellipsis")
        if (measurement.title === token) expect(measurement.height).toBeLessThanOrEqual(measurement.lineHeight + 1)
        for (const accessory of measurement.accessories) {
          if (accessory.portrait && !measurement.stacked) expect(accessory.centerOffset).toBeLessThanOrEqual(1)
          else if (accessory.portrait) expect(accessory.bottom).toBeLessThanOrEqual(measurement.titleTop - 8)
          else {
            if (!measurement.stacked) expect(accessory.left).toBeGreaterThanOrEqual(measurement.openRight)
            expect(
              Math.abs(
                accessory.branches && !measurement.stacked
                  ? accessory.bottom - measurement.dateBottom
                  : accessory.top - (measurement.stacked ? measurement.rowTop + 13 : measurement.titleTop)
              )
            ).toBeLessThanOrEqual(1)
          }
          expect(accessory.width).toBeGreaterThanOrEqual(accessory.portrait && measurement.stacked ? 24 : 32)
          expect(accessory.height).toBe(accessory.portrait ? (measurement.stacked ? 36 : 48) : 32)
        }
        const actions = measurement.accessories.filter((accessory) => !accessory.portrait)
        if (!measurement.stacked)
          expect(measurement.railWidth).toBeCloseTo(Math.max(...actions.map((action) => action.width)), 0)
        if (actions.length === 2) {
          const pin = actions.find((action) => !action.branches)!
          const branches = actions.find((action) => action.branches)!
          if (measurement.stacked) {
            expect(branches.right + 8).toBeCloseTo(pin.left, 0)
            expect(branches.top).toBeCloseTo(pin.top, 0)
          } else {
            expect(pin.bottom).toBeLessThanOrEqual(branches.top)
            expect(pin.right).toBeCloseTo(branches.right, 0)
          }
        }
        await button.scrollIntoViewIfNeeded()
        await button.hover()
        const tooltip = page.locator('[data-layout-overlay="Tooltip floats above the page"] > *')
        await expect(tooltip).toContainText(measurement.title.replace(/opens here$/, "").trim())
        if (measurement.title === token) {
          await expect
            .poll(() =>
              tooltip.evaluate((node) => {
                const text = document.createRange()
                text.selectNodeContents(node)
                const bounds = node.getBoundingClientRect()
                return Array.from(text.getClientRects()).every(
                  (line) =>
                    line.left >= Math.max(0, bounds.left - 1) &&
                    line.right <= Math.min(window.innerWidth, bounds.right + 1)
                )
              })
            )
            .toBe(true)
        }
        await page.mouse.move(0, 0)
        if (actions.length === 2 && process.env.SCREENSHOT_DIR) {
          await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
          await button.locator("..").screenshot({
            path: join(process.env.SCREENSHOT_DIR, `${width}-${scene}-branches-crop.png`)
          })
        }
        if (measurement.width === 0 && process.env.SCREENSHOT_DIR) {
          await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
          await button.locator("..").screenshot({
            path: join(process.env.SCREENSHOT_DIR, `${width}-${scene}-no-title-width.png`)
          })
        }
      }
      if (process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
        await buttons
          .first()
          .locator("..")
          .screenshot({ path: join(process.env.SCREENSHOT_DIR, `${width}-${scene}-crop.png`) })
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${width}-${scene}.png`) })
      }
    }
    // Compact branch rows have separate geometry coverage in branchRows.spec.ts.
    for (const [scene, query] of [
      ["all-pins-bottom", ""],
      ["character", `?character=${characterId}`]
    ]) {
      await page.goto(`${server().url}/chats/${chatId}${query}`)
      if (width === 390) await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
      await showAppNavigation(page)
      if (width === 1440) {
        const grip = page.getByRole("separator", { name: "Resize sidebar", exact: true })
        await grip.focus()
        await page.keyboard.press("Home")
        await expect(grip).toHaveAttribute("aria-valuenow", "220")
      }
      const sidebar =
        width === 1440
          ? page.getByRole("complementary", { name: "Sidebar", exact: true })
          : page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
      await capture(sidebar, scene!)
    }
    await page.goto(`${server().url}/`)
    await capture(page.getByRole("main").getByRole("region", { name: "Pinned chats", exact: true }), "home-pins")
    await page
      .getByRole("main")
      .getByRole("group", { name: "Show", exact: true })
      .getByRole("button", { name: "Groups", exact: true })
      .click()
    const groupTitle = page.getByRole("main").locator(`span[title="${title}"]`)
    await expect(groupTitle).toHaveAttribute("title", title)
    const groupBox = await groupTitle.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(node).lineHeight)
    }))
    expect(groupBox.height).toBeLessThanOrEqual(2 * groupBox.lineHeight + 1)
    await info.attach("row geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" })
    if (process.env.SCREENSHOT_DIR)
      await writeFile(join(process.env.SCREENSHOT_DIR, `geometry-${width}.json`), JSON.stringify(geometry, null, 2))
  })
