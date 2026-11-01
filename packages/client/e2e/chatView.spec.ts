// How a chat reads and how its messages are acted on: the header's readable name and the
// branch shown (switched from anywhere in the chat), each message's number and versions
// (stepped through, or picked from a list), its actions on hover, in its menu, or after a
// tap on a phone, and writing a version of one's own.
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

const send = (api: Api, chatId: ChatId, parent: SlotId | null, content: string, branch = false) =>
  Effect.map(api.SendMessage({ chatId, parentSlotId: parent, branch, content }), slotOf)

const message = (page: Page, text: string) => page.locator("article[data-slot]").filter({ hasText: text })
/** The message with `text` now, found by its slot so it stays found while its text is edited. */
const pinned = async (page: Page, text: string) =>
  page.locator(`article[data-slot="${await message(page, text).getAttribute("data-slot")}"]`)

/** A chat titled the way ST titles its files, three messages long, branching at the second. */
const forked = () =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Harbor - 2026-4-3@18h00m00s000ms" })
      const m0 = yield* send(api, chat.id, null, "The tide is out.")
      const m1 = yield* send(api, chat.id, m0, "We walk the flats.")
      yield* send(api, chat.id, m1, "The fog rolls in.")
      yield* send(api, chat.id, m0, "We wait for the tide.", true)
      return { chatId: chat.id, m0 }
    })
  )

test("the header names the chat as people do and switches branches from anywhere", async ({ page }) => {
  const { chatId } = await forked()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Harbor")
  await expect(page.getByRole("main").getByText("started Apr 3, 2026", { exact: true })).toBeVisible()
  await expect(page).toHaveTitle(/Harbor/)
  // The newest branch is shown; the header says so and offers the other.
  const branches = page.getByRole("button", { name: /switch branch/ })
  await expect(branches).toHaveAccessibleName(/Branch: Branch 1, 1 of 2/)
  await branches.click()
  const list = page.getByRole("list", { name: "Branches" })
  await expect(list.getByRole("listitem")).toHaveCount(2)
  await list.getByRole("button", { name: /^Original/ }).click()
  await expect(message(page, "The fog rolls in.")).toBeVisible()
  await expect(message(page, "We wait for the tide.")).toHaveCount(0)
  await expect(branches).toHaveAccessibleName(/Branch: Original, 2 of 2, not the latest/)
})

