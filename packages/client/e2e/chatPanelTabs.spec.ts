// The side panel's tabs leading with what a person touches (night/ftabs): This chat's name,
// persona and summaries before the advanced, collapsed parts; the persona's tab as its
// description edited in place, with Switch persona; History edits before a search (the Model
// tab's form is models.spec.ts's). Every card here is made up.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

const PERSONA = Array.from(
  { length: 4 },
  (_, i) => `Juniper maps the places nobody else bothers with, part ${i + 1}: drowned villages and old pilgrim roads.`
).join("\n\n")

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

let chat = ""
let persona = "" as EntityId
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await importCard(page, { name: "Mira", description: "A harbor pilot who reads the tides.", first_mes: "Hello." })
  await importCard(page, { name: "Juniper Ashgrove", description: PERSONA })
  await importCard(page, { name: "Wren", description: "Another persona." })
  await page.close()
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  const id = (name: string) => refs.find((ref) => ref.label === name)!.entityId as EntityId
  persona = id("Juniper Ashgrove")
  await admin((api) =>
    Effect.all([
      api.SetPersona({ entityId: persona, persona: true }),
      api.SetPersona({ entityId: id("Wren"), persona: true })
    ])
  )
  const started = await admin((api) =>
    api.StartChat({
      cards: [id("Mira")],
      persona,
      greeting: null,
      first: { _tag: "Send", content: "Is anyone here?", speakerEntityId: null }
    })
  )
  chat = started.chat.id
})

const open = async (page: Page, panel?: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat}${panel ? `?panel=${encodeURIComponent(panel)}` : ""}`)
}

test("This chat leads with the chat's name, your persona and summaries; the rest is collapsed", async ({ page }) => {
  await open(page)
  const tab = await openPanel(page, "This chat")
  await expect(tab.getByRole("heading", { level: 2 })).toContainText("Mira")
  const you = tab.getByRole("group", { name: "Your persona", exact: true })
  await expect(you).toContainText("Juniper Ashgrove")
  await expect(you.getByRole("button", { name: /^Playing as Juniper Ashgrove/ })).toHaveText("Switch persona")
  await expect(tab.getByRole("switch", { name: /Summarize older messages/ })).toBeVisible()
  // In this order, before anything about macros.
  const text = (await tab.innerText()).replace(/\s+/g, " ")
  const at = (part: string) => text.indexOf(part)
  expect(at("You play")).toBeGreaterThan(-1)
  expect(at("You play")).toBeLessThan(at("Summarize older messages"))
  expect(at("Summarize older messages")).toBeLessThan(at("Advanced: names in prompts"))
  // Collapsed: the names, the roles and the summary settings' fields aren't shown.
  await expect(tab.getByRole("region", { name: "Names in prompts" })).toBeHidden()
  await expect(tab.getByRole("radiogroup")).toBeHidden()
  await expect(tab.getByText("Recent messages kept as written")).toHaveCount(0)
  await tab.getByText("Advanced: names in prompts", { exact: true }).click()
  await expect(tab.getByRole("form", { name: "Your name in prompts" })).toBeVisible()
  // Summary settings are with the summaries, once.
  await tab.getByRole("button", { name: "Summaries", exact: true }).click()
  const summaries = page.getByRole("tabpanel", { name: "Summaries" })
  await summaries.getByText("Summary settings", { exact: true }).click()
  await expect(summaries.getByRole("group", { name: "Recent messages kept as written" })).toBeVisible()
})

test("the persona's tab is its description, edited in place, and Switch persona", async ({ page }) => {
  await open(page, `card:${persona}`)
  const tab = page.getByRole("tabpanel", { name: "Juniper Ashgrove" })
  await expect(tab.getByText("You play", { exact: true })).toBeVisible()
  await expectTextBox(tab.getByRole("textbox", { name: "Description", exact: true }), PERSONA)
  // One field; no New chat, no count of chats, no card actions meant for characters.
  await expect(tab.getByRole("textbox")).toHaveCount(1)
  await expect(tab).not.toContainText(/used by|New chat/)
  await expect(tab.getByRole("button", { name: /^Fork for this chat/ })).toHaveCount(0)
  await expect(tab.getByRole("button", { name: "Open Description large" })).toBeVisible()
  // Edited in place, saved with the sticky Save.
  const box = tab.getByRole("textbox", { name: "Description", exact: true })
  await box.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" She hums.")
  const save = tab.getByRole("button", { name: /^Save/ })
  await expect(save).toBeEnabled()
  // Switch persona plays another card from here on.
  await tab.getByRole("button", { name: /^Playing as Juniper Ashgrove/ }).click()
  await page.getByRole("option", { name: /^Wren/ }).click()
  await expect(page.getByRole("tab", { name: "Wren" })).toBeAttached()
})

test("History edits doesn't ask for a model before a search", async ({ page }) => {
  await open(page)
  const tab = await openPanel(page, "History edits")
  await expect(tab.getByLabel("Find", { exact: true })).toBeVisible()
  await expect(tab).not.toContainText("Choose a model")
  await expect(tab).not.toContainText("0 in messages")
  await tab.getByLabel("Find", { exact: true }).fill("anyone")
  await expect(tab.getByRole("status")).toContainText("1 in messages")
  await expect(tab).toContainText(/re-read about \d+ messages/)
})
