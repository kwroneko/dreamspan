// The composer's text looks as the message will render (owner, 2026-11-23: "It would make sense if
// the user saw the message just like it gets rendered. This would not happen if the user is typing
// guidance rather than a message."). Its box is the message editor's (`message.text-editor`): in
// message mode its dialogue, italics, bold and underline have the rendered message's colors and
// styles; in guidance mode the text is plain. Switching changes only that: the text, caret and
// selection, scroll, the box's and the composer's heights, focus and an IME composition all stay,
// on every frame. The page's first frame already has the box, never its loading line.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText, textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)

/** Dialogue, italics, bold and underline, each on a short line, so no style moves a line's wrap. */
const MESSAGE = [`*She nods.* "You came," she says.`, `**Not** a question. __Underlined__.`].join("\n\n")

const STYLE = ["color", "fontStyle", "fontWeight", "textDecorationLine"] as const
type Style = Record<(typeof STYLE)[number], string>

const styleOf = (scope: Locator, selector: string, text: string) =>
  scope
    .locator(selector)
    .filter({ hasText: text })
    .first()
    .evaluate((element, keys) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(keys.map((key) => [key, style[key]])) as Style
    }, STYLE)

const box = (page: Page) => page.getByTestId("composer")
const toggle = (page: Page) => page.getByRole("switch", { name: "Guidance", exact: true })

/** A chat whose one message is MESSAGE, rendered, with its reply finished. */
const openChat = async (page: Page, theme: "light" | "dark", width: number) => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(`Ledger ${theme} ${width}`)
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await replaceEditorText(page.getByLabel("Message", { exact: true }), MESSAGE)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(1)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  await expect(toggle(page)).toBeEnabled()
}

/** What switching must leave alone: the text, selection, scroll, focus, composition, and where things are. */
const state = (page: Page) =>
  box(page).evaluate((content) => {
    const view = (
      content as HTMLElement & {
        cmTile: {
          root: {
            view: {
              state: { doc: { toString: () => string }; selection: { main: { anchor: number; head: number } } }
              composing: boolean
              scrollDOM: HTMLElement
              coordsAtPos: (pos: number) => { top: number; left: number } | null
            }
          }
        }
      }
    ).cmTile.root.view
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect()
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10).join(",")
    }
    const caret = view.coordsAtPos(view.state.selection.main.head)
    return {
      text: view.state.doc.toString(),
      anchor: view.state.selection.main.anchor,
      head: view.state.selection.main.head,
      // The caret's line: its x moves within the line as italics and bold take their own widths.
      caretTop: caret ? Math.round(caret.top * 10) / 10 : null,
      scrollTop: view.scrollDOM.scrollTop,
      focused:
        content.getRootNode() instanceof ShadowRoot && (content.getRootNode() as ShadowRoot).activeElement === content,
      composing: view.composing,
      text_box: rect(document.querySelector("[data-composer-text]")!),
      composer_box: rect(document.querySelector('[data-testid="composer-box"]')!),
      column: rect(document.querySelector('[data-testid="composer-box"]')!.closest(".chat-column")!)
    }
  })

