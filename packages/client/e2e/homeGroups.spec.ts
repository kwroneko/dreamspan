// Groups on the home grid (DESIGN §2.1; ST's group tiles): the chats of a group, named as ST
// names them ("<group>: <date>"), are one tile with the members' faces; a click continues the
// latest, its action lists them all. The bin names a chat by its readable name, never ST's
// file name.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

let older: ChatId
let latest: ChatId
let latestCreatedAt: number

/** How the app writes the day a chat started: its `createdAt`, not its ST file name's stamp (importreport). */
const startedDay = (createdAt: number) =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }).format(new Date(createdAt))

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
  const latestChat = (
    await groupChat("The Lantern Inn: 2026-5-1@20h00m00s000ms", [ana, mira, tobin], "Back at the inn.")
  ).chat
  latest = latestChat.id
  latestCreatedAt = latestChat.createdAt
})

const grid = (page: Page) => page.getByRole("main").getByLabel("Groups", { exact: true })

test("Groups lists each multi-character chat as a tile and scopes its forks on opening", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "Groups", exact: true })
    .click()
  await expect(grid(page).getByRole("link", { name: "Open chat The Lantern Inn", exact: true })).toHaveCount(2)
  // The faces show who; the tile counts them, the names in its tooltip.
  await expect(grid(page)).toContainText("3 members")
  await expect(grid(page).getByTitle("Ana, Mira, Tobin").first()).toBeVisible()
  await grid(page).getByRole("link", { name: "Open chat The Lantern Inn", exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/chats/${latest}`))
  await expect(page.getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText("The Lantern Inn")
})

test("a group's chats are listed on its page, and deleting one names it readably", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/groups/${latest}`)
  await expect(page).toHaveURL(`${server().url}/groups/${latest}`)
  const main = page.getByRole("main")
  await expect(main.getByRole("heading", { level: 1, name: "The Lantern Inn" })).toBeVisible()
  await expect(main.getByRole("link", { name: "Continue the latest chat" })).toHaveAttribute("href", `/chats/${latest}`)
  await expect(main.getByRole("list", { name: "Characters in the group" }).getByRole("button")).toHaveText([
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
  await main
    .getByRole("button", { name: new RegExp(`^Delete The Lantern Inn, started ${startedDay(latestCreatedAt)}`) })
    .click()
  // A bin item has only the title, so its name keeps the file stamp's day (importreport).
  await expect(page.getByText("The Lantern Inn, started May 1, 2026 moved to the bin.")).toBeVisible()
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
  await expect(main.getByText("Message 1 in “Station Kepler, started Jun 2, 2026”")).toBeVisible()
  await expect(main).not.toContainText("@09h30m")
})

test("on a phone group tiles open their current fork", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "Groups", exact: true })
    .click()
  await grid(page).getByRole("link", { name: "Open chat The Lantern Inn", exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/chats/${latest}`))
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
  await page
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "Groups", exact: true })
    .click()
  const tile = grid(page).getByRole("link", { name: "Open chat Masquerade at Corvina Hall", exact: true })
  // The members are counted on the tile; their names are its tooltip (UI audit, 2026-10-31).
  await expect(tile.getByTitle(names.join(", "), { exact: true })).toBeVisible()
  for (const text of ["Masquerade at Corvina Hall", "3 members"]) {
    const label = tile.getByText(text, { exact: true })
    await expect(label).toBeVisible()
    expect(
      await label.evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)
    ).toBe(true)
  }
  await context.close()
})
