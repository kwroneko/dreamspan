// A toast's ×: in the card's top-right corner, clear of the title, and one click closes the
// toast for good. Past the limit of three, the toasts waiting their turn stay hidden: they used
// to show, inert, so their × and buttons did nothing.
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { showActions } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin })

type Api = Parameters<Parameters<typeof asUser>[3]>[0]

const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const slotOf = (result: SendResult) => {
  if (result._tag !== "Posted") throw new Error("expected it to post")
  return result.entry.slotId
}

const send = (api: Api, chatId: ChatId, parent: SlotId | null, content: string) =>
  Effect.map(api.SendMessage({ chatId, parentSlotId: parent, branch: false, content }), slotOf)

const message = (page: Page, text: string) =>
  page.getByRole("article", { name: "Your message" }).filter({ hasText: text })

const SHOTS = process.env.TOAST_SHOTS

const chatWith = (title: string, lines: ReadonlyArray<string>) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      let parent: SlotId | null = null
      for (const line of lines) parent = yield* send(api, chat.id, parent, line)
      return chat.id
    })
  )

const deleteMessage = async (page: Page, text: string) => {
  await showActions(message(page, text))
  await message(page, text).getByRole("button", { name: "Delete message", exact: true }).click()
  await expect(message(page, text)).toHaveCount(0)
}

/** The × sits in the card's corner (within its 12px padding) and clear of the title. */
const expectCornerClose = async (toast: Locator) => {
  const card = (await toast.boundingBox())!
  const close = (await toast.locator("[data-toast-close]").boundingBox())!
  // The title's text as laid out (its element's box spans the reserved room too).
  const title = await toast
    .locator("div")
    .first()
    .locator(":scope > :first-child")
    .evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const rects = [...range.getClientRects()]
      return { x: 0, width: Math.max(...rects.map((rect) => rect.right)), lines: rects.length }
    })
  const padding = 12
  expect(card.x + card.width - (close.x + close.width)).toBeLessThanOrEqual(padding)
  expect(close.y - card.y).toBeLessThanOrEqual(padding)
  expect(close.x + close.width).toBeLessThanOrEqual(card.x + card.width)
  // The title's text ends before the × starts.
  expect(title.x + title.width).toBeLessThanOrEqual(close.x + 0.5)
  // The click lands on the × itself, not on something laid over it.
  const hit = await toast.locator("[data-toast-close]").evaluate((button) => {
    const box = button.getBoundingClientRect()
    const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return at !== null && button.contains(at)
  })
  expect(hit).toBe(true)
}

for (const [width, height] of [
  [1340, 900],
  [390, 844]
] as const) {
  test(`a toast's × at ${width}px sits in its corner and closes it for good`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: "dark" })
    const title =
      "A chat whose title runs long enough that the toast's title wraps over several lines, started 10 Sept 2024"
    const lines = ["The lamp is lit.", "A ship answers.", "The fog rolls in.", "A bell rings.", "Gulls cry."]
    const chatId = await chatWith(title, lines)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(message(page, "Gulls cry.")).toBeVisible()

    const toasts = page.locator("[data-toast]")
    // Wide, four deletes: one more than the three toasts shown at once (a narrow screen's
    // slower deletes would let the first toasts time out meanwhile, so two there).
    const count = width > 1000 ? 4 : 2
    for (const line of lines.slice(1).reverse().slice(0, count)) await deleteMessage(page, line)
    await expect(toasts.filter({ visible: true })).toHaveCount(Math.min(count, 3))
    const top = toasts.filter({ visible: true }).first()
    await expect(top).toContainText("moved to the bin.")
    await expectCornerClose(top)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/toast-${width}.png` })

    // Each visible toast closes with one click on its ×; the one waiting its turn then shows,
    // and it closes as well.
    for (let left = count; left > 0; left--) {
      const shown = toasts.filter({ visible: true })
      await expect(shown).toHaveCount(Math.min(left, 3))
      const last = shown.last()
      const name = await last.locator("div").first().innerText()
      await last.hover()
      await last.locator("[data-toast-close]").click()
      await expect(toasts.filter({ hasText: name.split("\n")[0]! })).toHaveCount(0)
    }
    await expect(toasts).toHaveCount(0)
    await page.waitForTimeout(2000)
    await expect(toasts).toHaveCount(0)
    await page.goto(`${server().url}/chats`)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(message(page, "The lamp is lit.")).toBeVisible()
    await expect(toasts).toHaveCount(0)
  })
}

test("the × shows Dismiss on hover", async ({ page }) => {
  const chatId = await chatWith("Lighthouse", ["The lamp is lit.", "A ship answers."])
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await deleteMessage(page, "A ship answers.")
  const toast = page.locator("[data-toast]")
  await toast.locator("[data-toast-close]").hover()
  await expect(page.getByText("Dismiss", { exact: true }).last()).toBeVisible()
  await toast.locator("[data-toast-close]").click()
  await expect(toast).toHaveCount(0)
})
