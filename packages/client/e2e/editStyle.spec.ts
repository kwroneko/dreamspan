// A message being edited looks like the message (ui/MessageTextEditor.tsx): its dialogue in the
// quote color, its italics italic in the italics color, its bold bold, its underline underlined,
// in the message's own font, size and line height, in both themes. The Markdown marks stay in
// the text, dimmed. What's typed is styled too, by the worker, once it answers.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText, textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)

const MESSAGE = [
  `*She looks up from the ledger.* "You came back," she says. **Not** a question. __Underlined__ words.`,
  `A second paragraph with "more dialogue" and *an aside*, and the keeper's lamp.`
].join("\n\n")

const STYLE = ["color", "fontStyle", "fontWeight", "textDecorationLine", "fontSize", "fontFamily"] as const
type Style = Record<(typeof STYLE)[number], string>

/** The computed look of the first element matching `selector` in `scope` whose text is `text`. */
const styleOf = (scope: Locator, selector: string, text: string) =>
  scope
    .locator(selector)
    .filter({ hasText: text })
    .first()
    .evaluate((element, keys) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(keys.map((key) => [key, style[key]])) as Style
    }, STYLE)

const openChat = async (page: Page, theme: "light" | "dark") => {
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(`Ledger ${theme}`)
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await replaceEditorText(page.getByLabel("Message", { exact: true }), MESSAGE)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(1)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
}

for (const theme of ["light", "dark"] as const)
  test(`the edited text has the message's colors and styles, ${theme}`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openChat(page, theme)
    const mine = page.getByRole("article", { name: "Your message", exact: true })
    const body = mine.locator(".markdown")
    await expect(body).toContainText("keeper's lamp")
    const rendered = {
      quote: await styleOf(body, "q", "You came back"),
      em: await styleOf(body, "em", "She looks up"),
      strong: await styleOf(body, "strong", "Not"),
      underline: await styleOf(body, "u", "Underlined"),
      main: await body
        .locator("p")
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            color: style.color,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontFamily: style.fontFamily
          }
        })
    }
    // The quote, italics and main colors differ, so matching them means something.
    expect(new Set([rendered.quote.color, rendered.em.color, rendered.main.color]).size).toBe(3)

    await body.getByText("keeper's lamp").dblclick()
    const editor = mine.getByRole("textbox", { name: "Message text" })
    await expect(editor).toBeFocused()
    expect(await textBoxValue(editor)).toBe(MESSAGE)
    // Locators reach into the editor's shadow root.
    expect(await styleOf(mine, ".rp-md-quote", "You came back")).toEqual(rendered.quote)
    expect(await styleOf(mine, ".rp-md-em", "She looks up")).toEqual(rendered.em)
    expect(await styleOf(mine, ".rp-md-strong", "Not")).toEqual(rendered.strong)
    expect(await styleOf(mine, ".rp-md-underline", "Underlined")).toEqual(rendered.underline)
    const main = await editor.evaluate((element) => {
      const style = getComputedStyle(element.querySelector(".cm-line")!)
      return {
        color: style.color,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontFamily: style.fontFamily
      }
    })
    expect(main).toEqual(rendered.main)
    // The marks are text still, dimmed.
    const syntax = mine.locator(".rp-md-em .rp-md-syntax").first()
    await expect(syntax).toHaveText("*")
    expect(Number(await syntax.evaluate((element) => getComputedStyle(element).opacity))).toBeLessThan(1)

    // New dialogue and italics, typed at the end, are styled as they will render.
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.type(` "Fresh words," *typed in*.`)
    await expect(mine.locator(".rp-md-quote").filter({ hasText: "Fresh words" })).toHaveCount(1)
    expect(await styleOf(mine, ".rp-md-quote", "Fresh words")).toEqual(rendered.quote)
    expect(await styleOf(mine, ".rp-md-em", "typed in")).toEqual(rendered.em)
    await expectLayout(page, test.info(), `edit-style-${theme}`, { scope: 'article[aria-label="Your message"]' })
    await mine.getByRole("button", { name: "Cancel" }).click()
    await expect(editor).toHaveCount(0)
  })
