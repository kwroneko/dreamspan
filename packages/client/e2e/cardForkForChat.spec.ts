// Synthetic cards and branches only; screenshots cover both widths and themes.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { openPanel, closePanel } from "./support/panel.ts"
import { messageMenu } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const cast = (page: Page) => page.getByRole("list", { name: "Characters in this chat" })
const openCast = async (page: Page) => {
  await openPanel(page, "Cast")
  await expect(cast(page)).toBeVisible()
}
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`fork for chat and branch inheritance at ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Mira ${width} ${theme}`
      const response = await page.request.post(`${server().url}/library/import?name=pilot.json`, {
        data: Buffer.from(
          JSON.stringify({
            spec: "chara_card_v2",
            spec_version: "2.0",
            data: {
              name,
              description: "A harbor pilot who reads the tides.",
              first_mes: "Welcome to the harbor."
            }
          })
        ),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(response.status()).toBe(200)
      const seed = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const card = (yield* api.ListCards()).find((c) => c.name === name)!
          const chat = yield* api.CreateChat({ title: "The lighthouse road" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          let leaf = chat.activeLeafSlotId
          for (let i = 0; i < 4; i++) {
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: leaf,
              branch: false,
              content: `Harbor step ${i + 1}`,
              speakerEntityId: card.entityId,
              reply: false
            })
            if (sent._tag !== "Posted") throw new Error("not posted")
            leaf = sent.entry.slotId
          }
          const other = yield* api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: leaf })
          return { chatId: chat.id, main: chat.currentForkId!, other: other.fork.id }
        })
      )
      const url = `${server().url}/chats/${seed.chatId}?fork=${seed.main}`
      await page.goto(url)
      await openCast(page)
      const shot = async (step: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        if (process.env.CF3_SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.CF3_SCREENSHOTS}/${step}-${width}-${theme}.png`,
            animations: "disabled"
          })
      }
      await expect(cast(page)).toContainText("used by 1 chat")
      await shot("cast")
      await expect(page.getByRole("button", { name: `Fork for this chat: ${name}`, exact: true })).toBeVisible()
      // The card's own tab is also a chat surface, with the same editing scope and actions.
      const details = await openPanel(page, name)
      await shot("card-details")
      await expect(details).toContainText("used by 1 chat")
      await expect(details.getByRole("button", { name: `Edit ${name}`, exact: true })).toBeVisible()
      await expect(details.getByRole("button", { name: `Use another version: ${name}`, exact: true })).toBeVisible()
      await page.getByRole("button", { name: `Fork for this chat: ${name}`, exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Fork for this chat", exact: true })
      await expect(dialog.getByRole("button", { name: "Fork and edit" })).toBeDisabled()
      await shot("fork-dialog")
      await dialog.getByRole("textbox", { name: "Version (shown as subtitle)" }).fill("Storm")
      await dialog.getByRole("textbox", { name: "In-character name" }).fill("Captain Mira")
      await dialog.getByRole("button", { name: "Fork and edit" }).click()
      const rename = page.getByRole("dialog", { name: "Replace the name in past messages?", exact: true })
      await expect(rename.getByRole("button", { name: /^Yes, in all/ })).toHaveCount(0)
      await rename.getByRole("button", { name: /^No\./ }).click()
      await expect(page).toHaveURL(/\/library\/[^/?]+$/)
      await expect(
        page.getByRole("textbox", { name: "Name the model sees (leave empty to use the display name)", exact: true })
      ).toHaveValue("Captain Mira")
      await page.goto(url)
      await openCast(page)
      await expect(cast(page)).toContainText("Storm")
      await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(1)
      await shot("forked-cast")
      await closePanel(page)
      await expect(page.locator("article[data-slot]").first().locator("header")).toContainText(name)
      await openCast(page)
      // Three messages back, using the real message menu: the new branch inherits the swap.
      await closePanel(page)
      await messageMenu(page.locator("article[data-slot]").first(), "Branch from here")
      await openCast(page)
      await expect(cast(page)).toContainText("Storm")
      await page.getByRole("button", { name: `Use another version: ${name}`, exact: true }).click()
      const family = page.getByRole("dialog", { name: "Use another version", exact: true })
      await expect(family.getByRole("list", { name: "Card family" })).toContainText("Storm")
      await shot("family")
      await family.getByRole("button", { name: `${name} · 1 chat`, exact: true }).click()
      await page
        .getByRole("dialog", { name: "Replace the name in past messages?", exact: true })
        .getByRole("button", { name: /^No\./ })
        .click()
      await expect(cast(page)).not.toContainText("Storm")
      // The existing sibling never received the fork, and the original line still has it.
      await page.goto(`${server().url}/chats/${seed.chatId}?fork=${seed.other}`)
      await openCast(page)
      await expect(cast(page)).not.toContainText("Storm")
      await page.goto(url)
      await openCast(page)
      await expect(cast(page)).toContainText("Storm")
    })
  }
