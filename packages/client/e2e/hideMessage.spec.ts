// Hiding a message from the model and showing it again (ST's ghost toggle), from the
// message's "More actions" menu: it stays in the chat, marked Hidden with why, across a
// reload, nothing generates, and it's sent again once shown. On a phone the reason shows
// under the message once it's tapped.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import { messageMenu, showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "80", FAKE_GENERATOR_TOKENS: "160" })

type Api = Parameters<Parameters<typeof asUser>[3]>[0]
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const slotOf = (result: SendResult) => {
  if (result._tag !== "Posted") throw new Error("expected it to post")
  return result.entry.slotId
}
const send = (api: Api, chatId: ChatId, parent: SlotId | null, content: string) =>
  Effect.map(api.SendMessage({ chatId, parentSlotId: parent, branch: false, content }), slotOf)

/** A chat of three messages. */
const threeMessages = () =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Lighthouse" })
      const m0 = yield* send(api, chat.id, null, "The lamp is lit.")
      const m1 = yield* send(api, chat.id, m0, "A ship rounds the point.")
      yield* send(api, chat.id, m1, "The fog horn sounds.")
      return chat.id
    })
  )

const message = (page: Page, text: string) => page.locator("article[data-slot]").filter({ hasText: text })
const REASON =
  "Hidden: you hid it from the model, so it isn't sent. To send it again: More actions → Show to the model again."

test("a message hidden from the model stays in the chat, marked, and is shown to it again", async ({ page }) => {
  const chatId = await threeMessages()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const ship = message(page, "A ship rounds the point.")
  await expect(ship).toBeVisible()
  await expect(ship).not.toHaveAttribute("data-hidden")

  await messageMenu(ship, "Hide from the model")
  await expect(ship).toHaveAttribute("data-hidden", "true")
  const mark = ship.getByRole("img", { name: "Hidden from context" })
  await expect(mark).toBeVisible()
  // Why, in its tooltip and to a screen reader.
  await expect(ship).toContainText(REASON)
  // It's still there, with its text, and nothing was generated.
  await expect(page.locator("article[data-slot]")).toHaveCount(3)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0)

  // Kept across a reload; the menu offers the way back.
  await page.reload()
  await expect(message(page, "A ship rounds the point.")).toHaveAttribute("data-hidden", "true")
  await messageMenu(message(page, "A ship rounds the point."), "Show to the model again")
  await expect(message(page, "A ship rounds the point.")).not.toHaveAttribute("data-hidden")
  await expect(message(page, "A ship rounds the point.").getByRole("img", { name: "Hidden from context" })).toHaveCount(
    0
  )
  await expect(page.locator("article[data-slot]")).toHaveCount(3)
})

test("on a phone, a hidden message says why once tapped", async ({ browser }) => {
  const chatId = await threeMessages()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const lamp = message(page, "The lamp is lit.")
  await messageMenu(lamp, "Hide from the model")
  await expect(lamp).toHaveAttribute("data-hidden", "true")
  await showActions(lamp)
  await expect(lamp.getByRole("paragraph").filter({ hasText: REASON })).toBeVisible()
  await context.close()
})
