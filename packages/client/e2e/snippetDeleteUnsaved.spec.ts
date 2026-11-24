// Deleting a snippet with unsaved changes clears every unsaved marker above it at once (owner,
// 2026-11-24): the snippet's own, the Snippets tab's and any other dot on the page, with no reload. Synthetic text only.
import { Effect } from "effect"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)

test("deleting a snippet with unsaved text clears the snippet's, the Snippets tab's and every other marker", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const chat = await withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Unsaved snippet" })
      yield* api.CreateSnippet({ chatId: chat.id, title: "Scratch", content: "Saved text." })
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const panel = await openPanel(page, "Snippets")
  const snippet = panel.getByRole("region", { name: "Snippet Scratch", exact: true })
  await snippet.getByRole("textbox", { name: "Text of Scratch" }).click()
  await page.keyboard.press("End")
  await page.keyboard.type(" Typed, not saved.")
  const tab = page
    .getByRole("complementary", { name: "Chat panel" })
    .getByRole("tab", { name: "Snippets", exact: true })
  await expect(snippet.locator('[data-save-state="unsaved"]')).toBeVisible()
  await expect(tab.locator("[data-unsaved-dot]")).toBeVisible()
  await expect(tab).toHaveAttribute("data-unsaved", "true")

  await snippet.getByRole("button", { name: "Delete Scratch", exact: true }).click()
  await expect(snippet).toHaveCount(0)
  await expect(tab.locator("[data-unsaved-dot]")).toHaveCount(0)
  await expect(tab).not.toHaveAttribute("data-unsaved")
  await expect(page.locator("[data-unsaved-dot]")).toHaveCount(0)
})
