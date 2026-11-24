// New chats are pending chats (DESIGN §2.1, owner 2026-11-23): the new-chat page opens a real
// chat the server keeps out of every list until its first turn, shown by the chat page itself.
import { expect, test, type Page } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "10000", FAKE_GENERATOR_TOKENS: "10" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
    data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  const cards = await admin((api) => api.ListCards())
  return cards.find((card) => card.name === data.name)!
}

/** Everything account-wide a draft must not change: lists, counts, last used times. */
const accountState = () =>
  admin((api) =>
    Effect.map(
      Effect.all({
        cards: api.GetShellCards(),
        usage: api.ListCardUsage(),
        library: api.GetShellLibrary(),
        chats: api.ListChats({ limit: 500, before: null })
      }),
      (state) => JSON.stringify(state)
    )
  )

const draftOf = (page: Page) => new URL(page.url()).searchParams.get("draft")

const listed = async (chatId: string) =>
  (await admin((api) => api.ListChats({ limit: 500, before: null }))).some((chat) => chat.id === chatId)

const composer = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true })

const chatUrl = (chatId: string) => new RegExp(`/chats/${chatId}(\\?|$)`)

/** Opens a new chat at `path` and answers its pending chat's id, once its page shows it. */
const openDraft = async (page: Page, path: string) => {
  await page.goto(`${server().url}${path}`)
  await expect.poll(() => draftOf(page)).not.toBeNull()
  await expect(composer(page)).toBeEditable()
  return draftOf(page)!
}

const start = async (page: Page) => {
  await page.setViewportSize({ width: 1340, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

test.describe.configure({ mode: "parallel" })

test("a card's new chat changes nothing until it starts, and a reload keeps it", async ({ page }) => {
  await start(page)
  const card = await importCard(page, {
    name: "Mira Reload",
    first_mes: "Mira opens the door.",
    alternate_greetings: ["Mira waves.", "Mira smiles."]
  })
  const before = await accountState()
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  const greeting = page.getByRole("article").filter({ hasText: /Mira (opens the door|waves|smiles)\./ })
  await expect(greeting).toContainText("Mira Reload")
  const shown = await greeting.locator(".markdown").innerText()
  // Not in the sidebar, nor in any list or count; the card's last use is as it was.
  await expect(page.locator(`[data-chat-id="${draft}"]`)).toHaveCount(0)
  expect(await accountState()).toBe(before)
  await page.reload()
  await expect(greeting).toContainText("Mira Reload")
  expect(draftOf(page)).toBe(draft)
  expect(await greeting.locator(".markdown").innerText()).toBe(shown)
  expect(await accountState()).toBe(before)
})

test("saving an edit of the greeting starts the chat", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Edit", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  const greeting = page.getByRole("article").filter({ hasText: "Mira opens the door." })
  await showActions(greeting)
  await greeting.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = greeting.getByRole("textbox", { name: "Message text", exact: true })
  await editor.fill("Mira opens the door wide.")
  await greeting.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page).toHaveURL(chatUrl(draft))
  await expect(page.getByRole("article").filter({ hasText: "Mira opens the door wide." })).toBeVisible()
  expect(await listed(draft)).toBe(true)
  await expect(page.locator(`[data-chat-id="${draft}"]`).first()).toBeVisible()
})

test("a new chat left unsent is swept, its typing in recovered texts, nothing in the bin", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Leave", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  await composer(page).fill("Words typed and never sent.")
  // The composer's draft is saved on the server before the page is left.
  await expect
    .poll(() =>
      admin((api) => Effect.map(api.OpenComposer({ chatId: draft as ChatId, forkId: null }), (d) => d.content))
    )
    .toBe("Words typed and never sent.")
  // Typing kept its tab, which Home opens beside: closing the tab leaves the chat.
  await page.getByRole("link", { name: "Home", exact: true }).first().click()
  await page.getByRole("button", { name: /^Close Mira Leave/ }).click()
  await expect(page).not.toHaveURL(/draft=/)
  await expect
    .poll(
      async () =>
        (await admin((api) => api.ListRecoveredTexts({ limit: 50, before: null }))).map((text) => text.sourceLabel),
      { timeout: 20_000 }
    )
    .toContain("New chat with Mira Leave")
  expect(await listed(draft)).toBe(false)
  expect(await admin((api) => api.ListBin({ limit: 50, before: null }))).toEqual([])
})

test("sending a message starts the chat with the greeting and the message", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Send", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  await composer(page).fill("Hello, Mira.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(chatUrl(draft))
  await expect(page.getByRole("article").filter({ hasText: "Hello, Mira." })).toBeVisible()
  await expect(page.getByRole("article").filter({ hasText: "Mira opens the door." })).toBeVisible()
  expect(await listed(draft)).toBe(true)
})

for (const kind of ["group", "empty"] as const)
  test(`a new ${kind} chat is a draft the same way`, async ({ page }) => {
    await start(page)
    let entry = "/new/chat"
    if (kind === "group") {
      const first = await importCard(page, { name: "Group Ana", first_mes: "Ana says hi." })
      const second = await importCard(page, { name: "Group Ben", first_mes: "Ben nods." })
      const group = await admin((api) =>
        api.StartChat({
          cards: [first.entityId, second.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "An earlier group chat.", speakerEntityId: null }
        })
      )
      entry = `/groups/${group.chat.id}/new`
    }
    const before = await accountState()
    const draft = await openDraft(page, entry)
    if (kind === "group") {
      await expect(page.getByRole("article").filter({ hasText: "Ana says hi." })).toBeVisible()
      await expect(page.getByRole("article").filter({ hasText: "Ben nods." })).toBeVisible()
    } else await expect(page.locator("[data-empty-chat-intro]")).toBeVisible()
    expect(await accountState()).toBe(before)
    await composer(page).fill("The first words.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(chatUrl(draft))
    await expect(page.getByRole("article").filter({ hasText: "The first words." })).toBeVisible()
    expect(await listed(draft)).toBe(true)
  })
