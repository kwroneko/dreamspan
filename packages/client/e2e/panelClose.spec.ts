import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel, closePanel } from "./support/panel.ts"
import { showAppNavigation, hideAppNavigation } from "./support/appMenu.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [390, 1024, 1440]) {
  for (const pending of [false, true]) {
    test(`${pending ? "pending" : "saved"} panel closes from the visible control at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const path = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const card = yield* api.CreateCard({ label: "Synthetic panel test", name: "Panel test" })
          if (pending) return `/cards/${card.entityId}/chat`
          const chat = yield* api.CreateChat({ title: "Panel controls" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          return `/chats/${chat.id}`
        })
      )
      await page.goto(`${server().url}${path}`)
      const toggle = page.getByRole("button", { name: "Chat panel", exact: true })
      await expect(toggle).toHaveAttribute("aria-pressed", "false")
      await openPanel(page, "This chat")
      const tabs = page.getByRole("tablist", { name: "Chat panel", exact: true })
      await expect(tabs).toBeVisible()
      await expect(page.getByRole("button", { name: "Close the panel", exact: true })).toHaveCount(0)
      if (width >= 1024) {
        const hide = page.getByRole("button", { name: "Hide panel", exact: true })
        await expect(hide).toBeVisible()
        await expect(hide).toHaveAttribute("aria-pressed", "true")
        await expect(hide).toHaveAttribute("aria-expanded", "true")
        const panel = page.getByRole("complementary", { name: "Chat panel", exact: true })
        await expect(panel.locator("[data-window-close]")).toHaveCount(0)
        // With no trailing control, the tab strip gets all of its navigation row's width.
        const spare = await tabs.evaluate((list) => {
          const strip = list.parentElement!.parentElement!
          return strip.parentElement!.clientWidth - strip.clientWidth
        })
        expect(spare).toBeLessThanOrEqual(1)
      } else {
        const sheet = page.getByRole("dialog").filter({ has: tabs })
        await expect(sheet.locator("[data-window-close]")).toHaveCount(1)
        await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeVisible()
      }
      await closePanel(page)
      await expect(toggle).toHaveAttribute("aria-pressed", "false")
      await expect(page).not.toHaveURL(/panel=/)
      if (width === 390) {
        await showAppNavigation(page)
        await expect(
          page.locator("[data-layout-overlay='Mobile navigation drawer covers the page'] [data-window-close]")
        ).toBeVisible()
        await hideAppNavigation(page)
        await openPanel(page, "This chat")
        await page.keyboard.press("Escape")
        await expect(tabs).toHaveCount(0)
      }
    })
  }
}
