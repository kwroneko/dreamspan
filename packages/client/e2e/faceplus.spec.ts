// Synthetic casts cover the sidebar's wide and stacked portrait layouts.
import { writeFileSync } from "node:fs"
import { expect, test, type Locator } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile({
  ...withAdmin,
  ...(process.env.FACEPLUS_CLIENT_DIST ? { CLIENT_DIST: process.env.FACEPLUS_CLIENT_DIST } : {})
})
const before = process.env.FACEPLUS_BEFORE === "1"
const chats: { id: string; count: number; names: string[] }[] = []
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = []
      for (const name of ["Mira", "Wren", "Aria", "River", "Ash", "Fern"]) {
        cards.push(yield* api.CreateCard({ label: name, name }))
      }
      for (const count of [1, 2, 3, 6]) {
        const started = yield* api.StartChat({
          cards: cards.slice(0, count).map((card) => card.entityId),
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "The harbour lamps glow.", speakerEntityId: null }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name: `Harbour cast ${count}` })
        chats.push({ id: started.chat.id, count, names: cards.slice(0, count).map((card) => card.label) })
      }
    })
  )
})

for (const theme of ["light", "dark"] as const)
  for (const width of [390, 1024, 1440])
    test(`cast count and names ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chats[0]!.id}?side=chats`)
      if (width === 390) await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
      await showAppNavigation(page)
      if (width === 1024) {
        await page.getByRole("separator", { name: "Resize sidebar", exact: true }).focus()
        await page.keyboard.press("Home")
      }
      const navigation =
        width === 390
          ? page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
          : page.getByRole("complementary", { name: "Sidebar", exact: true })
      const controls = []
      for (const chat of chats) {
        const row = navigation
          .locator("[data-fork-row]")
          .filter({ has: page.locator(`[data-chat-id="${chat.id}"]`) })
          .first()
        await expect(row).toBeVisible()
        const portraits = row.locator("[data-row-portraits]")
        const shown = Math.min(chat.count, 2)
        await expect(portraits.locator("[data-portrait]").filter({ visible: true })).toHaveCount(shown)
        if (!before) {
          const badge = portraits.locator("[data-portrait-overflow]").filter({ visible: true })
          if (chat.count > 2) await expect(badge).toHaveText(`+${chat.count - shown}`)
          else await expect(badge).toHaveCount(0)
          if (chat.count > 2) {
            await measure(portraits, info.outputPath(`geometry-${chat.count}.json`))
          }
          await portraits.hover()
          await expect(
            page
              .locator('[data-layout-overlay="Tooltip floats above the page"]')
              .filter({ hasText: `Characters: ${chat.names.join(", ")}` })
          ).toBeVisible()
          await page.mouse.move(0, 0)
          await portraits.focus()
          await expect(
            page
              .locator('[data-layout-overlay="Tooltip floats above the page"]')
              .filter({ hasText: `Characters: ${chat.names.join(", ")}` })
          ).toBeVisible()
          await portraits.evaluate((node) => (node as HTMLElement).blur())
          await expectLayout(page, info, `cast-${chat.count}-${width}-${theme}`, {
            scope: `[data-fork-row]:has([data-chat-id="${chat.id}"])`
          })
        }
        await row.screenshot({ path: info.outputPath(`${before ? "before" : "after"}-${chat.count}.png`) })
        if (!before) {
          await row.evaluate((node) => ((node as HTMLElement).style.width = "min(230px, 100%)"))
          await row.screenshot({ path: info.outputPath(`after-stacked-${chat.count}.png`) })
          await measure(portraits, info.outputPath(`geometry-stacked-${chat.count}.json`))
          await expectLayout(page, info, `stacked-cast-${chat.count}-${width}-${theme}`, {
            scope: `[data-fork-row]:has([data-chat-id="${chat.id}"])`
          })
          await row.evaluate((node) => ((node as HTMLElement).style.width = ""))
        }
        if (chat.count >= 2)
          controls.push(
            await row.evaluate((node) => {
              const row = node.getBoundingClientRect()
              const controls = node.querySelector("[data-row-actions]")!.getBoundingClientRect()
              return { right: row.right - controls.right, top: controls.top - row.top }
            })
          )
      }
      if (!before && width >= 1024) {
        await page.getByRole("separator", { name: "Resize sidebar", exact: true }).focus()
        for (const mode of ["default", "wide"]) {
          if (mode === "default") await page.getByRole("separator", { name: "Resize sidebar", exact: true }).dblclick()
          else await page.keyboard.press("End")
          for (const chat of chats) {
            const row = navigation
              .locator("[data-fork-row]")
              .filter({ has: page.locator(`[data-chat-id="${chat.id}"]`) })
              .first()
            const portraits = row.locator("[data-row-portraits]")
            await expect(portraits.locator("[data-portrait]").filter({ visible: true })).toHaveCount(
              Math.min(chat.count, 2)
            )
            if (chat.count > 2)
              await expect(portraits.locator("[data-portrait-overflow]").filter({ visible: true })).toHaveText(
                `+${chat.count - 2}`
              )
            await measure(portraits, info.outputPath(`geometry-${mode}-${chat.count}.json`))
            await row.screenshot({ path: info.outputPath(`after-${mode}-${chat.count}.png`) })
            await expectLayout(page, info, `${mode}-cast-${chat.count}-${width}-${theme}`, {
              scope: `[data-fork-row]:has([data-chat-id="${chat.id}"])`
            })
          }
        }
      }
      if (width >= 1024) await page.getByRole("separator", { name: "Resize sidebar", exact: true }).dblclick()
      for (const chat of chats) {
        await page.goto(`${server().url}/chats/${chat.id}`)
        const header = page.locator("[data-chat-main] > header")
        await expect(header.getByText(`Harbour cast ${chat.count}`, { exact: true })).toBeVisible()
        const geometry = await header.locator("[data-portrait]").evaluateAll((nodes) =>
          nodes
            .filter((node) => node.checkVisibility())
            .map((node) => {
              const box = node.getBoundingClientRect()
              return { x: box.x, width: box.width, height: box.height }
            })
        )
        writeFileSync(info.outputPath(`geometry-header-${chat.count}.json`), JSON.stringify(geometry, null, 2))
        await header.screenshot({ path: info.outputPath(`${before ? "before" : "after"}-header-${chat.count}.png`) })
      }
      if (!before) {
        await page.goto(`${server().url}/chats`)
        const stack = page.getByRole("main").getByLabel(`Characters: ${chats[3]!.names.join(", ")}`, { exact: true })
        await expect(stack.locator("[data-portrait]")).toHaveCount(3)
        await expect(stack.locator("[data-portrait-overflow]")).toHaveText("+3")
        const tile = (await stack.locator("[data-portrait-overflow]").boundingBox())!
        const face = (await stack.locator("[data-portrait]").last().boundingBox())!
        expect(tile.width).toBe(face.width)
        expect(tile.height).toBe(face.height)
        expect(tile.x).toBeGreaterThanOrEqual(face.x + face.width)
        await stack.screenshot({ path: info.outputPath("after-chat-list.png") })
      }
      for (const control of controls) {
        expect(Math.abs(control.right - controls[0]!.right)).toBeLessThan(1)
        expect(Math.abs(control.top - controls[0]!.top)).toBeLessThan(1)
      }
    })

