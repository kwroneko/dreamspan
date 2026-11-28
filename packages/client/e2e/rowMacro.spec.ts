// A chat row's preview of a greeting shows its macros replaced, as the chat shows them:
// `{{user}}` is the persona's name, `{{char}}` the greeter's. The sidebar and the Chats page.
import { expect, test } from "@playwright/test"
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let chatId: ChatId
let greetingFork: ForkId

test.beforeAll(async ({ request }) => {
  await apiLogin(request, server(), ADMIN.handle, ADMIN.password)
  const response = await request.post(`${server().url}/library/import?name=greeter.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Ana",
          description: "A harbor pilot.",
          first_mes: "What would you like to work on, {{user}}? I am {{char}}."
        }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const greeter = (yield* api.ListCards()).find((c) => c.name === "Ana")!
      const persona = yield* api.CreateCard({ label: "Sam", name: "Sam" })
      yield* api.SetPersona({ entityId: persona.entityId, persona: true })
      const started = yield* api.StartChat({
        cards: [greeter.entityId],
        persona: persona.entityId,
        greeting: 0,
        first: { _tag: "Send", content: "A typed start.", speakerEntityId: persona.entityId }
      })
      chatId = started.chat.id
      const path = yield* api.ReadPath({
        chatId,
        forkId: null,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })
      // A branch that ends at the greeting: the row's last message is the greeting.
      const fork = yield* api.CreateFork({ chatId, fromForkId: null, atSlotId: path.entries[0]!.slotId })
      greetingFork = fork.fork.id
    })
  )
})

const WELCOME = "What would you like to work on, Sam? I am Ana."

for (const width of [1440, 390])
  test(`a greeting's macros are replaced in the chat rows at ${width}`, async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    // The Chats page.
    await page.goto(`${server().url}/chats`)
    const greetingRow = `[data-chat-id="${chatId}"][data-fork-id="${greetingFork}"]`
    const row = page.getByRole("main").locator(`a[href^="/chats/${chatId}?"][href*="fork=${greetingFork}"]`)
    await expect(row).toContainText(WELCOME, { timeout: 90_000 })
    await expect(row).not.toContainText("{{")
    // The sidebar's rows.
    await page.goto(`${server().url}/`)
    if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    const panel =
      width === 390 ? page.locator(".fixed.inset-0") : page.getByRole("complementary", { name: "Sidebar", exact: true })
    const chats = panel.getByRole("region", { name: "Chats", exact: true })
    const sidebarRow = chats.locator(greetingRow)
    await expect(sidebarRow).toContainText(WELCOME)
    await expect(sidebarRow).not.toContainText("{{")
  })
