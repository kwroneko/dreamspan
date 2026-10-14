// The home grid and a card's page (DESIGN §2.1): characters with their chat counts, personas
// left out, and the group chat as a group's tile among them (homeGroups.spec.ts has more); one click continues a character's latest chat, or opens a never-used one's
// greeting without making a chat; Inspect shows the card and every chat it's in.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

let mira: EntityId
let fen: EntityId
let single: ChatId
let group: ChatId

test.beforeAll(async () => {
  const card = (label: string) => admin((api) => api.CreateCard({ label, name: label }))
  mira = (await card("Mira")).entityId
  const ana = (await card("Ana")).entityId
  fen = (await card("Fen")).entityId
  const sam = (await card("Sam")).entityId
  await admin((api) => api.SetPersona({ entityId: sam, persona: true }))
  const start = (cards: ReadonlyArray<EntityId>, content: string) =>
    admin((api) =>
      api.StartChat({ cards, persona: sam, greeting: null, first: { _tag: "Send", content, speakerEntityId: sam } })
    )
  single = (await start([mira], "Alone at the harbor.")).chat.id
  // The group chat is the later one: Mira's latest.
  await new Promise((done) => setTimeout(done, 20))
  group = (await start([ana, mira], "All of us at the inn.")).chat.id
})

const chatCount = () => admin((api) => api.ListChats({ limit: 50, before: null })).then((chats) => chats.length)

const grid = (page: Page) => page.getByRole("list", { name: "Characters and groups" })
/** A character's tile, by its link ("Mira: continue the latest chat"), not a group naming it. */
const tile = (page: Page, label: string) =>
  grid(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: new RegExp(`^${label}:`) }) })

test("the grid shows characters with their chats, and one click goes into a conversation", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  await expect(page.getByRole("heading", { level: 1, name: "Characters" })).toBeVisible()
  // Most recently chatted first, never used last; the persona isn't a character. The group
  // chat is a group's tile too, named as the chat is (its cast, the persona included).
  await expect(grid(page).getByRole("listitem")).toHaveCount(4)
  await expect(grid(page).getByRole("listitem").filter({ hasText: "Ana & Mira & Sam" })).toContainText("Ana, Mira")
  await expect(tile(page, "Mira")).toContainText("2 chats")
  await expect(tile(page, "Ana")).toContainText("1 chat")
  await expect(tile(page, "Fen")).toContainText("Never used")
  await expect(tile(page, "Sam")).toHaveCount(0)
  await expect(grid(page).getByRole("listitem").last()).toContainText("Fen")

  // Search and the never-used filter.
  await page.getByLabel("Search characters and groups").fill("fe")
  await expect(grid(page).getByRole("listitem")).toHaveText([/Fen/])
  await page.getByLabel("Search characters and groups").fill("")
  await page.getByRole("button", { name: /Never used/ }).click()
  await expect(grid(page).getByRole("listitem")).toHaveText([/Fen/])
  await page.getByRole("button", { name: /^All/ }).click()

  // A used character continues its latest chat.
  await page.getByRole("link", { name: /^Mira: continue the latest chat/ }).click()
  await expect(page).toHaveURL(`${server().url}/chats/${group}`)

  // A never-used one shows its greeting, and nothing is made until the first message.
  await page.goto(`${server().url}/`)
  await page.getByRole("link", { name: /^Fen: start a chat/ }).click()
  await expect(page).toHaveURL(`${server().url}/cards/${fen}/chat`)
  await expect(page.getByRole("heading", { name: "Fen" })).toBeVisible()
  expect(await chatCount()).toBe(2)
})

test("Inspect opens the card's page, with Continue, New chat and every chat it's in", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  await tile(page, "Mira").hover()
  await page.getByRole("link", { name: "Inspect Mira" }).click()
  await expect(page).toHaveURL(`${server().url}/cards/${mira}`)
  await expect(page.getByRole("heading", { level: 1, name: "Mira" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Definition" })).toBeVisible()

  const main = page.getByRole("main")
  await expect(main.getByRole("link", { name: "Continue", exact: true })).toHaveAttribute("href", `/chats/${group}`)
  await expect(main.getByRole("link", { name: "New chat", exact: true })).toHaveAttribute("href", `/cards/${mira}/chat`)
  await expect(main.getByRole("link", { name: "Edit card" })).toHaveAttribute("href", /^\/library\//)
  // Both chats as peers, the group chat (latest) first, with its whole cast.
  const chats = main.getByRole("list", { name: "Chats" }).getByRole("link")
  await expect(chats).toHaveCount(2)
  await expect(chats.first()).toHaveAttribute("href", `/chats/${group}`)
  await expect(chats.first()).toContainText("Ana")
  await expect(chats.last()).toHaveAttribute("href", `/chats/${single}`)
  await expect(main.getByRole("list", { name: "Chats" })).toContainText("All of us at the inn.")

  await chats.last().click()
  await expect(page).toHaveURL(`${server().url}/chats/${single}`)

  // A never-used card's page offers New chat and says there are no chats yet.
  await page.goto(`${server().url}/cards/${fen}`)
  await expect(page.getByText("No chats yet")).toBeVisible()
  await expect(main.getByRole("link", { name: "Continue", exact: true })).toHaveCount(0)
  await main.getByRole("link", { name: "New chat", exact: true }).click()
  await expect(page).toHaveURL(`${server().url}/cards/${fen}/chat`)
  expect(await chatCount()).toBe(2)
})

test("on a phone, the chats are a page of their own and each tile's actions are on show", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  await expect(page.getByRole("link", { name: "New chat with Mira" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Inspect Mira" })).toBeVisible()
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Chats" }).click()
  await expect(page).toHaveURL(`${server().url}/chats`)
  await expect(page.getByRole("main").getByRole("list", { name: "Chats" }).getByRole("link")).toHaveCount(2)
  await context.close()
})