/** The composer's boxes on every frame while `run` switches the mode, then for half a second. */
const framesWhile = async (page: Page, run: () => Promise<void>) => {
  await page.evaluate(() => {
    const w = window as unknown as { frames_: Array<string>; stop_: boolean }
    w.frames_ = []
    w.stop_ = false
    const tick = () => {
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect()
        return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10).join(",")
      }
      w.frames_.push(
        [
          rect(document.querySelector("[data-composer-text]")!),
          rect(document.querySelector('[data-testid="composer-box"]')!)
        ].join(" | ")
      )
      if (!w.stop_) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await run()
  await page.waitForTimeout(500)
  return page.evaluate(() => {
    const w = window as unknown as { frames_: Array<string>; stop_: boolean }
    w.stop_ = true
    return [...new Set(w.frames_)]
  })
}

/** Switches the mode as a click does, but leaving focus where it is (a programmatic click doesn't move it). */
const switchMode = (page: Page) => toggle(page).evaluate((element) => (element as HTMLElement).click())

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the composer shows a message as it will render and guidance plain, ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      await openChat(page, theme, width)
      const mine = page.getByRole("article", { name: "Your message", exact: true })
      const body = mine.locator(".markdown")
      await expect(body).toContainText("Underlined")
      const rendered = {
        quote: await styleOf(body, "q", "You came"),
        em: await styleOf(body, "em", "She nods"),
        strong: await styleOf(body, "strong", "Not"),
        underline: await styleOf(body, "u", "Underlined"),
        main: await body
          .locator("p")
          .first()
          .evaluate((element) => getComputedStyle(element).color)
      }
      expect(new Set([rendered.quote.color, rendered.em.color, rendered.main]).size).toBe(3)

      // Message mode: the rendered message's colors and styles.
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false")
      await replaceEditorText(box(page), MESSAGE)
      const composer = page.getByTestId("composer-box")
      await expect(composer.locator(".rp-md-quote").filter({ hasText: "You came" })).toHaveCount(1)
      expect(await styleOf(composer, ".rp-md-quote", "You came")).toEqual(rendered.quote)
      expect(await styleOf(composer, ".rp-md-em", "She nods")).toEqual(rendered.em)
      expect(await styleOf(composer, ".rp-md-strong", "Not")).toEqual(rendered.strong)
      expect(await styleOf(composer, ".rp-md-underline", "Underlined")).toEqual(rendered.underline)
      expect(await box(page).evaluate((element) => getComputedStyle(element.querySelector(".cm-line")!).color)).toBe(
        rendered.main
      )
      await expectLayout(page, test.info(), `composer-style-message-${width}-${theme}`, {
        scope: '[data-testid="composer-box"]'
      })

      // A selection inside the dialogue, the box focused.
      await box(page).evaluate((content) => {
        const view = (
          content as HTMLElement & {
            cmTile: { root: { view: { dispatch: (spec: object) => void; focus: () => void } } }
          }
        ).cmTile.root.view
        view.dispatch({ selection: { anchor: 18, head: 26 } })
        view.focus()
      })
      await page.waitForTimeout(300)
      const before = await state(page)
      expect(before.focused).toBe(true)
      expect(before.text).toBe(MESSAGE)

      // Guidance: plain, everything else as it was, on every frame.
      const toGuidance = await framesWhile(page, async () => {
        await switchMode(page)
        await expect(toggle(page)).toHaveAttribute("aria-checked", "true")
        await expect(composer.locator(".rp-md-quote")).toHaveCount(0)
      })
      expect(toGuidance, `frames: ${toGuidance.join(" / ")}`).toHaveLength(1)
      await expect(composer.locator(".rp-md-em, .rp-md-strong, .rp-md-underline, .rp-md-syntax")).toHaveCount(0)
      await expect(page.getByRole("textbox", { name: "Guidance", exact: true })).toBeVisible()
      expect(await state(page)).toEqual(before)
      await expectLayout(page, test.info(), `composer-style-guidance-${width}-${theme}`, {
        scope: '[data-testid="composer-box"]'
      })

      // And back: styled again, nothing moved.
      const toMessage = await framesWhile(page, async () => {
        await switchMode(page)
        await expect(toggle(page)).toHaveAttribute("aria-checked", "false")
        await expect(composer.locator(".rp-md-quote").filter({ hasText: "You came" })).toHaveCount(1)
      })
      expect(toMessage, `frames: ${toMessage.join(" / ")}`).toEqual(toGuidance)
      expect(await state(page)).toEqual(before)
      expect(await styleOf(composer, ".rp-md-quote", "You came")).toEqual(rendered.quote)
    })

test("switching modes mid-composition keeps the composition, and a clicked switch keeps caret and text", async ({
  page,
  context
}) => {
  test.setTimeout(120_000)
  await openChat(page, "light", 1440)
  await replaceEditorText(box(page), MESSAGE)
  await box(page).press("ControlOrMeta+End")
  const cdp = await context.newCDPSession(page)
  await cdp.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 })
  await expect.poll(async () => (await state(page)).composing).toBe(true)
  const composing = await state(page)
  await switchMode(page)
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true")
  await page.waitForTimeout(300)
  expect(await state(page)).toEqual(composing)
  await cdp.send("Input.insertText", { text: "仮名" })
  await cdp.detach()
  await expect.poll(() => textBoxValue(box(page))).toBe(`${MESSAGE}仮名`)

  // A real click moves focus to the switch, as any button's does; the text and caret stay, and typing
  // goes on where it was once the box is focused again.
  const before = await state(page)
  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false")
  const after = await state(page)
  expect({ ...after, focused: true }).toEqual({ ...before, focused: true })
  await box(page).focus()
  await page.keyboard.type("!")
  await expect.poll(() => textBoxValue(box(page))).toBe(`${MESSAGE}仮名!`)
})

test("the composer's box is drawn in the page's first frame, never its loading line", async ({ page }) => {
  test.setTimeout(90_000)
  await openChat(page, "light", 1440)
  await replaceEditorText(box(page), MESSAGE)
  await expect
    .poll(async () => {
      // Saved: a reload shows the same draft.
      return (await page.evaluate(() => document.querySelector("[data-composer-text]") !== null)) as boolean
    })
    .toBe(true)
  await page.waitForTimeout(1000)
  // Every frame from the start: once the composer's box is on the page, its text box is the editor.
  await page.addInitScript(() => {
    const w = window as unknown as { seen_: Array<string> }
    w.seen_ = []
    const tick = () => {
      const composer = document.querySelector('[data-testid="composer-box"]')
      if (composer) {
        const host = composer.querySelector("[data-composer-text]")
        const content = host
          ? [...host.querySelectorAll("*")]
              .map((element) => element.shadowRoot?.querySelector(".cm-content"))
              .find(Boolean)
          : null
        w.seen_.push(
          composer.textContent?.includes("Loading editor") ? "loading line" : content ? "editor" : "no editor"
        )
      }
      if (w.seen_.length < 400) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.reload()
  await expect.poll(() => textBoxValue(box(page))).toBe(MESSAGE)
  await expect(page.getByTestId("composer-box").locator(".rp-md-quote").first()).toBeVisible()
  const seen = await page.evaluate(() => [...new Set((window as unknown as { seen_: Array<string> }).seen_)])
  expect(seen).toEqual(["editor"])
})
