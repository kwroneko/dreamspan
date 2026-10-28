import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
for (const width of [1440, 390])
  test(`history preview, replace and undo at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const [name, ...value] = cookie.split("=")
    await page.context().addCookies([{ name: name!, value: value.join("="), url: server().url }])
    const chat = await withCookie(server(), cookie, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "The lantern garden" })
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Aria stops beside the lanterns. ARIA is written on the garden gate. Aria smiles."
        })
        if (sent._tag !== "Posted") throw new Error("queued")
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: sent.entry.slotId,
          branch: false,
          content: "Aria follows the path to the old observatory."
        })
        return chat
      })
    )
    await page.goto(`${server().url}/chats/${chat.id}?panel=history`)
    const panel = page.getByRole(width === 390 ? "dialog" : "complementary", {
      name: width === 390 ? "The lantern garden" : "Chat panel"
    })
    await expect(page.getByRole("heading", { name: "Search and replace", exact: true })).toBeVisible()
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
    await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("Ari")
    await page.getByLabel("Preserve case", { exact: true }).check()
    await expect(page.getByRole("status").filter({ hasText: "4 in messages" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Replace all", exact: true })).toBeEnabled()
    await mkdir("~/projects/work-folder/2026-10-28/night/fi8/screens", { recursive: true })
    await page.screenshot({
      path: `~/projects/work-folder/2026-10-28/night/fi8/screens/history-${width}.png`,
      fullPage: true
    })
    await page.getByRole("button", { name: "Replace all", exact: true }).click()
    await expect(page.getByText("History replaced", { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "Search and replace", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Undo all", exact: true }).click()
    await expect(page.getByRole("button", { name: "Undo all", exact: true })).toBeDisabled()
    if (width === 1440) {
      await page.keyboard.press("Control+h")
      await expect(page.getByRole("heading", { name: "Search and replace", exact: true })).toBeVisible()
    }
    void panel
  })
