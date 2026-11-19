// Independent chat settings, their existing destinations, and persistence at both widths/themes.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { stCardV2 } from "../../server/test/formats/support.ts"
import { openPanel } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`chat settings at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const card = stCardV2()
      const imported = await page.request.post(`${server().url}/library/import?name=synthetic.json`, {
        data: Buffer.from(JSON.stringify(card)),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(imported.status()).toBe(200)
      const entityId = (await imported.json()).library.ref.entityId as EntityId
      const { chat, slotId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.map(
          api.StartChat({
            cards: [entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "The lamp is lit.", speakerEntityId: null }
          }),
          (r) => ({ chat: r.chat, slotId: r.entry.slotId })
        )
      )
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const read = () =>
        withCookie(server(), cookie, (api) => api.GetCast({ chatId: chat.id, slotId, forkId: chat.currentForkId }))
      await page.goto(`${server().url}/chats/${chat.id}`)
      let settings = await openPanel(page, "This chat")
      await expect(settings.getByRole("combobox", { name: "Reply mode" })).toHaveCount(0)
      await expect(
        settings.getByRole("radiogroup", { name: "Context" }).getByRole("radio", { name: /^One shared context/ })
      ).toBeChecked()
      const tools = () => settings.getByRole("switch", { name: "Tools", exact: true })
      const swap = () => settings.getByRole("switch", { name: /^Card swap/ })
      await expect(tools()).not.toBeChecked()
      await expect(swap()).not.toBeChecked()
      const audit = async (name: string) => {
        await expectLayout(page, info, name, { scope: '[role="tabpanel"][aria-label="This chat"]' })
        if (process.env.SCREENSHOT_DIR) {
          mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
          await settings.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, `${name}-${width}-${theme}.png`) })
        }
      }
      await audit("settings-default")
      // Card swap without tools; tools with Card swap; tools without Card swap.
      await swap().click()
      await expect.poll(async () => (await read()).cardsRotation).toBe(true)
      await expect(tools()).not.toBeChecked()
      await tools().click()
      const search = () => settings.getByRole("checkbox", { name: "Search the chat's earlier messages", exact: true })
      await expect(search()).toBeChecked()
      await search().click()
      await expect(search()).not.toBeChecked()
      await expect.poll(async () => (await read()).agentTools?.includes("search_chat")).toBe(false)
      await audit("settings-tools-swap")
      await swap().click()
      await expect.poll(async () => (await read()).cardsRotation ?? false).toBe(false)
      await expect(tools()).toBeChecked()
      // Turning tools off keeps the allowed list, and the choices survive a reload.
      await tools().click()
      await expect.poll(async () => (await read()).agentEnabled).toBe(false)
      await page.reload()
      settings = await openPanel(page, "This chat")
      await expect(tools()).not.toBeChecked()
      await expect(swap()).not.toBeChecked()
      await tools().click()
      await expect(search()).not.toBeChecked()
      await expect(settings.getByRole("link", { name: "Decision connections" })).toHaveAttribute(
        "href",
        "/settings/connections"
      )
      await settings.getByRole("button", { name: "Choose next reply", exact: true }).click()
      const picker = page.getByRole("dialog", { name: "Who replies next", exact: true })
      await expect(picker).toBeVisible()
      await expect(picker.getByRole("radio", { name: /^Auto/ })).toBeVisible()
      await expect(picker.getByRole("radio", { name: "No one", exact: true })).toBeVisible()
      await expect(
        picker.getByRole("radio", { name: `${card.data.name} · ${card.data.character_version}`, exact: true })
      ).toBeVisible()
      await page.keyboard.press("Escape")
      settings = await openPanel(page, "This chat")
      await settings.getByRole("link", { name: "Decision connections" }).click()
      await expect(page).toHaveURL(/\/settings\/connections/)
    })
  }
