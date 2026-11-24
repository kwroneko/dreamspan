// A double-click on a reply's thinking never opens the reply's edit (owner, more than once:
// "double clicking on the thinking trace opens the output for editing"). Only the reply's own
// text opens Edit (Message.tsx editFrom, `data-reply-text`): on the thinking's toggle and its
// row, folded or open, the message's editor stays closed; on the thinking's words its own editor
// opens; on another part (the speaker's name) the browser selects the word. A double-click on
// the reply's text still opens Edit. Synthetic chat only.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "200",
  FAKE_GENERATOR_TOKENS: "20",
  FAKE_GENERATOR_REASONING: "12"
})

const lastEntry = (chatId: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api
      .ReadPath({ chatId: chatId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      .pipe(Effect.map((path) => path.entries.at(-1)!))
  )

/** The middle of the first word of three or more letters in `box`'s text, with the word. */
const wordIn = (box: Locator) =>
  box.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const match = /[A-Za-z]{3,}/.exec(node.textContent ?? "")
      if (!match) continue
      const range = document.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0) continue
      return { word: match[0], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    throw new Error("no word")
  })

const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString().trim() ?? "")

test("a double-click on a reply's thinking or name never opens its edit; on its text it does", async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Thinking double-click" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "The lighthouse went dark."
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  await page
    .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
    .last()
    .click()
  await expect.poll(async () => (await lastEntry(chat.id)).version.status, { timeout: 30_000 }).toBe("complete")
  expect((await lastEntry(chat.id)).version.reasoning).toMatch(/\S/)

  const reply = page.getByRole("article").last()
  const editor = reply.getByRole("textbox", { name: "Message text", exact: true })
  const thinkingEditor = reply.getByRole("textbox", { name: "Thinking", exact: true })
  const panel = reply.locator('[data-reasoning-panel="reasoning"]')
  const toggle = panel.locator("button[aria-expanded]").first()
  const row = panel.locator(":scope > div").first()
  const region = panel.getByRole("region")
  await expect(toggle).toBeVisible()
  // The message's editor stays closed: an edit opens a moment after the double-click (the
  // triple-click wait). The thinking's own editor may open from its row; it's closed again.
  const noEditor = async () => {
    await page.waitForTimeout(700)
    await expect(editor).toHaveCount(0)
    if ((await thinkingEditor.count()) > 0)
      await expect(async () => {
        await thinkingEditor.focus()
        await page.keyboard.press("Escape")
        await expect(thinkingEditor).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 10_000 })
  }
  const ensure = async (open: boolean) => {
    if ((await toggle.getAttribute("aria-expanded")) !== String(open)) await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", String(open))
  }
  const besideToggle = async () => {
    const rowBox = (await row.boundingBox())!
    const toggleBox = (await toggle.boundingBox())!
    return {
      x: Math.min(rowBox.x + rowBox.width - 4, toggleBox.x + toggleBox.width + 40),
      y: toggleBox.y + toggleBox.height / 2
    }
  }

  // Folded: the toggle, and the row beside it.
  await ensure(false)
  await toggle.dblclick()
  await noEditor()
  let spot = await besideToggle()
  await page.mouse.dblclick(spot.x, spot.y)
  await noEditor()

  // Open: the toggle and its row, then the thinking's words, which open its own editor.
  await ensure(true)
  await toggle.dblclick()
  await noEditor()
  await ensure(true)
  spot = await besideToggle()
  await page.mouse.dblclick(spot.x, spot.y)
  await noEditor()
  await ensure(true)
  await expect(region).toBeVisible()
  const thought = await wordIn(region)
  await page.mouse.move(thought.x, thought.y)
  await page.mouse.dblclick(thought.x, thought.y)
  await expect(thinkingEditor).toBeFocused()
  await noEditor()

  // Another part that isn't the reply's text, the speaker's name: a word selected, no editor.
  const name = await wordIn(reply.locator("[data-layout-name]"))
  await page.mouse.dblclick(name.x, name.y)
  expect(await selection(page)).toBe(name.word)
  await noEditor()
  expect(await selection(page)).toBe(name.word)

  // The reply's own text still opens Edit.
  const said = await wordIn(reply.locator("[data-reply-text]"))
  await page.mouse.dblclick(said.x, said.y)
  await expect(editor).toBeVisible({ timeout: 5_000 })
})
