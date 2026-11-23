// A double-click on a message's text opens its edit with the caret where the click landed, in
// the stored text (markdown and all; ui/editCaret.ts), and the caret's line where the clicked
// line was on screen, so the view doesn't jump (ui/holdCaret.ts). A long synthetic message with
// bold, italics, lists and repeated words, and a swipe of the fake generator's markdown reply.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { showActions } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText, textBoxValue } from "./support/textbox.ts"

// The generator's prose is fixed: a line, a list, a quote and two paragraphs. Up to the quote the
// reply's stored text wraps as its rendered text does, at both widths. From there it may not: the
// quote's border narrows its rendered lines, as a list's indent, a table's rows or the marks of
// italics and bold can elsewhere, and an edit as tall as the text can scroll the clicked line only
// so far back to its place (ui/holdCaret.ts).
const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "400",
  FAKE_GENERATOR_TOKENS: "160",
  FAKE_GENERATOR_SEED: "10"
})

const paragraph = (n: number) =>
  `Paragraph ${n}: the tide comes in over the **grey stones**, and the rope by the quay creaks as the boats knock together. Nobody on the pier looks up.`
const MESSAGE = [
  ...Array.from({ length: 9 }, (_, i) => paragraph(i + 1)),
  "What the keeper keeps:\n\n- a *brass* lantern\n- the rope, tarred twice\n- a ledger of **every cormorant** seen from the light",
  ...Array.from({ length: 5 }, (_, i) => paragraph(i + 10)),
  "Last of all, the rope again: the rope that held the skiff."
].join("\n\n")

/**
 * The place in the viewport of letter `into` of the `nth` rendered occurrence of `word` in `body`,
 * scrolled to the middle of the screen. Read once the list has stopped moving, and on the word: the
 * list measures the rows that came into view and adjusts its scroll over the next frames (after a
 * reply, back to its end), so a place read at once is where the word no longer is, and a
 * double-click there lands a line or more away, or off the message.
 */
