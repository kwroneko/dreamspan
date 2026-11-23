// Text the browser's way (owner, 2026-11-01): the browser's own context menu over message text
// and editors, copying a message's text from a selection, Send to snippet in the editor's own
// chrome (its selection button comes and goes with the selection), a double-click opening a
// message for editing without taking triple-click or drag selection, and no Regenerate in the
// toolbar, where the version arrows' › generates another. Synthetic text, fake generator.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { showActions } from "./support/message.ts"
import { closePanel } from "./support/panel.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { textBoxValue } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })
const shots = process.env.SCREENSHOT_DIR

const settled = (page: Page) =>
  expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
const versions = (message: Locator) => message.getByRole("group", { name: "Swipes", exact: true })

/** Whether a contextmenu event over `target` was cancelled: the browser's menu would not open. */
const menuPrevented = (target: Locator) =>
  target.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + 4,
      clientY: rect.top + 4
    })
    node.dispatchEvent(event)
    return event.defaultPrevented
  })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`text works the browser's way ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(90_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats`)
      await page.getByLabel("Title of the new chat").fill(`Lighthouse ${width} ${theme}`)
      await page.getByRole("button", { name: "New chat", exact: true }).click()
      await page.getByLabel("Message", { exact: true }).fill("The lantern swings over the quay.")
      await page.getByRole("button", { name: "Send", exact: true }).click()
      const reply = page.getByRole("article", { name: "Reply", exact: true })
      await expect(reply).toHaveCount(1)
      await settled(page)
      const mine = page.getByRole("article", { name: "Your message", exact: true })
      const body = mine.locator(".markdown")

      // The browser's menu over message text and the composer.
      expect(await menuPrevented(body)).toBe(false)
      expect(await menuPrevented(reply.locator(".markdown"))).toBe(false)
      expect(await menuPrevented(page.getByLabel("Message", { exact: true }))).toBe(false)

      // A drag selects for copying, and the copy is the message's text; it opens no editor.
      // The summary band above the messages arrives a moment after the reply (it is 54 px tall and
      // moves everything below it); a drag measured before it would start in the wrong place.
      await expect(page.getByText(/^Older messages/)).toBeVisible()
      const box = (await body.boundingBox())!
      await page.mouse.move(box.x + 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 })
      await page.mouse.up()
      const copied = await page.evaluate(() => {
        const data = new DataTransfer()
        document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }))
        return data.getData("text/plain")
      })
      expect(copied.length).toBeGreaterThan(10)
      expect("The lantern swings over the quay.").toContain(copied.trim())
      // A triple-click selects the paragraph, and doesn't open the editor either.
      await body.click({ clickCount: 3 })
      await page.waitForTimeout(600)
      await expect(mine.getByRole("textbox", { name: "Message text" })).toHaveCount(0)
      expect(await page.evaluate(() => window.getSelection()!.toString().trim())).toBe(
        "The lantern swings over the quay."
      )
      // A double-click on a control isn't one on the message.
      await showActions(reply)
      await versions(reply).getByRole("button", { name: "Generate another swipe" }).dispatchEvent("dblclick")
      await page.waitForTimeout(600)
      await expect(reply.getByRole("textbox", { name: "Message text" })).toHaveCount(0)

      // No ↻ in the toolbar: the latest reply's › shows without a hover and generates.
      await showActions(reply)
      const toolbar = reply.getByRole("toolbar", { name: "Message actions" })
      await expect(toolbar.getByRole("button", { name: "Edit" })).toBeVisible()
      await expect(toolbar.getByRole("button", { name: /Regenerate/ })).toHaveCount(0)
      await expect(reply.getByRole("button", { name: /Regenerate/ })).toHaveCount(0)
      await versions(reply).getByRole("button", { name: "Generate another swipe" }).click()
      await expect(versions(reply)).toContainText("2/2")
      await settled(page)
      // ArrowRight outside inputs still generates past the last reply's last version.
      await page.locator("body").click({ position: { x: 1, y: 1 } })
      await page.keyboard.press("ArrowRight")
      await expect(versions(reply)).toContainText("3/3")
      await settled(page)

      // A double-click on a word opens the message's Edit, focused, with the caret there.
      const word = await body.evaluate((node) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        let text = walker.nextNode()
        while (text && !text.textContent!.includes("swings")) text = walker.nextNode()
        if (!text) throw new Error("no word to click")
        const range = document.createRange()
        const at = text.textContent!.indexOf("swings")
        range.setStart(text, at + 2)
        range.setEnd(text, at + 3)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + 1, y: rect.top + rect.height / 2 }
      })
      await page.mouse.dblclick(word.x, word.y)
      const editor = mine.getByRole("textbox", { name: "Message text" })
      await expect(editor).toBeFocused()
      await page.keyboard.type("Q")
      await expect(editor).toContainText("Q")
      expect((await editor.textContent())!.indexOf("Q")).toBeGreaterThanOrEqual("The lantern s".length)
      expect((await editor.textContent())!.indexOf("Q")).toBeLessThanOrEqual("The lantern swings".length)
      await page.keyboard.press("Backspace")
      expect(await menuPrevented(editor)).toBe(false)

      // The editor's own Send buttons: the whole text's, and the selection's only while it lasts.
      const sendText = mine.getByRole("button", { name: "Send text to snippet" })
      const sendSelection = mine.getByRole("button", { name: "Send selection to snippet" })
      await expect(sendText).toBeVisible()
      await expect(sendSelection).toHaveCount(0)
      await editor.press("Control+End")
      await editor.press("Control+Shift+ArrowLeft")
      await editor.press("Shift+ArrowLeft")
      await expect(sendSelection).toBeVisible()
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await mine.screenshot({ path: join(shots, `editor-selection-${width}-${theme}.png`) })
      }
      await editor.press("ArrowRight")
      await expect(sendSelection).toHaveCount(0)
      await expect(sendText).toBeVisible()
      for (let i = 0; i < 5; i++) await editor.press("Shift+ArrowLeft")
      await expect(sendSelection).toBeVisible()
      // Left for another box, the editor keeps its selection unseen: its button goes too.
      await page.getByLabel("Message", { exact: true }).focus()
      await expect(sendSelection).toHaveCount(0)
      await editor.focus()
      await editor.press("End")
      for (let i = 0; i < 5; i++) await editor.press("Shift+ArrowLeft")
      await expect(sendSelection).toBeVisible()
      // No snippet shown: a menu at the button chooses where it goes.
      await sendSelection.click()
      await page.getByRole("menuitem", { name: /^New snippet/ }).click()
      await expect(editor).toBeFocused()
      await page.getByRole("button", { name: "Open", exact: true }).click()
      const snippetText = page.getByRole("textbox", { name: "Text of Untitled snippet" })
      await expect.poll(() => textBoxValue(snippetText)).toBe("quay.")
      await closePanel(page)
      await editor.focus()
      await sendText.click()
      await page.getByRole("menuitem", { name: /^Untitled snippet/ }).click()
      await expect(editor).toBeFocused()
      await page.getByRole("button", { name: "Open", exact: true }).last().click()
      await expect.poll(() => textBoxValue(snippetText)).toContain("The lantern swings over the quay.")
      await closePanel(page)
      await mine.getByRole("button", { name: "Cancel" }).click()
      await expect(editor).toHaveCount(0)
    })

