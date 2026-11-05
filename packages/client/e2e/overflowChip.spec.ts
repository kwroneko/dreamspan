// Synthetic six-member cast: compare the count tile to its neighbours and inspect
// every stock cast/portrait surface at phone and desktop widths in both themes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { openPanel, closePanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let chatId: ChatId
const names = ["Iris", "Echo", "Nova", "Sky Keeper", "Hidden Rowan", "Hidden Willow"]
test.beforeAll(async () => {
  chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Overflow group" })
      for (const name of names) {
        const card = yield* api.CreateCard({ label: name, name })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      }
      return chat.id
    })
  )
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: overflow tiles stay rectangular and contained`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shoot = async (name: string, region: Locator) => {
        const dir = process.env.OVERFLOW_CHIP_SHOTS
        if (!dir) return
        mkdirSync(dir, { recursive: true })
        await region.screenshot({ path: join(dir, `${width}-${theme}-${name}.png`), animations: "disabled" })
      }
      const rectangles = async (region: Locator) => {
        const portraits = region.locator("[data-portrait]").filter({ visible: true })
        await expect(portraits.first()).toBeVisible()
        const shapes = await portraits.evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            return { ratio: box.width / box.height, radius: parseFloat(style.borderRadius), width: box.width }
          })
        )
        for (const shape of shapes) {
          expect.soft(shape.ratio).toBeCloseTo(2 / 3, 2)
          expect.soft(shape.radius).toBeLessThan(shape.width / 2)
        }
      }
      await page.goto(`${server().url}/?show=groups`)
      const groups = page.getByRole("main").getByLabel("Groups", { exact: true })
      await expect(groups).toBeVisible()
      await shoot("home-groups", groups)
      await rectangles(groups)
      const collage = groups.locator("[aria-hidden='true'].grid").first()
      const count = collage.getByText("+2", { exact: true })
      const face = collage.locator("[data-portrait]").last()
      expect
        .soft(await count.evaluate((el) => getComputedStyle(el).borderRadius))
        .toBe(await face.evaluate((el) => getComputedStyle(el).borderRadius))

      await page.goto(`${server().url}/library`)
      await rectangles(page.getByRole("main"))
      await shoot("library-rows", page.getByRole("main"))
      await page.goto(`${server().url}/chats`)
      await rectangles(page.getByRole("main"))
      await shoot("chat-list", page.getByRole("main"))
      await page.goto(`${server().url}/chats/${chatId}`)
      const header = page.locator("[data-chat-main] > header")
      await expect(header.getByText("Overflow group", { exact: true })).toBeVisible()
      if (await page.getByRole("button", { name: "Close the panel", exact: true }).isVisible()) await closePanel(page)
      await shoot("header", header)
      if (width === 1440) {
        const chip = header.locator("[data-portrait-overflow]")
        const tile = header.locator("[data-portrait]").first()
        await expect(chip).toBeVisible()
        await shoot("header-stack", chip.locator(".."))
        const metrics = await chip.evaluate((el) => {
          const a = el.getBoundingClientRect(),
            p = el.parentElement!.getBoundingClientRect(),
            s = getComputedStyle(el)
          return {
            width: a.width,
            height: a.height,
            radius: s.borderRadius,
            shadow: s.boxShadow,
            contained: a.left >= p.left && a.right <= p.right && a.top >= p.top && a.bottom <= p.bottom,
            centre: (a.top + a.bottom - p.top - p.bottom) / 2
          }
        })
        const box = (await tile.boundingBox())!
        expect.soft(metrics.width).toBe(box.width)
        expect.soft(metrics.height).toBe(box.height)
        expect.soft(metrics.radius).toBe(await tile.evaluate((el) => getComputedStyle(el).borderRadius))
        expect.soft(metrics.shadow).toBe("none")
        expect.soft(metrics.contained).toBe(true)
        expect.soft(metrics.centre).toBeCloseTo(0, 1)
        // The cast order is supplied by the server; derive hidden names from the visible controls.
        const labels = await header
          .getByRole("button", { name: /^Show .+'s card$/ })
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))
        const hidden = names.filter((name) => !labels.includes(`Show ${name}'s card`))
        await chip.hover()
        await expect(page.getByText(hidden.join(", "), { exact: true })).toBeVisible()
        await page.mouse.move(0, 0)
        await chip.focus()
        await expect(page.getByText(hidden.join(", "), { exact: true })).toBeVisible()
        await chip.evaluate((el) => (el as HTMLElement).blur())
        await page.mouse.move(0, 0)
      } else await expect(header.locator("[data-portrait]").first()).toBeHidden()
      const cast = await openPanel(page, "Cast")
      await rectangles(cast)
      await shoot("cast", cast)
    })