// Measure exposed geometry, including the count's text rather than just its box.
async function measure(group: Locator, path: string) {
  const geometry = await group.evaluate((node) => {
    const faces = [...node.querySelectorAll<HTMLElement>("[data-portrait]")].filter((face) => face.checkVisibility())
    const portraits = faces.map((face) => {
      const box = face.getBoundingClientRect()
      return { x: box.x, right: box.right, width: box.width, visibleWidth: box.width }
    })
    const tile = node.querySelector<HTMLElement>("[data-portrait-overflow]")
    if (!tile) return { portraits, count: null }
    const box = tile.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(tile.firstElementChild!)
    const text = range.getBoundingClientRect()
    const last = portraits.at(-1)!
    return {
      portraits,
      count: {
        width: box.width,
        visibleWidth: box.right - last.right,
        overlap: last.right - box.left,
        textLeft: text.left,
        textRight: text.right,
        textWidth: text.width
      }
    }
  })
  for (let i = 1; i < geometry.portraits.length; i++)
    expect(geometry.portraits[i]!.x).toBeGreaterThanOrEqual(geometry.portraits[i - 1]!.right)
  if (geometry.count) {
    expect(geometry.count.overlap).toBeGreaterThan(0)
    expect(geometry.count.visibleWidth).toBeLessThan(geometry.portraits.at(-1)!.width)
    expect(geometry.count.textLeft).toBeGreaterThanOrEqual(geometry.portraits.at(-1)!.right)
    expect(geometry.count.textWidth + 3).toBeLessThanOrEqual(geometry.count.visibleWidth)
  }
  writeFileSync(path, JSON.stringify(geometry, null, 2))
}

