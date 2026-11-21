// A double-click on a message's text opens its edit with the caret where the click landed, in
// the stored text (markdown and all; ui/editCaret.ts), and the caret's line where the clicked
// line was on screen, so the view doesn't jump (ui/holdCaret.ts). A long synthetic message with
// bold, italics, lists and repeated words, and a swipe of the fake generator's markdown reply.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { showActions } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText, textBoxValue } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "160" })

const paragraph = (n: number) =>
  `Paragraph ${n}: the tide comes in over the **grey stones**, and the rope by the quay creaks as the boats knock together. Nobody on the pier looks up.`
const MESSAGE = [
  ...Array.from({ length: 9 }, (_, i) => paragraph(i + 1)),
  "What the keeper keeps:\n\n- a *brass* lantern\n- the rope, tarred twice\n- a ledger of **every cormorant** seen from the light",
  ...Array.from({ length: 5 }, (_, i) => paragraph(i + 10)),
  "Last of all, the rope again: the rope that held the skiff."
].join("\n\n")

/** The place in the viewport of letter `into` of the `nth` rendered occurrence of `word` in `body`. */
const wordPoint = (body: Locator, word: string, nth: number, into: number) =>
  body.evaluate(
    (node, { word, nth, into }) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let seen = 0
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const content = text.textContent!
        for (let at = content.indexOf(word); at >= 0; at = content.indexOf(word, at + 1)) {
          if (seen++ !== nth) continue
          const range = document.createRange()
          range.setStart(text, at)
          range.setEnd(text, at + word.length)
          ;(text.parentElement as HTMLElement).scrollIntoView({ block: "center" })
          const letter = document.createRange()
          letter.setStart(text, at + into)
          letter.setEnd(text, at + into + 1)
          const rect = letter.getBoundingClientRect()
          return { x: rect.left + 1, y: rect.top + rect.height / 2, top: rect.top }
        }
      }
      throw new Error(`no ${word} #${nth}`)
    },
    { word, nth, into }
  )

/** The editor's caret: its offset, and its line's box and the box of the editor's scroller, in the viewport. */
const caretOf = (editor: Locator) =>
  editor.evaluate((element) => {
    const content = element as HTMLElement & {
      cmTile?: {
        root: {
          view: {
            state: { selection: { main: { head: number } } }
            coordsAtPos: (pos: number) => { top: number; bottom: number } | null
            scrollDOM: HTMLElement
          }
        }
      }
    }
    const view = content.cmTile!.root.view
    const head = view.state.selection.main.head
    const line = view.coordsAtPos(head)!
    const box = view.scrollDOM.getBoundingClientRect()
    return { head, line: { top: line.top, bottom: line.bottom }, box: { top: box.top, bottom: box.bottom } }
  })

const settled = (page: Page) =>
  expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })

for (const width of [1440, 390])
  test(`a double-click opens the edit at the clicked word, where it was on screen ${width}`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats`)
    await page.getByLabel("Title of the new chat").fill(`Keeper ${width}`)
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    await replaceEditorText(page.getByLabel("Message", { exact: true }), MESSAGE)
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(1)
    await settled(page)
    const mine = page.getByRole("article", { name: "Your message", exact: true })
    const body = mine.locator(".markdown")
    await expect(body).toContainText("every cormorant")
    const editor = mine.getByRole("textbox", { name: "Message text" })

    const cases = [
      // A bold word in a list deep in the message.
      { word: "cormorant", nth: 0, into: 4, source: MESSAGE.indexOf("cormorant") },
      // A word repeated throughout: the twelfth paragraph's rope, not any other.
      { word: "rope", nth: 12, into: 2, source: MESSAGE.indexOf("rope", MESSAGE.indexOf("Paragraph 12")) }
    ]
    for (const { word, nth, into, source } of cases) {
      const point = await wordPoint(body, word, nth, into)
      await page.mouse.dblclick(point.x, point.y)
      await expect(editor).toBeFocused()
      expect(await textBoxValue(editor)).toBe(MESSAGE)
      // The caret within the word in the stored text.
      await expect.poll(async () => (await caretOf(editor)).head).toBeGreaterThanOrEqual(source)
      const caret = await caretOf(editor)
      expect(caret.head).toBeLessThanOrEqual(source + word.length)
      // In the editor's box and on screen, at the clicked line's height.
      await expect
        .poll(async () => {
          const { line } = await caretOf(editor)
          return Math.abs(line.top - point.top)
        })
        .toBeLessThan(4)
      const { line, box } = await caretOf(editor)
      expect(line.top).toBeGreaterThanOrEqual(box.top - 1)
      expect(line.bottom).toBeLessThanOrEqual(box.bottom + 1)
      // The editor's box (shorter than the screen) entirely on screen around it.
      const viewport = page.viewportSize()!
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.bottom).toBeLessThanOrEqual(viewport.height)
      // Typing goes in at the caret.
      await page.keyboard.type("Q")
      await expect.poll(() => textBoxValue(editor)).toContain("Q")
      const typed = (await textBoxValue(editor)).indexOf("Q")
      expect(typed).toBeGreaterThanOrEqual(source)
      expect(typed).toBeLessThanOrEqual(source + word.length)
      await page.keyboard.press("Backspace")
      await expectLayout(page, test.info(), `edit-caret-${word}-${width}`, {
        scope: 'article[aria-label="Your message"]'
      })
      await mine.getByRole("button", { name: "Cancel" }).click()
      await expect(editor).toHaveCount(0)
    }

    // A reply's second version (a swipe), in the generator's markdown: a word found once in it.
    const reply = page.getByRole("article", { name: "Reply", exact: true })
    await showActions(reply)
    await reply
      .getByRole("group", { name: "Versions", exact: true })
      .getByRole("button", { name: "Generate another version" })
      .click()
    await expect(reply.getByRole("group", { name: "Versions", exact: true })).toContainText("2/2")
    await settled(page)
    const replyBody = reply.locator(".markdown")
    const word = await replyBody.evaluate((node) => {
      const words: string[] = node.textContent!.match(/\p{L}{6,}/gu) ?? []
      const once = words.filter((candidate) => words.indexOf(candidate) === words.lastIndexOf(candidate))
      if (once.length === 0) throw new Error("no word found once")
      return once[Math.floor(once.length / 2)]!
    })
    const point = await wordPoint(replyBody, word, 0, 3)
    await page.mouse.dblclick(point.x, point.y)
    const replyEditor = reply.getByRole("textbox", { name: "Message text" })
    await expect(replyEditor).toBeFocused()
    await expect.poll(async () => Math.abs((await caretOf(replyEditor)).line.top - point.top)).toBeLessThan(4)
    const { head } = await caretOf(replyEditor)
    expect((await textBoxValue(replyEditor)).slice(head - 3, head - 3 + word.length)).toBe(word)
    await reply.getByRole("button", { name: "Cancel" }).click()
    await expect(replyEditor).toHaveCount(0)
  })