const wordPoint = (body: Locator, word: string, nth: number, into: number) =>
  body.evaluate(
    async (node, { word, nth, into }) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let seen = 0
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const content = text.textContent!
        for (let at = content.indexOf(word); at >= 0; at = content.indexOf(word, at + 1)) {
          if (seen++ !== nth) continue
          const letter = document.createRange()
          letter.setStart(text, at + into)
          letter.setEnd(text, at + into + 1)
          const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
          for (let attempt = 0; attempt < 10; attempt++) {
            ;(text.parentElement as HTMLElement).scrollIntoView({ block: "center" })
            let rect = letter.getBoundingClientRect()
            for (let still = 0; still < 6;) {
              await frame()
              const next = letter.getBoundingClientRect()
              still = next.top === rect.top && next.left === rect.left ? still + 1 : 0
              rect = next
            }
            const point = { x: rect.left + 1, y: rect.top + rect.height / 2, top: rect.top }
            if (document.caretPositionFromPoint(point.x, point.y)?.offsetNode === text) return point
          }
          throw new Error(`${word} #${nth} doesn't stay on screen`)
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

/** The message's top and height in the viewport. */
const placeOf = (message: Locator) =>
  message.evaluate((article) => {
    const { top, height } = article.getBoundingClientRect()
    return { top, height }
  })

/** `placeOf` once the list has stopped adjusting (it measures rows that came into view). */
const settledPlace = async (message: Locator) => {
  let last = await placeOf(message)
  for (let still = 0; still < 6;) {
    await message.page().evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    const next = await placeOf(message)
    still = JSON.stringify(next) === JSON.stringify(last) ? still + 1 : 0
    last = next
  }
  return last
}

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
      const before = await settledPlace(mine)
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
      // The edit opened in the text's place, as tall as the text: the message stayed where it was
      // on screen (seamlessEdit.spec.ts measures the list's scroll and the messages around it).
      const after = await settledPlace(mine)
      expect(Math.abs(after.top - before.top)).toBeLessThan(0.5)
      expect(Math.abs(after.height - before.height)).toBeLessThan(0.5)
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

    // A reply's second version (a swipe), in the generator's markdown: a word found once in it, in
    // the paragraphs and list before its quote (see `server`).
    const reply = page.getByRole("article", { name: "Reply", exact: true })
    await showActions(reply)
    await reply
      .getByRole("group", { name: "Swipes", exact: true })
      .getByRole("button", { name: "Generate another swipe" })
      .click()
    await expect(reply.getByRole("group", { name: "Swipes", exact: true })).toContainText("2/2")
    await settled(page)
    const replyBody = reply.locator(".markdown")
    const word = await replyBody.evaluate((node) => {
      const words = (text: string | null): string[] => text?.match(/\p{L}{6,}/gu) ?? []
      const all = words(node.textContent)
      const blocks = [...node.children]
      const quote = blocks.findIndex((block) => !/^(P|UL|OL)$/.test(block.tagName))
      if (quote < 0) throw new Error("no quote in the reply")
      const before = blocks.slice(0, quote).flatMap((block) => words(block.textContent))
      const once = before.filter((candidate) => all.indexOf(candidate) === all.lastIndexOf(candidate))
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

// A double-click begun on the plain text shown while the message's renderer loads, and finished
// on the rendered text that replaced it (a slow phone): the edit opens at the word first pressed.
test("a double-click across the renderer's load opens the edit at the word first pressed", async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill("Keeper slow")
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await replaceEditorText(page.getByLabel("Message", { exact: true }), MESSAGE)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(1)
  await settled(page)

  // The page again, its renderer held back until the first click is in.
  let release = () => {}
  const loaded = new Promise<void>((done) => (release = done))
  await page.route(/\/StMarkdown-[^/]*\.js$/, async (route) => {
    await loaded
    await route.continue()
  })
  await page.reload()
  const mine = page.getByRole("article", { name: "Your message", exact: true })
  const body = mine.locator(".markdown")
  await expect(body).toContainText("**every cormorant**")
  const source = MESSAGE.indexOf("cormorant")
  const point = await wordPoint(body, "cormorant", 0, 4)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down({ clickCount: 1 })
  await page.mouse.up({ clickCount: 1 })
  release()
  await expect(body).toContainText("every cormorant")
  await expect(body).not.toContainText("**every cormorant**")
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
  const editor = mine.getByRole("textbox", { name: "Message text" })
  await expect(editor).toBeFocused()
  await expect.poll(async () => (await caretOf(editor)).head).toBeGreaterThanOrEqual(source)
  expect((await caretOf(editor)).head).toBeLessThanOrEqual(source + "cormorant".length)
})

// The blocks whose stored text wraps unlike its rendered text unless the editor indents it as the
// message does: a quote's inset, a list item's hanging indent, and a line long with marks.
const BLOCKS = [
  {
    name: "quote",
    word: "quillwort",
    text: "> The keeper's log says the light was lit at dusk and kept until the morning boat came round the point, that the wind backed to the north before midnight, that two gulls fought over the nets until the rain drove them under the eaves, and that nothing else of note happened at all, which the keeper underlines twice before he writes the last word of the night, quillwort."
  },
  {
    name: "list item",
    word: "marigold",
    text: "- The lamp, trimmed and filled with oil before the light went down over the harbour wall.\n- The rope, coiled by the door and tarred twice since the spring, and the boat hook leaning beside it where the children can't reach it, and the old tin of nails nobody has opened since the winter the harbour froze and the boats stayed in for six weeks, and a lantern with a cracked glass that the keeper means to mend, and a pair of oilskins hung up to dry that have never quite dried, and under all of it a box of seed for a garden nobody planted, labelled in a careful hand: marigold.\n- The ledger, open at the last page."
  },
  {
    name: "marked-up line",
    word: "thistledown",
    text: '*She sets the cup down* and **waits**, *listening to the wind* worry at the shutters, and *the kettle* begins to **sing** again. "You came *back*," she says **at last**, *not looking up*, and the *candle* gutters as the **door** swings, *the draught* carrying the smell of *salt* and **tar** and *something sweeter*, like **thistledown**.'
  }
]

for (const width of [1440, 390])
  test(`a double-click in a quote, a list item or a marked-up line keeps its line ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats`)
    await page.getByLabel("Title of the new chat").fill(`Blocks ${width}`)
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    for (const [index, { name, word, text }] of BLOCKS.entries()) {
      await replaceEditorText(page.getByLabel("Message", { exact: true }), `Before it, a short line.\n\n${text}`)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(index + 1)
      await settled(page)
      // The message just sent, which the list keeps drawn near the end.
      const mine = page.getByRole("article", { name: "Your message", exact: true }).filter({ hasText: word })
      const point = await wordPoint(mine.locator(".markdown"), word, 0, 3)
      // The rendered block the word is in (its quote's paragraph, its list item, its paragraph).
      const renderedHeight = await mine.locator(".markdown").evaluate((node, word) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text; text = walker.nextNode())
          if (text.textContent!.includes(word))
            return text.parentElement!.closest("li, p")!.getBoundingClientRect().height
        throw new Error(`no ${word}`)
      }, word)
      await page.mouse.dblclick(point.x, point.y)
      const editor = mine.getByRole("textbox", { name: "Message text" })
      await expect(editor).toBeFocused()
      // The caret in the word, its line where the word was once the edit has settled.
      const { head } = await caretOf(editor)
      expect((await textBoxValue(editor)).slice(head - 3, head - 3 + word.length)).toBe(word)
      await settledPlace(mine)
      const shift = (await caretOf(editor)).line.top - point.top
      // How far the edit's box had to scroll its text to bring that line there: the text above the
      // line moved by as much (none where the stored text wraps as the rendered text does).
      const scrolled = await editor.evaluate((element) => {
        let box: Element | null = element
        while (box && !box.matches("[data-hold-caret-within]"))
          box = box.parentElement ?? ((box.getRootNode() as ShadowRoot).host as Element | undefined) ?? null
        return box?.scrollTop ?? 0
      })
      // The edit's line for that block, as tall as the block when it wraps where the block does.
      const editedHeight = await editor.evaluate((element) => {
        const content = element as HTMLElement & {
          cmTile?: {
            root: {
              view: { state: { selection: { main: { head: number } } }; domAtPos: (pos: number) => { node: Node } }
            }
          }
        }
        const view = content.cmTile!.root.view
        const { node } = view.domAtPos(view.state.selection.main.head)
        return (node.nodeType === 1 ? (node as Element) : node.parentElement)!
          .closest(".cm-line")!
          .getBoundingClientRect().height
      })
      const rows = editedHeight - renderedHeight
      const description = `${name} ${width}: line ${shift.toFixed(1)} px, text above ${scrolled.toFixed(1)} px, block ${rows.toFixed(1)} px taller`
      test.info().annotations.push({ type: "shift", description })
      console.log(`SHIFT ${description}`)
      expect.soft(Math.abs(shift)).toBeLessThan(4)
      // The marks of a marked-up line take room the rendered line doesn't have.
      if (name !== "marked-up line") {
        expect.soft(scrolled).toBeLessThan(4)
        expect.soft(Math.abs(rows)).toBeLessThan(1)
      }
      await mine.getByRole("button", { name: "Cancel" }).click()
      await expect(editor).toHaveCount(0)
    }
  })
