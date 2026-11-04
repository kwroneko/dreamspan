// Synthetic text only. The Snippets panel (owner, 2026-11-01): a plain explanation, snippets as
// blocks (renamed in place, Copy, the text saved as it's typed with no revision until Save), "This
// chat" or "All chats" by a switch, no Insert; transfers from editors' own Send buttons and the
// shortcut (a note, a message and a swipe opened for editing by a double-click), at desktop and
// phone sizes in both themes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import type { ChatId } from "@rp/shared/chat.ts"
import { serverPerFile, withAdmin, apiLogin, ADMIN } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { openPanel, closePanel } from "./support/panel.ts"
import { noteText } from "./support/notes.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { expectTextBox, textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
// One login for the file: polling the server through a login each time meets its rate limit.
let cookie: Promise<string> | null = null
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)

const snippetBlock = (scope: Locator, title: string) => scope.getByRole("region", { name: `Snippet ${title}` })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`snippets ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      for (const old of await admin((api) => api.ListSnippets({ chatId: null })))
        await admin((api) => api.DeleteNote({ noteRefId: old.ref.id }))
      const chat = await admin((api) => api.CreateChat({ title: "The harbour notebook" }))
      const other = await admin((api) => api.CreateChat({ title: "Another harbour" }))
      const chatId = chat.id as ChatId
      await admin((api) => api.CreateChatNote({ chatId, title: "Destination" }))
      await page.goto(`${server().url}/chats/${chat.id}`)

      // With Snippets not shown, a menu chooses; sending keeps the note open; the notice offers the snippet.
      const notes = await openPanel(page, "Notes")
      const content = await noteText(notes, "Destination")
      await content.fill("Lanterns by the harbour")
      await content.press("Control+Home")
      await content.press("Control+Shift+ArrowRight")
      await notes.getByRole("button", { name: "Send selection to snippet" }).click()
      await page.getByRole("menuitem", { name: /^New snippet/ }).click()
      await expect(notes).toBeVisible()
      await expect(content).toBeFocused()
      await page.getByRole("button", { name: "Open", exact: true }).click()
      const panel = page.getByRole("tabpanel", { name: "Snippets" })
      await expect(panel).toBeVisible()
      // What snippets are, said plainly; no Insert (copy and paste does it).
      await expect(panel.getByText(/never sent to the model by itself/)).toBeVisible()
      await expect(panel.getByRole("button", { name: /^Insert/ })).toHaveCount(0)
      const fresh = snippetBlock(panel, "Untitled snippet")
      await expectTextBox(fresh.getByRole("textbox", { name: "Text of Untitled snippet" }), "Lanterns")
      await expect(fresh.getByRole("button", { name: "Collapse Untitled snippet" })).toContainText("This chat")

      // Renamed in place in its header.
      await fresh.getByRole("button", { name: "Rename Untitled snippet" }).click()
      await fresh.getByRole("textbox", { name: "New name for Untitled snippet" }).fill("Harbour details")
      await page.keyboard.press("Enter")
      const block = snippetBlock(panel, "Harbour details")
      const editor = block.getByRole("textbox", { name: "Text of Harbour details" })
      await editor.fill("A lighthouse above the quiet harbour.")
      const listed = async (id: ChatId | null) => (await admin((api) => api.ListSnippets({ chatId: id })))[0]
      await expect.poll(async () => (await listed(chatId))?.content).toBe("A lighthouse above the quiet harbour.")
      await expect.poll(async () => (await listed(chatId))?.title).toBe("Harbour details")
      // Typing is live and makes no revision; Save does.
      const refId = (await listed(chatId))!.ref.id
      expect(await admin((api) => api.ListRevisions({ refId, limit: 10 }))).toHaveLength(1)
      await saveRevision(block)
      expect(await admin((api) => api.ListRevisions({ refId, limit: 10 }))).toHaveLength(2)

      await block.getByRole("button", { name: /^History of / }).click()
      const history = page.getByRole("dialog", { name: /^History: / })
      const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
      await expect(revisions).toHaveCount(2)
      await expect(revisions.first().getByRole("button", { name: "Restore to revision 2", exact: true })).toBeDisabled()
      await revisions
        .first()
        .getByRole("button", { name: /^Revision 2 / })
        .click()
      const change = history.locator("details").filter({ has: page.locator("summary", { hasText: /^Content$/ }) })
      await change.locator("summary").click()
      await expectTextBox(
        change.getByRole("textbox", {
          name: width > 639 ? "Revision 2" : "Changes",
          exact: true
        }),
        "A lighthouse above the quiet harbour."
      )
      await history.getByRole("tab", { name: "Changes from current state", exact: true }).click()
      await expect(
        history
          .getByRole("tabpanel", { name: "Changes from current state", exact: true })
          .getByText("No fields differ.", { exact: true })
      ).toBeVisible()
      await history.getByRole("button", { name: "Close", exact: true }).click()

      // Copy, one click.
      await block.getByRole("button", { name: "Copy Harbour details" }).click()
      await expect(page.getByText("Snippet copied").or(page.getByText(/Couldn't copy the snippet/))).toBeVisible()

      // This chat (every branch of it), or All chats, by its switch.
      expect(await listed(other.id as ChatId)).toBeUndefined()
      await block.getByRole("switch", { name: "All chats" }).click()
      await expect(block.getByRole("button", { name: "Collapse Harbour details" })).toContainText("All chats")
      await expect.poll(async () => (await listed(other.id as ChatId))?.ref.id).toBe(refId)
      await block.getByRole("switch", { name: "All chats" }).click()
      await expect(block.getByRole("button", { name: "Collapse Harbour details" })).toContainText("This chat")
      await expect.poll(async () => await listed(other.id as ChatId)).toBeUndefined()
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: join(shots, `snippets-${width}-${theme}.png`) })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

      // A message opened for editing by a double-click adds its selection to a snippet chosen from the menu.
      await admin((api) =>
        api.SendMessage({ chatId, forkId: null, parentSlotId: null, branch: false, content: "A gull crosses the bay." })
      )
      await page.reload()
      await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
      await closePanel(page)
      const mine = page.getByRole("article", { name: "Your message" })
      // Aim inside "gull": the center of this wide block is blank and can
      // select a paragraph, which deliberately keeps the message out of Edit.
      await mine.locator(".markdown").dblclick({ position: { x: 24, y: 12 } })
      const messageText = mine.getByRole("textbox", { name: "Message text" })
      await expect(messageText).toBeFocused()
      await messageText.press("Control+a")
      await mine.getByRole("button", { name: "Send selection to snippet" }).click()
      await page.getByRole("menuitem", { name: /^New snippet/ }).click()
      await expect
        .poll(async () => (await admin((api) => api.ListSnippets({ chatId }))).map((s) => s.content))
        .toContain("A gull crosses the bay.")
      await expect(messageText).toBeFocused()
      await mine.getByRole("button", { name: "Cancel" }).click()

      // The note's selection, by the shortcut, then its whole text: both chosen from the menu, with Snippets not shown.
      await openPanel(page, "Notes")
      const again = await noteText(notes, "Destination")
      await again.fill("A foghorn sounds.")
      await again.press("Control+Home")
      await again.press("Control+Shift+End")
      await again.press("Control+Shift+S")
      await page.getByRole("menuitem", { name: /^Untitled snippet/ }).click()
      await expect(notes).toBeVisible()
      await expect(again).toBeFocused()
      await page.getByRole("button", { name: "Open", exact: true }).last().click()
      const target = snippetBlock(panel, "Untitled snippet")
      const targetText = target.getByRole("textbox", { name: "Text of Untitled snippet" })
      await expect.poll(() => textBoxValue(targetText)).toContain("A foghorn sounds.")
      await openPanel(page, "Notes")
      await again.fill("A bell rings.")
      await notes.getByRole("button", { name: "Send text to snippet" }).click()
      await page.getByRole("menuitem", { name: /^Untitled snippet/ }).click()
      await expect(notes).toBeVisible()
      await expect(again).toBeFocused()
      await page.getByRole("button", { name: "Open", exact: true }).last().click()
      await expect.poll(() => textBoxValue(targetText)).toContain("A bell rings.")
      // A snippet's own editor offers no sending to a snippet.
      await targetText.click()
      await expect(panel.getByRole("button", { name: /to snippet/ })).toHaveCount(0)
    })
  }

test("a library field creates a snippet for all chats outside a chat", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const item of await admin((api) => api.ListSnippets({ chatId: null })))
    await admin((api) => api.DeleteNote({ noteRefId: item.ref.id }))
  const card = await admin((api) => api.CreateCard({ label: "Synthetic keeper", name: "Keeper" }))
  await page.goto(`${server().url}/library/${card.id}`)
  const description = page.getByRole("textbox", { name: "Description", exact: true })
  await description.fill("A keeper watches the harbour.")
  await description.press("Control+Home")
  await description.press("Control+Shift+End")
  // Selection actions mount after the editor publishes its selection to React.
  await expect(page.getByRole("button", { name: "Send selection to snippet", exact: true })).toBeVisible()
  await description.press("Control+Shift+S")
  // Outside a chat no snippet is open: the shortcut opens the menu at its button.
  await page.getByRole("menuitem", { name: /^New snippet/ }).click()
  await expect(description).toBeFocused()
  await expect(page.getByRole("dialog", { name: "Snippets" })).toHaveCount(0)
  await expectTextBox(description, "A keeper watches the harbour.")
  await page.getByRole("button", { name: "Open", exact: true }).click()
  const sheet = page.getByRole("region", { name: "Snippets" })
  const block = snippetBlock(sheet, "Untitled snippet")
  await expectTextBox(block.getByRole("textbox", { name: "Text of Untitled snippet" }), "A keeper watches the harbour.")
  await expect(block.getByRole("button", { name: "Collapse Untitled snippet" })).toContainText("All chats")
  await expect
    .poll(async () => (await admin((api) => api.ListSnippets({ chatId: null }))).map((snippet) => snippet.content))
    .toEqual(["A keeper watches the harbour."])
})