test("Branch from here names the branch, shows it at once, keeps the URL, and the chat stays on top", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { chatId } = await forked()
  // Another chat, chatted in after the first: until the branch, it's the newer one.
  await admin((api) =>
    Effect.gen(function* () {
      const other = yield* api.CreateChat({ title: "Lighthouse" })
      yield* send(api, other.id, null, "The lamp turns.")
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}?panel=history`)
  const branches = page.getByRole("button", { name: /switch branch/ })
  await expect(branches).toHaveAccessibleName(/Branch: Branch 1, 1 of 2/)
  const chats = page.getByRole("complementary").first().getByRole("region", { name: "Chats", exact: true })
  const rows = chats.getByRole("button", { name: /^Open chat/ })
  await expect(rows.first()).toHaveAttribute("data-chat-id", /./)
  expect(await rows.first().getAttribute("data-chat-id")).not.toBe(chatId)
  // The shown branch is the current one: Branch from here at message #2 makes "From #2".
  const at = message(page, "We wait for the tide.")
  const slot = await page.locator("article[data-slot]").first().getAttribute("data-slot")
  await messageMenu(page.locator("article[data-slot]").first(), "Branch from here")
  await expect(branches).toHaveAccessibleName(/Branch: From #1, 1 of 3/)
  await expect.poll(() => new URL(page.url()).searchParams.get("slot")).toBe(slot)
  expect(new URL(page.url()).searchParams.get("panel")).toBe("history")
  expect(new URL(page.url()).searchParams.get("fork")).toBeNull()
  await expect(at).toHaveCount(0)
  // The chat is on top of All chats now, listed once, with its branches counted.
  await expect(rows.first()).toHaveAttribute("data-chat-id", chatId)
  await expect(chats.locator(`[data-chat-id="${chatId}"]`)).toHaveCount(1)
  await expect(rows.first()).toContainText("3 branches")
  // Back returns to the branch it came from, which is no longer the latest; Forward and a
  // reload come back to the new one.
  await page.goBack()
  await expect(branches).toHaveAccessibleName(/Branch: Branch 1, 2 of 3, not the latest/)
  expect(new URL(page.url()).searchParams.get("fork")).not.toBeNull()
  await expect(at).toBeVisible()
  await page.goForward()
  await expect(branches).toHaveAccessibleName(/Branch: From #1, 1 of 3/)
  await page.reload()
  await expect(branches).toHaveAccessibleName(/Branch: From #1, 1 of 3/)
  await expect(rows.first()).toHaveAttribute("data-chat-id", chatId)
  // As ST's "Back to parent chat": the list goes back to the branch it was made from.
  await branches.click()
  await page.getByRole("button", { name: "Back to “Branch 1”", exact: true }).click()
  await expect(branches).toHaveAccessibleName(/Branch: Branch 1, 2 of 3, not the latest/)
  await expect(at).toBeVisible()
})

test("while a chat loads, it shows the shapes of its header and messages, not a spinner", async ({ page }) => {
  const { chatId } = await forked()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // Hold the chat view's code until the placeholder has been seen.
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/assets\/ChatPage-[^/]*\.js$/, async (route) => {
    await held
    await route.continue()
  })
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByTestId("messages-loading")).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Loading the chat…" })).toBeAttached()
  release()
  await expect(message(page, "We wait for the tide.")).toBeVisible()
  await expect(page.getByTestId("messages-loading")).toHaveCount(0)
})

test("a message shows its number and versions; one is picked from the list, and one's own written", async ({
  page
}) => {
  const { chatId, m0 } = await forked()
  await admin((api) =>
    Effect.gen(function* () {
      const [entry] = (yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })).entries
      yield* api.WriteVersion({ slotId: m0, content: "The tide is in.", expectedRowVersion: entry!.rowVersion })
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const first = message(page, "The tide is in.")
  await expect(first.getByText("#1", { exact: true })).toBeVisible()
  const versions = first.getByRole("group", { name: "Versions" })
  await expect(versions).toContainText("2/2")
  await versions.getByRole("button", { name: /choose a version/ }).click()
  await page
    .getByRole("dialog", { name: "Versions of message #1" })
    .getByRole("button", { name: /^Version 1, .*The tide is out\./ })
    .click()
  await expect(message(page, "The tide is out.").getByRole("group", { name: "Versions" })).toContainText("1/2")

  // Its actions show on hover; the rarer ones are in its menu.
  const shown = await pinned(page, "The tide is out.")
  await showActions(shown)
  await expect(shown.getByRole("button", { name: "Delete version" })).toBeVisible()
  await messageMenu(shown, "Write your own version")
  await shown.getByRole("textbox", { name: "Your version" }).fill("The tide turns.")
  await shown.getByRole("button", { name: "Add as a new version" }).click()
  await expect(message(page, "The tide turns.").getByRole("group", { name: "Versions" })).toContainText("3/3")

  // Deleting the version shown is the delete at hand; Undo puts it back.
  const turned = message(page, "The tide turns.")
  await showActions(turned)
  await turned.getByRole("button", { name: "Delete version" }).click()
  await expect(message(page, "The tide turns.")).toHaveCount(0)
  await page.getByRole("button", { name: "Undo" }).click()
  await expect(page.locator("article[data-slot]").first().getByRole("group", { name: "Versions" })).toContainText("/3")
})

test("on a phone a tap on a message shows its actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { chatId } = await forked()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const last = await pinned(page, "We wait for the tide.")
  await expect(last.getByRole("toolbar", { name: "Message actions" })).toHaveCount(0)
  await last.locator(".markdown").click()
  const actions = last.getByRole("toolbar", { name: "Message actions" })
  await expect(actions).toBeVisible()
  await actions.getByRole("button", { name: "Edit" }).click()
  await last.getByLabel("Message text").fill("We wait for the tide to turn.")
  await last.getByRole("button", { name: "Save" }).click()
  await expect(message(page, "We wait for the tide to turn.")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
