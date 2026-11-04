import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
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
      const chat = yield* api.CreateChat({ title: "Harbor" })
      chatId = chat.id
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
    })
  )
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: panel toggle ends saved and pending headers`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      for (const [scene, path] of [
        ["saved", `/chats/${chatId}`],
        ["pending", `/cards/${cardId}/chat`]
      ]) {
        await page.goto(`${server().url}${path}`)
        const header = page.locator("[data-center-header]")
        const toggle = header.getByRole("button", { name: /^(Chat panel|Hide panel)$/ })
        await expect(toggle).toBeVisible()
        if (scene === "saved")
          await expect(header.getByRole("button", { name: "Chat actions", exact: true })).toBeVisible()
        await expect(header.getByRole("button").filter({ visible: true }).last()).toHaveAttribute(
          "aria-label",
          /^(Chat panel|Hide panel)$/
        )
        await page.mouse.move(0, 899)
        await header.screenshot({
          path: join(process.env.LAYOUT_AUDIT_WORK ?? info.outputDir, `${scene}-${width}-${theme}.png`)
        })
        if (process.env.LAYOUT_AUDIT)
          await expectLayout(page, info, `${scene}-${width}-${theme}`, { scope: "[data-center-header]" })
      }
    })
