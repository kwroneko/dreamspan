// Moving from one chat to another with a character's tab open: the panel follows the chat it's
// in. A card tab names one chat's character; carried to another chat (by a sidebar pick, or by
// the tab this browser remembers) the panel opens at This chat, never at the previous chat's card
// with its edit controls (the UI audit's §8). Every card here is made up.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const card = (name: string) => ({
  name,
  description: `${name} mends nets on the quay and hums while doing it.`,
  personality: "Patient.",
  scenario: "",
  first_mes: `${name} looks up. "Oh, it's you."`,
  mes_example: ""
})

let first = { chat: "", card: "" }
let second = { chat: "", card: "" }
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const name of ["Odalys Fenwick", "Marguerite Quill"]) await importCard(page, card(name))
  await page.close()
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  const id = (name: string) => refs.find((ref) => ref.label === name)!.entityId as EntityId
  const started = await admin((api) =>
    Effect.all([
      api.StartChat({
        cards: [id("Odalys Fenwick")],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello, Odalys.", speakerEntityId: null }
      }),
      api.StartChat({
        cards: [id("Marguerite Quill")],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello, Marguerite.", speakerEntityId: null }
      })
    ])
  )
  first = { chat: started[0].chat.id, card: id("Odalys Fenwick") }
  second = { chat: started[1].chat.id, card: id("Marguerite Quill") }
})

/** The panel shows the second chat's own tabs and nothing of the first's card. */
const showsSecond = async (page: Page) => {
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  await expect(panel.getByRole("tab", { name: "This chat", exact: true })).toHaveAttribute("aria-selected", "true", {
    timeout: 30_000
  })
  await expect(panel.getByRole("tab", { name: "Marguerite Quill", exact: true })).toBeVisible()
  await expect(panel.getByText("Odalys Fenwick")).toHaveCount(0)
  await expect(panel.getByRole("tab", { name: "Character", exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/chats/${second.chat}\\?(.*&)?panel=chat(&|$)`))
  // Its own character's tab edits its own card.
  await panel.getByRole("tab", { name: "Marguerite Quill", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Marguerite Quill", exact: true })).toBeVisible()
  await expect(panel.getByRole("textbox", { name: "Description", exact: true })).toContainText(
    "Marguerite Quill mends nets"
  )
}

test("a sidebar pick of another chat leaves the previous chat's character", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${first.chat}?panel=card:${first.card}`)
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  await expect(panel.getByRole("heading", { name: "Odalys Fenwick", exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("link", { name: /^Open chat Marguerite Quill/ }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${second.chat}`))
  await showsSecond(page)
})

test("the tab this browser remembers leaves the previous chat's character", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${first.chat}?panel=card:${first.card}`)
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  await expect(panel.getByRole("heading", { name: "Odalys Fenwick", exact: true })).toBeVisible({ timeout: 30_000 })
  // Chosen, so this browser remembers it; then a chat opened afresh, with no tab in the URL.
  await page.getByRole("tab", { name: "Cast", exact: true }).click()
  await page.getByRole("tab", { name: "Odalys Fenwick", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Odalys Fenwick", exact: true })).toBeVisible()
  await page.goto(`${server().url}/chats/${second.chat}`)
  await showsSecond(page)
})

test("a link carrying another chat's card tab leaves that card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${second.chat}?panel=card:${first.card}`)
  await showsSecond(page)
})