for (const theme of ["light", "dark"] as const)
  test(`overflow tile states ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = chats.find((chat) => chat.count === 6)!
    const measurements = []
    for (const mode of ["stacked", "wide"] as const) {
      await page.goto(`${server().url}/chats/${chats[0]!.id}?side=chats`)
      await showAppNavigation(page)
      const grip = page.getByRole("separator", { name: "Resize sidebar", exact: true })
      await grip.focus()
      await page.keyboard.press(mode === "stacked" ? "Home" : "End")
      const row = page.locator(`[data-fork-row]:has([data-chat-id="${chat.id}"])`).first()
      const open = row.getByRole("link", { name: `Open chat Harbour cast 6`, exact: true })
      for (const state of ["rest", "hover", "focus", "selected", "selected-hover"] as const) {
        await page.mouse.move(0, 0)
        await page.locator(":focus").evaluateAll((nodes) => nodes.forEach((node) => (node as HTMLElement).blur()))
        if (state === "hover" || state === "selected-hover") await row.hover()
        if (state === "focus") await open.focus()
        if (state === "selected") {
          await open.click()
          await expect(open).toHaveAttribute("aria-current", "page")
          await page.mouse.move(0, 0)
          await open.evaluate((node) => node.blur())
        }
        const tile = row.locator("[data-portrait-overflow]")
        await expect(tile).toHaveText("+4")
        const colors = await tileContrast(tile)
        measurements.push({ mode, state, ...colors })
        if (!before) expect(colors.edgeContrast).toBeGreaterThan(1.15)
        await row.screenshot({ path: info.outputPath(`${before ? "before" : "after"}-${mode}-${state}.png`) })
        if (!before)
          await expectLayout(page, info, `${mode}-${state}`, {
            scope: `[data-fork-row]:has([data-chat-id="${chat.id}"])`
          })
      }
    }
    await page.getByRole("separator", { name: "Resize sidebar", exact: true }).dblclick()
    await page.goto(`${server().url}/chats/${chat.id}`)
    const header = page.locator("[data-chat-main] > header")
    const tile = header.locator("[data-portrait-overflow]")
    await expect(tile).toBeVisible()
    await expect(tile).toHaveText("+2")
    const colors = await tileContrast(tile)
    measurements.push({ mode: "header", state: "rest", ...colors })
    if (!before) expect(colors.edgeContrast).toBeGreaterThan(1.15)
    await header.screenshot({ path: info.outputPath(`${before ? "before" : "after"}-header.png`) })
    if (!before) await expectLayout(page, info, "header", { scope: "[data-chat-main] > header" })
    await page.goto(`${server().url}/chats`)
    const stack = page.getByRole("main").getByLabel(`Characters: ${chat.names.join(", ")}`, { exact: true })
    await expect(stack.locator("[data-portrait-overflow]")).toHaveText("+3")
    const listColors = await tileContrast(stack.locator("[data-portrait-overflow]"))
    measurements.push({ mode: "chat-list", state: "rest", ...listColors })
    if (!before) expect(listColors.edgeContrast).toBeGreaterThan(1.15)
    await stack.screenshot({ path: info.outputPath(`${before ? "before" : "after"}-chat-list.png`) })
    writeFileSync(info.outputPath("contrast.json"), JSON.stringify(measurements, null, 2))
  })

async function tileContrast(tile: Locator) {
  return tile.evaluate((node) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }
    const luminance = (color: string) =>
      rgb(color).reduce((sum, value, index) => {
        const c = value / 255
        return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
      }, 0)
    const contrast = (a: string, b: string) => {
      const x = luminance(a),
        y = luminance(b)
      return Number(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(3))
    }
    let parent = node.parentElement!
    while (getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement!
    const row = getComputedStyle(parent).backgroundColor
    const style = getComputedStyle(node)
    const fill = style.backgroundColor
    const edge = style.borderWidth === "0px" ? fill : style.borderColor
    return { row, fill, edge, fillContrast: contrast(fill, row), edgeContrast: contrast(edge, row) }
  })
}
