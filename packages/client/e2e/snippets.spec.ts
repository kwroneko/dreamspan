// Synthetic text only. Covers transfers from inputs, code editors, messages and swipes,
// continuous persistence and cross-tab updates, at desktop/phone sizes in both themes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { ChatId } from "@rp/shared/chat.ts"
import { serverPerFile, withAdmin, apiLogin, ADMIN } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { openPanel, closePanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`snippet transfers ${width} ${theme}`, async ({ page, context }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const oldGlobals = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.ListSnippets({ chatId: null, forkId: null })
      )
      for (const old of oldGlobals)
        await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.DeleteNote({ noteRefId: old.ref.id }))

      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.CreateChat({ title: "The harbour notebook" })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      const composer = page.getByLabel("Message", { exact: true })
      await composer.fill("Lanterns by the harbour")
      await composer.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 8))
      await composer.press("Control+Shift+S")
      const panel = page.getByRole("tabpanel", { name: "Snippets" })
      await expect(panel).toBeVisible()
      const editor = panel.getByRole("textbox", { name: "Snippet text" })
      await expect(editor).toHaveText("Lanterns")
      await panel.getByLabel("Snippet name").fill("Harbour details")
      await editor.fill("A lighthouse above the quiet harbour.")
      await expect
        .poll(
          async () =>
            (
              await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
                api.ListSnippets({ chatId: chat.id, forkId: null })
              )
            )[0]?.content
        )
        .toBe("A lighthouse above the quiet harbour.")
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: join(shots, `snippets-${width}-${theme}.png`) })
      }
      await closePanel(page)
      await composer.fill("Before. After.")
      await composer.evaluate((node: HTMLTextAreaElement) => {
        node.focus()
        node.setSelectionRange(8, 8)
        node.dispatchEvent(new Event("select", { bubbles: true }))
      })
      await openPanel(page, "Snippets")
      await panel.getByRole("button", { name: "Insert", exact: true }).click()
      if (width === 390) await closePanel(page)
      await expect(composer).toHaveValue("Before. A lighthouse above the quiet harbour.After.")
      if (width === 390) await openPanel(page, "Snippets")
      // CodeMirror selections transfer only the selected part back to the last field.
      await editor.click()
      await editor.press("Control+Home")
      await editor.press("Control+Shift+ArrowRight")
      await panel.getByRole("button", { name: "Insert selection" }).click()
      if (width === 390) await closePanel(page)
      await expect(composer).toHaveValue("Before. A lighthouse above the quiet harbour.AAfter.")
      if (width === 390) await openPanel(page, "Snippets")
      await panel.getByRole("button", { name: "Make global" }).click()
      await expect(panel.getByRole("list", { name: "Snippets" })).toContainText("Global")
      // Another tab reads, then receives the next draft while open.
      const other = await context.newPage()
      await other.goto(`${server().url}/chats/${chat.id}?panel=snippets`)
      await expect(other.getByRole("textbox", { name: "Snippet text" })).toHaveText(
        "A lighthouse above the quiet harbour."
      )
      await editor.fill("The tide is rising.")
      await expect(other.getByRole("textbox", { name: "Snippet text" })).toHaveText("The tide is rising.")
      await other.close()
      await page.reload()
      await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
      await expect(page.getByRole("textbox", { name: "Snippet text" })).toHaveText("The tide is rising.")
      // A selected passage in a rendered message (any swipe's displayed body) uses the same command.
      const chatId = chat.id as ChatId
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SendMessage({ chatId, forkId: null, parentSlotId: null, branch: false, content: "A gull crosses the bay." })
      )
      await page.reload()
      await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
      await closePanel(page)
      const body = page.getByRole("article", { name: "Your message" }).locator(".markdown")
      await body.evaluate((node) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const selected = window.getSelection()!
        selected.removeAllRanges()
        selected.addRange(range)
      })
      await body.click({ button: "right" })
      await page.getByRole("menuitem", { name: "Send to snippet" }).click()
      await expect(page.getByRole("textbox", { name: "Snippet text" })).toContainText("A gull crosses the bay.")
      // Code-editor destinations keep their cursor while another panel is active.
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.CreateChatNote({ chatId, title: "Destination" })
      )
      const notes = await openPanel(page, "Notes")
      await notes.getByRole("button", { name: /Destination/ }).click()
      const content = notes.getByRole("textbox", { name: "Content", exact: true })
      await content.fill("Start End")
      await content.press("Control+Home")
      await content.press("ArrowRight")
      await openPanel(page, "Snippets")
      await panel.getByRole("button", { name: "Insert", exact: true }).click()
      await openPanel(page, "Notes")
      await expect(content).toContainText("SThe tide is rising.")
      // Select a different swipe, then send its displayed passage to the same snippet.
      const path = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.ReadPath({ chatId, forkId: null, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      )
      const entry = path.entries[0]!
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.WriteVersion({
          slotId: entry.slotId,
          content: "A second gull in an alternate version.",
          expectedRowVersion: entry.rowVersion
        })
      )
      await page.reload()
      await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
      await closePanel(page)
      const swipe = page.getByRole("article", { name: "Your message" }).locator(".markdown")
      await swipe.evaluate((node) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const selected = window.getSelection()!
        selected.removeAllRanges()
        selected.addRange(range)
      })
      await page.keyboard.press("Control+Shift+S")
      await expect(page.getByRole("textbox", { name: "Snippet text" })).toContainText(
        "A second gull in an alternate version."
      )
    })
  }
