// Adversarial synthetic cards, exercised through the real message renderer and frame CSP.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("card selectors cannot style the app or remove message containment", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "CSS attack" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        reply: false,
        content: [
          "<style>",
          String.raw`@font-face { font-family: "\49 nter"; src: local("FreeMono") }`,
          ".box { color: rgb(1, 2, 3); & > span { color: rgb(4, 5, 6) }",
          ":is(&, body) [data-security-probe] { color: rgb(11, 22, 33) !important }",
          ":is(&, body) [class~=markdown-html] { contain: none !important } }",
          "+ [data-security-probe] { color: rgb(11, 22, 33) !important }",
          "</style>",
          '<div class="box">Card <span>nested</span></div>'
        ].join("\n")
      })
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const box = page.locator(".custom-box")
  await expect(box).toHaveCSS("color", "rgb(1, 2, 3)")
  await expect(box.locator("span").first()).toHaveCSS("color", "rgb(4, 5, 6)")
  await page.evaluate(() => {
    const app = document.createElement("div")
    app.dataset.securityProbe = ""
    app.style.color = "rgb(7, 8, 9)"
    app.textContent = "App outside the message"
    document.querySelector(".message-html")!.after(app)
  })
  await expect(page.locator("[data-security-probe]")).toHaveCSS("color", "rgb(7, 8, 9)")
  await expect(page.locator(".message-html")).toHaveCSS("contain", "layout paint")
  expect(await page.evaluate(() => Array.from(document.fonts, (font) => font.family))).not.toContain("Inter")
})
