import { writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`new chat from character list: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Mira ${width} ${theme}`
      const card = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: name, name }))
      const companion = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.CreateCard({ label: `Companion ${width} ${theme}`, name: "Companion" })
      )
      const group = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.StartChat({
          cards: [card.entityId, companion.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A group conversation.", speakerEntityId: null }
        })
      )
      const old = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "An earlier conversation.", speakerEntityId: null }
        })
      )
      await page.goto(server().url)
      await page
        .getByRole("main")
        .getByRole("button", { name: `Open ${name}`, exact: true })
        .click()
      await expect(page).toHaveURL(new RegExp(`/chats/${old.chat.id}`))
      if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
      await showAppNavigation(page)
      const selector = width === 390 ? ".fixed.inset-0 > div" : 'aside[aria-label="Sidebar"]'
      const panel = page.locator(selector)
      await expect(panel.getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText(name)
      if (process.env.CHARNEWCHAT_BEFORE) {
        await panel.screenshot({ path: info.outputPath("left-before.png") })
        return
      }
      await expect(panel.locator(`[data-chat-id="${group.chat.id}"]`)).toBeVisible()
      const action = panel.getByRole("button", { name: `New chat with ${name}`, exact: true })
      await expect(action).toBeVisible()
      const findings = await expectLayout(page, info, "left-character-chats", { scope: selector })
      writeFileSync(info.outputPath("left-layout.json"), JSON.stringify(findings, null, 2))
      await panel.screenshot({ path: info.outputPath("left-after.png") })
      await action.hover()
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
        `Starts a separate chat with ${name}.`
      )
      await action.click()
      await expect(page).toHaveURL(new RegExp(`/cards/${card.entityId}/chat`))
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
      const content = `A new beginning at ${width} in ${theme}.`
      await page.getByRole("textbox", { name: "Message", exact: true }).fill(content)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page).toHaveURL(/\/chats\//)
      expect(new URL(page.url()).pathname).not.toBe(`/chats/${old.chat.id}`)
      await expect(page.getByText(content, { exact: true })).toBeVisible()
      // A group/chat scope (also with a retained character breadcrumb) is a branch list.
      for (const query of [`forks=${group.chat.id}`, `forks=${group.chat.id}&character=${card.entityId}`, ""]) {
        await page.goto(`${server().url}/?side=chats&${query}`)
        await showAppNavigation(page)
        await expect(panel.getByRole("button", { name: /^New chat with / })).toHaveCount(0)
      }
    })
  }
}
