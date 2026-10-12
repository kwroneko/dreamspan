// The composer's text as a server draft (DESIGN §6.2): it survives a reload and shows in
// another tab, a send ends it, it can be undone from the server's history, and text typed just
// before the page goes leaves with it, or stays in this browser when it's too long to send.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "40" })

const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const box = (page: Page) => page.getByLabel("Message", { exact: true })

/** A new chat, open, and its id. */
const newChat = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(title)
  await page.getByRole("button", { name: "New chat" }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(box(page)).toBeEditable()
  return page.url().split("/chats/")[1]!.split("?")[0]! as ChatId
}

/** The composer's text on the server at a tip; null when there's no draft. */
const onServer = (chatId: ChatId, tipSlotId: SlotId | null) =>
  admin((api) => api.GetComposer({ chatId, tipSlotId })).then((draft) =>
    draft?.status === "active" ? draft.content : null
  )

const leaf = (chatId: ChatId) => admin((api) => api.GetChat({ chatId })).then((chat) => chat.activeLeafSlotId)

test("the composer's text is on the server: a reload and another tab show it, and sending ends it", async ({
  page,
  context
}) => {
  const chatId = await newChat(page, "Harbor")
  await box(page).fill("Half a thought about the harbor")
  await expect.poll(() => onServer(chatId, null)).toBe("Half a thought about the harbor")
  await page.reload()
  await expect(box(page)).toHaveValue("Half a thought about the harbor")

  const other = await context.newPage()
  await other.goto(page.url())
  await expect(box(other)).toHaveValue("Half a thought about the harbor")
  await other.close()

  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByRole("article", { name: "Your message" })).toHaveText(/Half a thought/)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  // Typed while the reply came: it moves on with the chat, and stays after a reload.
  await box(page).fill("And then")
  await expect.poll(async () => onServer(chatId, await leaf(chatId))).toBe("And then")
  await page.reload()
  await expect(box(page)).toHaveValue("And then")
  await box(page).fill("")
  await expect.poll(async () => onServer(chatId, await leaf(chatId))).toBe("")
  await page.reload()
  await expect(box(page)).toHaveValue("")
})

test("an earlier text comes back from the server's history", async ({ page }) => {
  const chatId = await newChat(page, "History")
  const long = "A long paragraph about the lighthouse keeper and the storm. ".repeat(5).trim()
  await box(page).fill(long)
  await expect.poll(() => onServer(chatId, null)).toBe(long)
  // Select-all and a stray key.
  await box(page).fill("x")
  await expect.poll(() => onServer(chatId, null)).toBe("x")
  await page.getByRole("button", { name: "Earlier text of this message" }).click()
  await page
    .getByRole("dialog", { name: "Earlier text" })
    .getByRole("button")
    .filter({ hasText: `${long.length} characters` })
    .click()
  await expect(box(page)).toHaveValue(long)
  await expect.poll(() => onServer(chatId, null)).toBe(long)
})

/** Records each request to /library/drafts: whether it was sent with `keepalive`. */
const recordBeacons = (page: Page) =>
  page.evaluate(() => {
    const original = window.fetch
    const sent: Array<boolean> = []
    Object.assign(window, { __beacons: sent })
    window.fetch = (input, init) => {
      if (input === "/library/drafts") sent.push(init?.keepalive === true)
      return original(input, init)
    }
  })

const beacons = (page: Page) => page.evaluate(() => (window as unknown as { __beacons: Array<boolean> }).__beacons)

test("text typed just before closing the tab leaves with it, after a warning", async ({ page }) => {
  const chatId = await newChat(page, "Closing")
  await recordBeacons(page)
  await box(page).fill("Typed in the last moment.")
  const warned = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(warned).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  expect(await beacons(page)).toEqual([true])
  await page.close()
  await expect.poll(() => onServer(chatId, null)).toBe("Typed in the last moment.")
})

test("text too long to send as the page goes comes back from this browser on a reload", async ({ page }) => {
  // The server never hears of the text before the page goes (a connection gone bad, say).
  let blocked = false
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (!(blocked && typeof data === "string" && data.includes('"SaveComposer"'))) upstream.send(data)
    })
  })
  const chatId = await newChat(page, "Long")
  page.on("dialog", (dialog) => void dialog.accept())
  const long = "y".repeat(70_000)
  blocked = true
  await box(page).fill(long)
  await page.waitForTimeout(1000)
  expect(await onServer(chatId, null)).toBeNull()
  blocked = false
  await page.reload()
  await expect(page.getByText("Text this browser kept")).toBeVisible()
  await expect(box(page)).toHaveValue(long)
  await expect.poll(() => onServer(chatId, null)).toBe(long)
})
