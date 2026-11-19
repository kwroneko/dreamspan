import { expect, test } from "@playwright/test"
import { Effect, Schema } from "effect"
import { SummaryId } from "@dreamspan/shared/lcm.ts"
import { level1 } from "./support/summaries.ts"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
for (const width of [1440, 1024, 390])
  for (const theme of ["light", "dark"] as const)
    test(`history preview, replace and undo at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
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
      await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
      await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("Ari")
      await page.getByLabel("Preserve case", { exact: true }).check()
      await expect(page.getByRole("status").filter({ hasText: "4 in messages" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Replace all", exact: true })).toBeEnabled()
      if (process.env.REVIEW_SCREENSHOTS) {
        await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true })
        await panel.screenshot({
          path: join(process.env.REVIEW_SCREENSHOTS, `history-${width}-${theme}.png`)
        })
      }
      if (width === 1440) {
        const inline = page
          .getByRole("article", { name: "Your message", exact: true })
          .getByLabel("Replacement preview")
        await expect(inline).toHaveCount(2)
        await page.getByLabel("Skip match 1 in message 1", { exact: true }).check()
        await expect(inline.first().locator("del")).toHaveCount(2)
        await page.getByLabel("Skip match 1 in message 1", { exact: true }).uncheck()
        await expect(inline.first().locator("del")).toHaveCount(3)
        await page.getByRole("button", { name: "Hide panel", exact: true }).click()
        await expect(inline).toHaveCount(0)
        await page.keyboard.press("Control+h")
        await page.getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
        await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("Ari")
        await page.getByLabel("Preserve case", { exact: true }).check()
        await expect(page.getByRole("button", { name: "Replace all", exact: true })).toBeEnabled()
      }
      await page.getByRole("button", { name: "Replace all", exact: true }).click()
      await expect(page.getByText("History replaced", { exact: true })).toBeVisible()
      await page.reload()
      await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Undo all", exact: true }).click()
      await expect(page.getByRole("button", { name: "Undo all", exact: true })).toBeDisabled()
      if (width === 1440) {
        await page.keyboard.press("Control+h")
        await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
      }
      await expect(panel).toBeVisible()
    })

for (const width of [1440, 1024, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a summary item can be undone without undoing its message at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const [name, ...value] = cookie.split("=")
      await page.context().addCookies([{ name: name!, value: value.join("="), url: server().url }])
      const { chat, entry } = await withCookie(server(), cookie, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Summary undo" })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Aria in the garden."
          })
          if (sent._tag !== "Posted") throw new Error("queued")
          return { chat, entry: sent.entry }
        })
      )
      const summary = await level1(server().dataDir, chat.id, [entry], "Aria remembers the garden.")
      await page.goto(`${server().url}/chats/${chat.id}?panel=history`)
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
      await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("Ari")
      await expect(page.getByRole("status").filter({ hasText: "1 in summaries" })).toBeVisible()
      await page.getByRole("button", { name: "Replace all", exact: true }).click()
      const item = page.locator("details").filter({ has: page.locator("summary", { hasText: "Summary ·" }) })
      await item.locator("summary").click()
      if (process.env.REVIEW_SCREENSHOTS) {
        await expect(page.getByText("History replaced", { exact: true })).toHaveCount(0)
        await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true })
        await item.getByRole("button", { name: "Undo this summary", exact: true }).scrollIntoViewIfNeeded()
        await page
          .getByRole(width === 390 ? "dialog" : "complementary", {
            name: width === 390 ? "Summary undo" : "Chat panel"
          })
          .screenshot({
            path: join(process.env.REVIEW_SCREENSHOTS, `history-summary-${width}-${theme}.png`)
          })
      }
      await item.getByRole("button", { name: "Undo this summary", exact: true }).click()
      await expect(item.locator("summary")).toContainText("undone or changed")
      await expect(item.getByRole("button", { name: "Undo this summary", exact: true })).toBeDisabled()
      const texts = await withCookie(server(), cookie, (api) =>
        Effect.gen(function* () {
          const messages = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: entry.slotId,
            range: { _tag: "Bottom" },
            limit: 100
          })
          const result = yield* api.GetSummary({ summaryId: Schema.decodeUnknownSync(SummaryId)(summary.id) })
          return { message: messages.entries[0]!.version.content, summary: result.content }
        })
      )
      expect(texts).toEqual({ message: "Ari in the garden.", summary: "Aria remembers the garden." })
    })
