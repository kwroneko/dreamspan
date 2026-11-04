// Synthetic casts cover the sidebar's wide and stacked portrait layouts.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
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
        const compact = await row.evaluate((node) => {
          const style = getComputedStyle(node)
          return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) < 265
        })
        const shown = !before && compact && chat.count > 2 ? 1 : Math.min(chat.count, 2)
        await expect(portraits.locator("[data-portrait]").filter({ visible: true })).toHaveCount(shown)
        if (!before) {
          const badge = portraits.locator("[data-portrait-overflow]").filter({ visible: true })
          if (chat.count > 2) await expect(badge).toHaveText(`+${chat.count - shown}`)
          else await expect(badge).toHaveCount(0)
          if (chat.count > 2) {
            const tile = (await badge.boundingBox())!
            const face = (await portraits.locator("[data-portrait]").first().boundingBox())!
            expect(tile.width).toBe(face.width)
            expect(tile.height).toBe(face.height)
            expect(tile.x).toBeGreaterThanOrEqual(face.x + face.width)
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
          if (chat.count > 2) {
            const tile = (await portraits.locator("[data-portrait-overflow]").filter({ visible: true }).boundingBox())!
            const face = (await portraits.locator("[data-portrait]").first().boundingBox())!
            expect(tile.width).toBe(face.width)
            expect(tile.height).toBe(face.height)
          }
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
        await page.keyboard.press("End")
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
          await row.screenshot({ path: info.outputPath(`after-wide-${chat.count}.png`) })
          await expectLayout(page, info, `wide-cast-${chat.count}-${width}-${theme}`, {
            scope: `[data-fork-row]:has([data-chat-id="${chat.id}"])`
          })
        }
      }
      await page.goto(`${server().url}/chats/${chats[3]!.id}`)
      const header = page.locator("[data-chat-main] > header")
      await expect(header.getByText("Harbour cast 6", { exact: true })).toBeVisible()
      await header.screenshot({ path: info.outputPath(`${before ? "before" : "after"}-header.png`) })
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
