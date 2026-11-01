// Synthetic text only. Covers transfers from editors' own Send buttons and shortcut (a note,
// a message and a swipe opened for editing by a double-click), Insert,
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
      const chatId = chat.id as ChatId
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.CreateChatNote({ chatId, title: "Destination" })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      const composer = page.getByLabel("Message", { exact: true })
      // An editor's selection goes to a new snippet with the button under the editor.
      const notes = await openPanel(page, "Notes")
      await notes.getByRole("button", { name: /Destination/ }).click()
      const content = notes.getByRole("textbox", { name: "Content", exact: true })
      await content.fill("Lanterns by the harbour")
      await content.press("Control+Home")
      await content.press("Control+Shift+ArrowRight")
      await notes.getByRole("button", { name: "Send selection to snippet" }).click()
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
      // A message opened for editing by a double-click sends its selection the same way.
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SendMessage({ chatId, forkId: null, parentSlotId: null, branch: false, content: "A gull crosses the bay." })
      )
      await page.reload()
      await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
      await closePanel(page)
      const mine = page.getByRole("article", { name: "Your message" })
      await mine.locator(".markdown").dblclick()
      const messageText = mine.getByRole("textbox", { name: "Message text" })
      await expect(messageText).toBeFocused()
      await messageText.press("Control+a")
      await mine.getByRole("button", { name: "Send selection to snippet" }).click()
      await expect(page.getByRole("textbox", { name: "Snippet text" })).toContainText("A gull crosses the bay.")
      if (width === 390) await closePanel(page)
      await mine.getByRole("button", { name: "Cancel" }).click()
      // Code-editor destinations keep their cursor while another panel is active.
      await openPanel(page, "Notes")
      await notes.getByRole("button", { name: /Destination/ }).click()
      await content.fill("Start End")
      await content.press("Control+Home")
      await content.press("ArrowRight")
      await openPanel(page, "Snippets")
      await panel.getByRole("button", { name: "Insert", exact: true }).click()
      await openPanel(page, "Notes")
      await expect(content).toContainText("SThe tide is rising.")
      // The selection's button has a shortcut in its tooltip; the whole text has its own button.
      await content.fill("A foghorn sounds.")
      await content.press("Control+Home")
      await content.press("Control+Shift+End")
      await content.press("Control+Shift+S")
      await expect(editor).toContainText("A foghorn sounds.")
      await openPanel(page, "Notes")
      await content.fill("A bell rings.")
      await notes.getByRole("button", { name: "Send text to snippet" }).click()
      await expect(editor).toContainText("A bell rings.")
      // A different swipe, opened for editing, sends its whole text to the same snippet.
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
      await mine.locator(".markdown").dblclick()
      await expect(messageText).toBeFocused()
      await mine.getByRole("button", { name: "Send text to snippet" }).click()
      await expect(page.getByRole("textbox", { name: "Snippet text" })).toContainText(
        "A second gull in an alternate version."
      )
    })
  }

test("a library field creates a global snippet outside a chat", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const globals = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListSnippets({ chatId: null, forkId: null })
  )
  for (const item of globals)
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.DeleteNote({ noteRefId: item.ref.id }))
  const card = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Synthetic keeper", name: "Keeper" })
  )
  await page.goto(`${server().url}/library/${card.id}`)
  const description = page.getByRole("textbox", { name: "Description", exact: true })
  await description.fill("A keeper watches the harbour.")
  await description.press("Control+Home")
  await description.press("Control+Shift+End")
  await description.press("Control+Shift+S")
  const workspace = page.getByRole("region", { name: "Snippet workspace" })
  await expect(workspace.getByRole("textbox", { name: "Snippet text" })).toHaveText("A keeper watches the harbour.")
  await expect(workspace.getByRole("list", { name: "Snippets" })).toContainText("Global")
  await expect
    .poll(async () =>
      (
        await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListSnippets({ chatId: null, forkId: null }))
      ).map((snippet) => snippet.content)
    )
    .toEqual(["A keeper watches the harbour."])
})
