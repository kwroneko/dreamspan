// Editing a message in place moves nothing (owner, 2026-11-23): a double-click turns the text
// into its editor where it is, as tall as the text was, with the controls in the message's own
// rows, so the message, the messages around it and the list's scroll stay put when the edit
// opens, and again when it's saved or cancelled. Short, multi-paragraph and long messages, at a
// wide and a phone width.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { wordPoint, wheelTimeline } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText, textBoxValue } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "2000", FAKE_GENERATOR_TOKENS: "40" })

const SHORT = "The lamp is lit."
const MULTI = [
  'Mira sets the kettle down. "You came back," she says, and *doesn\'t* look up from the table.',
  "Outside, the wind worries at the shutters. Somewhere below, a door bangs twice and is still.",
  "She pours two cups anyway."
].join("\n\n")
const LONG = Array.from(
  { length: 14 },
  (_, i) =>
    `Paragraph ${i + 1}: the tide comes in over the grey stones, and the rope by the quay creaks as the boats knock together. Nobody on the pier looks up, and the gulls go on arguing over the nets.`
).join("\n\n")

const MESSAGES = [
  { name: "short", text: SHORT, word: "lamp" },
  { name: "multi-paragraph", text: MULTI, word: "shutters" },
  { name: "long", text: LONG, word: "Paragraph 7", into: 3 }
] as const

interface Box {
  top: number
  left: number
  width: number
  height: number
}
interface Layout {
  edited: Box
  previous: Box | null
  next: Box | null
  scroll: number
  page: number
}

/** The message's box, its neighbours' and the scroll of the pane they're in, in the viewport. */
const layoutOf = (message: Locator): Promise<Layout> =>
  message.evaluate((article) => {
    const box = (element: Element | null): Box | null => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    }
    const all = [...document.querySelectorAll("article[data-slot]")]
    const at = all.indexOf(article)
    let pane = article.parentElement
    while (pane && !["auto", "scroll"].includes(getComputedStyle(pane).overflowY)) pane = pane.parentElement
    return {
      edited: box(article)!,
      previous: box(all[at - 1] ?? null),
      next: box(all[at + 1] ?? null),
      scroll: pane?.scrollTop ?? 0,
      page: document.scrollingElement?.scrollTop ?? 0
    }
  })

/** The layout once it has stayed the same for a few frames (the caret's hold settles within a second). */
async function settledLayout(page: Page, message: Locator): Promise<Layout> {
  let last = JSON.stringify(await layoutOf(message))
  for (let still = 0; still < 6;) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const now = JSON.stringify(await layoutOf(message))
    still = now === last ? still + 1 : 0
    last = now
  }
  return JSON.parse(last) as Layout
}

const SUBPIXEL = 0.5

function expectSame(before: Layout, after: Layout, what: string) {
  const near = (a: number, b: number, label: string) =>
    expect.soft(Math.abs(a - b), `${what}: ${label} moved (${a} → ${b})`).toBeLessThan(SUBPIXEL)
  const boxes = (a: Box | null, b: Box | null, label: string) => {
    expect.soft(b === null, `${what}: ${label} appeared or went`).toBe(a === null)
    if (!a || !b) return
    near(a.top, b.top, `${label} top`)
    near(a.left, b.left, `${label} left`)
    near(a.width, b.width, `${label} width`)
    near(a.height, b.height, `${label} height`)
  }
  boxes(before.edited, after.edited, "the message")
  boxes(before.previous, after.previous, "the message above")
  boxes(before.next, after.next, "the message below")
  near(before.scroll, after.scroll, "the list's scroll")
  near(before.page, after.page, "the page's scroll")
}

for (const width of [1440, 390])
  test(`opening, saving and cancelling an edit moves nothing at ${width}`, async ({ page }) => {
    test.setTimeout(150_000)
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats`)
    await page.getByLabel("Title of the new chat").fill(`Harbour ${width}`)
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    const composer = page.getByLabel("Message", { exact: true })
    const mine = (text: string) =>
      page.getByRole("article", { name: "Your message", exact: true }).filter({ hasText: text.slice(0, 40) })
    for (const { text } of MESSAGES) {
      const send = page.getByRole("button", { name: "Send", exact: true })
      // The new chat's composer may still be taking its place when the text first goes in.
      await expect(async () => {
        await replaceEditorText(composer, text)
        await expect(send).toBeEnabled({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
      await send.click()
      await expect(mine(text)).toHaveCount(1)
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
    }

    // From the newest up: the list keeps only the rows near the screen.
    for (const message of [...MESSAGES].reverse()) {
      const found = mine(message.text)
      for (let tries = 0; (await found.count()) === 0 && tries < 40; tries++) await wheelTimeline(page, -0.6)
      await expect(found).toHaveCount(1)
      // By its slot: its text is in the editor's shadow root while it's edited.
      const slot = await found.getAttribute("data-slot")
      const article = page.locator(`article[data-slot="${slot}"]`)
      const body = article.locator(".markdown")
      const editor = article.getByRole("textbox", { name: "Message text" })
      const open = async () => {
        const point = await wordPoint(body, message.word, 0, "into" in message ? message.into : 1)
        await page.mouse.move(point.x, point.y)
        const before = await settledLayout(page, article)
        await page.mouse.dblclick(point.x, point.y)
        await expect(editor).toBeFocused()
        expect(await textBoxValue(editor)).toBe(message.text)
        expectSame(before, await settledLayout(page, article), `${message.name} at ${width}: opening the edit`)
        return before
      }
      /** Closes the edit with `press`, and checks nothing moved from `before`. */
      const close = async (before: Layout, press: () => Promise<void>, what: string) => {
        await press()
        await expect(editor).toHaveCount(0)
        expectSame(before, await settledLayout(page, article), `${message.name} at ${width}: ${what}`)
      }
      /** The button `name` of the edit, where it can be clicked (a long message's footer is past the screen). */
      const button = async (name: string) => {
        const control = article.getByRole("button", { name, exact: true })
        await control.scrollIntoViewIfNeeded()
        return { control, shown: await settledLayout(page, article) }
      }

      // Escape and Ctrl+Enter: back to the text exactly as it was before the double-click.
      const first = await open()
      await expectLayout(page, test.info(), `seamless-edit-${message.name}-${width}`, {
        scope: `article[data-slot="${slot}"]`,
        hovered: true
      })
      await close(first, () => page.keyboard.press("Escape"), "cancelling with Escape")
      await close(await open(), () => page.keyboard.press("ControlOrMeta+Enter"), "saving with Ctrl+Enter")

      // Cancel and Save, the text unchanged: nothing moves from where the buttons were clicked.
      await open()
      const cancel = await button("Cancel")
      await close(cancel.shown, () => cancel.control.click(), "cancelling")
      await open()
      const save = await button("Save")
      await close(save.shown, () => save.control.click(), "saving")
    }
  })
