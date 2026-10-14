// Groups on the home grid (DESIGN §2.1; ST's group tiles): the chats of a group, named as ST
// names them ("<group>: <date>"), are one tile with the members' faces; a click continues the
// latest, its action lists them all. The bin names a chat by its readable name, never ST's
// file name.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

let older: ChatId
let latest: ChatId

/** A chat as ST's import titles a group's: the group's name and the day it started. */
const groupChat = (title: string, cards: ReadonlyArray<EntityId>, content: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      for (const entityId of cards) {
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      }
      const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content })
      if (sent._tag !== "Posted") throw new Error("unexpected queue")
      return { chat, slotId: sent.entry.slotId }
    })
  )

test.beforeAll(async () => {
  const card = (label: string) => admin((api) => api.CreateCard({ label, name: label }))
  const ana = (await card("Ana")).entityId
  const mira = (await card("Mira")).entityId
  const tobin = (await card("Tobin")).entityId
  await card("Fen")
  older = (await groupChat("The Lantern Inn: 2026-4-3@18h00m00s000ms", [ana, mira, tobin], "Evening at the inn.")).chat
    .id
  await new Promise((done) => setTimeout(done, 20))
  latest = (await groupChat("The Lantern Inn: 2026-5-1@20h00m00s000ms", [ana, mira, tobin], "Back at the inn.")).chat.id
})

const grid = (page: Page) => page.getByRole("list", { name: "Characters and groups" })
const groupTile = (page: Page) => grid(page).getByRole("listitem").filter({ hasText: "The Lantern Inn" })

test("a group is one tile among the characters; a click continues its latest chat", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  // The group first (its chat is the latest), then the characters; never ST's file name.
  await expect(grid(page).getByRole("listitem")).toHaveCount(5)
  await expect(groupTile(page)).toContainText("Ana, Mira, Tobin")
  await expect(groupTile(page)).toContainText("2 chats")
  await expect(groupTile(page)).toContainText("Group · 3")
  await expect(grid(page)).not.toContainText("2026-5-1@")

  // The Groups filter, and search by a member's name finds the group.
  await page.getByRole("button", { name: /^Groups 1/ }).click()
  await expect(grid(page).getByRole("listitem")).toHaveText([/The Lantern Inn/])
  await page.getByRole("button", { name: /^All/ }).click()
  await page.getByLabel("Search characters and groups").fill("tobin")
  await expect(grid(page).getByRole("listitem")).toHaveText([/The Lantern Inn/, /Tobin/])
  await page.getByLabel("Search characters and groups").fill("")

  await page.getByRole("link", { name: /^The Lantern Inn, a group with Ana, Mira, Tobin: continue/ }).click()
  await expect(page).toHaveURL(`${server().url}/chats/${latest}`)
})

test("a group's chats are listed on its page, and deleting one names it readably", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  await groupTile(page).hover()
  await page.getByRole("link", { name: "All chats of The Lantern Inn" }).click()
  await expect(page).toHaveURL(`${server().url}/groups/${latest}`)
  const main = page.getByRole("main")
  await expect(main.getByRole("heading", { level: 1, name: "The Lantern Inn" })).toBeVisible()
  await expect(main.getByRole("link", { name: "Continue the latest chat" })).toHaveAttribute("href", `/chats/${latest}`)
  await expect(main.getByRole("list", { name: "Characters in the group" }).getByRole("link")).toHaveText([
    /Ana/,
    /Mira/,
    /Tobin/
  ])
  const chats = main.getByRole("list", { name: "Chats" }).getByRole("link")
  await expect(chats).toHaveCount(2)
  await expect(chats.first()).toHaveAttribute("href", `/chats/${latest}`)
  await expect(chats.last()).toHaveAttribute("href", `/chats/${older}`)

  // Deleting the chat the page is named by keeps the page, on the group's other chat.
  await chats.first().hover()
  await main.getByRole("button", { name: /^Delete The Lantern Inn, started May 1, 2026/ }).click()
  await expect(page.getByText("Deleted: The Lantern Inn, started May 1, 2026")).toBeVisible()
  await expect(page).toHaveURL(`${server().url}/groups/${older}`)
  await expect(chats).toHaveCount(1)

  await page.getByRole("button", { name: "Undo" }).click()
  await expect(chats).toHaveCount(2)
})

test("the bin names a message's chat by its readable name", async ({ page }) => {
  const { slotId } = await groupChat("Station Kepler: 2026-6-2@09h30m00s000ms", [], "Docking.")
  await admin((api) => api.DeleteMessage({ slotId }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/bin`)
  const main = page.getByRole("main")
  await expect(main.getByText("Message in “Station Kepler, started Jun 2, 2026”")).toBeVisible()
  await expect(main).not.toContainText("@09h30m")
})

test("on a phone, a group's tile shows its action", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  await expect(page.getByRole("link", { name: "All chats of The Lantern Inn" })).toBeVisible()
  await context.close()
})

test("long group and member names are readable on a touch screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  const names = ["Alexandria Corvina", "Mirabelle Windward", "Tobias Lanternkeeper"]
  const cards = await admin((api) => Effect.forEach(names, (name) => api.CreateCard({ label: name, name })))
  await groupChat(
    "Masquerade at Corvina Hall: 2026-4-3@18h00m00s000ms",
    cards.map((card) => card.entityId),
    "The guests arrive."
  )
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  const tile = grid(page).getByRole("listitem").filter({ hasText: "Masquerade at Corvina Hall" })
  for (const text of ["Masquerade at Corvina Hall", names.join(", ")]) {
    const label = tile.getByText(text, { exact: true })
    await expect(label).toBeVisible()
    expect(
      await label.evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)
    ).toBe(true)
  }
  await context.close()
})