// A prose text box (ui/Field.tsx's Textarea with `textActions`) has the same actions, in the strip
// inside its border (ui/FieldFrame.tsx; owner, 2026-11-02), only while it has focus or a
// selection; the strip keeps its room either way, so the box never changes size. Its selection's
// button shows only while it has a selection and focus, since a box left keeps its selection
// unseen. A box of patterns (a regex script's lines) has none (owner, 2026-11-01).
for (const width of [1440, 390])
  test(`a text box's bar keeps its controls, and appears only under prose ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/regex`)
    await page.getByRole("button", { name: "Add a script", exact: true }).click()
    const item = page.getByRole("list", { name: "Global regex scripts" }).getByRole("listitem").last()
    const lines = item.getByRole("textbox", { name: /^Remove from each match/ })
    await lines.fill("alpha\nbeta")
    await expect(lines).toBeFocused()
    await expect(item.getByRole("toolbar", { name: "Text actions" })).toHaveCount(0)

    await page.goto(`${server().url}/settings/chats`)
    const box = page.getByRole("textbox", { name: "Summarization instruction", exact: true })
    await expect(box).toBeEditable()
    const bar = page.locator("[data-field-frame]").filter({ has: box })
    const toolbar = bar.getByRole("toolbar", { name: "Text actions" })
    const sendSelection = bar.getByRole("button", { name: "Send selection to snippet" })
    // Controls keep their places while the frame hides its idle strip by opacity.
    await expect(toolbar).toHaveCount(1)
    const size = async () => {
      const { width, height } = (await bar.boundingBox())!
      return { width, height }
    }
    const idle = await size()
    // Where the box sits in what holds it: the page may scroll to it, but nothing above it moves.
    const field = bar.locator("..")
    const offset = async () => (await box.boundingBox())!.y - (await field.boundingBox())!.y
    const top = await offset()
    await box.fill("alpha\nbeta")
    // They come in the strip, under the text: neither the text nor the box moves or grows.
    await expect(bar.getByRole("button", { name: "Send text to snippet" })).toBeVisible()
    const shown = (await box.boundingBox())!
    expect(await offset()).toBe(top)
    expect(await size()).toEqual(idle)
    expect((await toolbar.boundingBox())!.y).toBeGreaterThanOrEqual(shown.y + shown.height - 1)
    await expect(sendSelection).toHaveCount(0)
    for (let i = 0; i < 4; i++) await box.press("Shift+ArrowLeft")
    await expect(sendSelection).toBeVisible()
    await box.blur()
    await expect(toolbar).toHaveCount(1)
    await box.focus()
    await expect(sendSelection).toBeVisible()
    await box.press("ArrowRight")
    await expect(sendSelection).toHaveCount(0)
    await expect(bar.getByRole("button", { name: "Send text to snippet" })).toBeVisible()
  })
