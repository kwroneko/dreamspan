// A message's actions, as a user reaches them: on a wide screen they show on hover, on a
// narrow one after a tap on the message; the less used ones are in its "More actions" menu.
import { expect, type Locator, type Page } from "@playwright/test"

/** Shows the actions of `message` (an `article`). */
export const showActions = async (message: Locator) => {
  const width = message.page().viewportSize()?.width ?? 1280
  if (width < 640) {
    if ((await message.getByRole("toolbar", { name: "Message actions" }).count()) === 0) {
      await message.locator(".markdown").first().click()
    }
  } else await message.hover()
}

/** Picks `name` from the "More actions" menu of `message`. */
export const messageMenu = async (message: Locator, name: string | RegExp) => {
  await showActions(message)
  await message.getByRole("button", { name: "More actions" }).click()
  await message.page().getByRole("menuitem", { name }).click()
}

/** Picks `name` from the History menu of the editor open in `message`. */
export const editHistory = async (message: Locator, name: string | RegExp) => {
  await message.getByRole("button", { name: "History of this edit" }).click()
  await message.page().getByRole("menuitem", { name }).click()
}

/** A real wheel gesture changes the reader's follow preference along with the scroll offset. */
export const wheelTimeline = async (page: Page, by: number) => {
  const bounds = (await page.getByTestId("messages").boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.wheel(0, Math.round(bounds.height * by))
}

/** Scrolls the clicked letter into the timeline's viewport, including within a long paragraph. */
export const wordPoint = async (body: Locator, word: string, nth: number, into: number) => {
  let hit: { x: number; y: number; top: number } | undefined
  await expect
    .poll(
      async () => {
        const measured = await body.evaluate(
          (node, { word, nth, into }) => {
            const list = node.closest('[data-testid="messages"]')!
            const pane = list.getBoundingClientRect()
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
            let seen = 0
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              const content = text.textContent!
              for (let at = content.indexOf(word); at >= 0; at = content.indexOf(word, at + 1)) {
                if (seen++ !== nth) continue
                const letter = document.createRange()
                letter.setStart(text, at + into)
                letter.setEnd(text, at + into + 1)
                const rect = letter.getBoundingClientRect()
                const point = { x: rect.left + 1, y: rect.top + rect.height / 2, top: rect.top }
                const visible = point.y > pane.top + 10 && point.y < pane.bottom - 10
                const caret = document.caretPositionFromPoint(point.x, point.y)
                return {
                  point,
                  visible: visible && caret?.offsetNode === text && Math.abs(caret.offset - (at + into)) <= 1,
                  by: (point.y - (pane.top + pane.height / 2)) / pane.height
                }
              }
            }
            return null
          },
          { word, nth, into }
        )
        if (measured?.visible) {
          hit = measured.point
          return true
        }
        if (measured) await wheelTimeline(body.page(), measured.by)
        return false
      },
      { message: `${word} #${nth} stays on screen` }
    )
    .toBe(true)
  return hit!
}
