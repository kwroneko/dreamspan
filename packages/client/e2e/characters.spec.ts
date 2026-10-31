// The home grid and a card's page (DESIGN §2.1): characters with their chat counts, personas
// left out, and the group chat as a group's tile among them (homeGroups.spec.ts has more); one click continues a character's latest chat, or opens a never-used one's
// greeting without making a chat; Inspect shows the card and every chat it's in.
import { expect, test } from "@playwright/test"
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

test("home keeps characters separate from Groups and retains Never used", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const main = page.getByRole("main")
  await expect(main.getByRole("button", { name: /^Open / })).toHaveCount(3)
  await expect(main.getByRole("button", { name: "Open Mira", exact: true })).toContainText("2 chats")
  await main
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "Never used", exact: true })
    .click()
  await expect(main.getByRole("button", { name: /^Open / })).toHaveCount(1)
  await expect(main.getByRole("button", { name: "Open Fen", exact: true })).toBeVisible()
  await main.getByRole("button", { name: "Open Fen", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cards/${fen}/chat`))
  expect(await chatCount()).toBe(2)
})

test("a card opens all three panels, with its definition and actions beside the chat", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page.getByRole("main").getByRole("button", { name: "Open Mira", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${group}`))
  await expect(page.getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText("Mira")
  // In a chat, the card's tab has the Cast row's actions, the full editor among them (f55e4e7).
  const tab = page.getByRole("tabpanel", { name: "Mira", exact: true })
  await expect(tab.getByRole("button", { name: "Open Mira in the full editor", exact: true })).toBeVisible()
  await tab.getByRole("button", { name: "More for Mira", exact: true }).click()
  await page.getByRole("menuitem", { name: "New chat with Mira", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cards/${mira}/chat`))
  expect(await chatCount()).toBe(2)
})

test("the explicit card page lists individual chats, and Continue selects the character", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/cards/${mira}`)
  const main = page.getByRole("main")
  await expect(main.getByRole("heading", { name: "Definition", exact: true })).toBeVisible()
  await expect(main.getByRole("button", { name: /^Open chat / })).toHaveCount(2)
  await main.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${group}`))
  await page.goto(`${server().url}/chats/${single}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
})

test("on a phone the home tiles open a card sheet and Chats is its own page", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page.getByRole("main").getByRole("button", { name: "Open Mira", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Chats", exact: true }).click()
  await expect(page.getByRole("main").getByRole("list", { name: "Chats" }).getByRole("link")).toHaveCount(2)
  await context.close()
})
