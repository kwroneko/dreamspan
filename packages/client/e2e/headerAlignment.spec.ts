// The three column dividers share a height even when the chat hides its portraits.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Locator } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let chatId = ""
let cardId = ""
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      cardId = card.entityId
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The lamp is lit.", speakerEntityId: card.entityId }
      })
      chatId = started.chat.id
    })
  )
})

const geometry = (locator: Locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const css = getComputedStyle(el)
    return { top: r.top, bottom: r.bottom, height: r.height, middle: (r.top + r.bottom) / 2, py: css.paddingTop }
  })

for (const width of [1440, 1024, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: column headers align and sidebar content is centred`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      for (const [scene, path] of [
        ["saved", `/chats/${chatId}`],
        ["pending", `/cards/${cardId}/chat`]
      ]) {
        await page.goto(`${server().url}${path}${width >= 1024 ? "?panel=chat" : ""}`)
        const centre = page.locator("main header").filter({ has: page.getByRole("heading", { level: 1 }) })
        await expect(centre.getByRole("heading", { name: /^Wren/ })).toBeVisible()
        await expect(page.getByRole("status").filter({ hasText: /^(Loading|Still loading)/ })).toHaveCount(0)
        const measurements: Record<string, unknown> = { centre: await geometry(centre) }
        if (width >= 1024) {
          const left = page.getByRole("complementary").first()
          const title = left.getByRole("link", { name: "rp-harness", exact: true })
          const leftBar = title.locator("..")
          const tools = page.getByRole("tablist", { name: "Chat panel", exact: true })
          await expect(tools).toBeVisible()
          const rightBar = tools.locator('xpath=ancestor::div[contains(@class,"border-b")][1]')
          const [l, c, r] = await Promise.all([geometry(leftBar), geometry(centre), geometry(rightBar)])
          const controls = await Promise.all([title, ...(await leftBar.getByRole("button").all())].map(geometry))
          const tabs = await geometry(left.getByRole("group", { name: "Left panel", exact: true }))
          Object.assign(measurements, { left: l, right: r, controls, tabGap: tabs.top - l.bottom })
          if (!process.env.HEADERALIGN_BEFORE) {
            expect(Math.max(l.bottom, c.bottom, r.bottom) - Math.min(l.bottom, c.bottom, r.bottom)).toBeLessThanOrEqual(
              1
            )
            expect(l.py).toBe(c.py)
            for (const control of controls) expect(Math.abs(control.middle - (l.middle - 0.5))).toBeLessThanOrEqual(1)
            expect(tabs.top - l.bottom).toBe(16)
            // The centre's actions share the sidebar's content centre, including at 1024.
            const actions = await geometry(centre.getByRole("button", { name: "Hide panel", exact: true }))
            expect(Math.abs(actions.middle - controls[0]!.middle)).toBeLessThanOrEqual(1)
          }
        } else if (!process.env.HEADERALIGN_BEFORE) {
          const c = await geometry(centre)
          expect(c.height).toBe(65)
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
        }
        const work = process.env.HEADERALIGN_WORK
        if (work) {
          mkdirSync(work, { recursive: true })
          const name = `${scene}-${width}-${theme}`
          writeFileSync(join(work, `${name}.json`), JSON.stringify(measurements, null, 2))
          await page.screenshot({ path: join(work, `${name}.png`), clip: { x: 0, y: 0, width, height: 180 } })
        }
      }
    })
