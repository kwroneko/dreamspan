// The request inspector and the cache-warmth indicator (DESIGN §5.5, §7.4), against the
// production server, which generates through the context assembler and the provider
// layer, here a fake OpenAI-compatible provider on loopback. The card is made up.
import { join } from "node:path"
import type { ChatId, EntityId, VersionId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, REPLY, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chat: { readonly id: ChatId; readonly reply: VersionId }

/** Imports a file into the library as the admin, as the import screen does; returns its ref. */
const importFile = async (name: string, file: unknown): Promise<RefId> => {
  const login = await fetch(`${server().url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN)
  })
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!
  const imported = await fetch(`${server().url}/library/import?name=${name}`, {
    method: "POST",
    headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
    body: JSON.stringify(file)
  })
  expect(imported.status).toBe(200)
  return ((await imported.json()) as { library: { ref: { id: RefId } } }).library.ref.id
}

test.beforeAll(async () => {
  provider = await startProvider()
  await importFile("Mira.json", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Mira", description: "{{char}} keeps the harbor ledger.", first_mes: "*Mira looks up.*" }
  })
  chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-inspector-test-key-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId as EntityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "The road flooded.", speakerEntityId: null }
      })
      const reply = yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { id: started.chat.id, reply: reply.entry.version.id }
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const violations: Array<string> = []
test.beforeEach(({ page }) => {
  violations.length = 0
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
})
test.afterEach(() => expect(violations).toEqual([]))

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
}

const reply = (page: Page) => page.getByRole("article", { name: "Reply" }).filter({ hasText: REPLY })

test("a reply's context opens from the reply, with its sources and the cache breakpoints", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(reply(page)).toContainText(REPLY)
  await reply(page).getByRole("link", { name: "Context" }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}/context/${chat.reply}$`))
  const messages = page.getByRole("region", { name: "Messages" })
  await expect(messages.getByText("Card “Mira”: description")).toBeVisible()
  await expect(messages.getByText("Preset prompt “Main Prompt”")).toBeVisible()
  await expect(messages.getByText("Cache breakpoint: the end of the preset's part")).toBeVisible()
  await expect(messages.getByText("Cache breakpoint: the end of the history the next request repeats")).toBeVisible()
  await expect(page.getByText("fake-small on Local model server (openai-chat)")).toBeVisible()
  // What the provider reported: 100 tokens read from its cache, 6 written.
  await expect(page.getByRole("row", { name: /complete/ })).toContainText("100")
  // A message opens to its full text, shown as text.
  await messages.getByText("Card “Mira”: description").click()
  await expect(messages.getByText("Mira keeps the harbor ledger.").last()).toBeVisible()
  await shoot(page, "inspector")
  // The message sources link back to the chat.
  await messages.getByRole("link", { name: "Message 2" }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}\\?slot=`))
})

test("the cache indicator is warm after a reply, and cold once an earlier message is edited", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const estimate = page.getByRole("region", { name: "Cache estimate" })
  await expect(estimate).toContainText("Cache warm (estimate)")
  await expect(estimate).toContainText("The provider reported using its cache")
  await expect(estimate).toContainText(/\d:\d\d left/)
  await estimate.getByRole("button", { name: "Hide countdown" }).click()
  await expect(estimate).not.toContainText("left")
  await estimate.getByRole("button", { name: "Show countdown" }).click()
  await shoot(page, "cache-warm")

  const mine = page.getByRole("article", { name: "Your message" })
  await mine.getByRole("button", { name: "Edit" }).click()
  await mine.getByLabel("Message text").fill("The road washed out.")
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(estimate).toContainText("Cache cold (estimate)")
  await expect(estimate).toContainText("Message 2 was")
  await expect(estimate).toContainText(/writes about \d+ tokens to the cache again/)
  await shoot(page, "cache-cold")
})

test("the inspector fits a phone's width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  await expect(page.getByRole("region", { name: "Messages" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

/** About 2,000 characters: 500 tokens. */
const entry = (i: number) => `Entry ${i}: ${"the tide came in and went out again. ".repeat(54)}`

test("a long context opens collapsed: 200 messages, about 100,000 tokens", async ({ page }) => {
  const preset = await importFile("Long.json", { openai_max_context: 200_000, openai_max_tokens: 300 })
  const long = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const [connection] = yield* api.ListConnections()
      const model = yield* api.AddUserModel({
        connectionId: connection!.id,
        key: "fake-large",
        overrides: { context: 200_000 }
      })
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId as EntityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "The tide log begins.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Preset", ref: preset } })
      yield* api.ChangeCast({
        chatId,
        slotId: null,
        change: { _tag: "Model", connection: connection!.id, model: model.id }
      })
      let parent = started.entry.slotId
      for (let i = 0; i < 200; i++) {
        const sent = yield* api.SendMessage({
          chatId,
          parentSlotId: parent,
          branch: false,
          content: entry(i)
        })
        if (sent._tag !== "Posted") return yield* Effect.die(new Error("a message was queued"))
        parent = sent.entry.slotId
      }
      const reply = yield* api.Generate({ chatId, parentSlotId: parent, branch: false })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { id: chatId, reply: reply.entry.version.id }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${long.id}`)
  await expect(reply(page)).toBeVisible()
  await page.goto(`${server().url}/chats/${long.id}/context/${long.reply}`)
  const messages = page.getByRole("region", { name: "Messages" })
  await expect(messages.getByRole("listitem")).toHaveCount(205)
  await expect(page.getByText(/about 10\d,\d{3} tokens/)).toBeVisible()
  // Collapsed, the page holds a preview of each message, not its text.
  expect(await page.evaluate(() => document.body.textContent.length)).toBeLessThan(80_000)
  // Opened, a message shows all of its text.
  await messages.getByText("#153", { exact: true }).click()
  await expect(messages.locator("p", { hasText: "Entry 147:" })).toHaveText(entry(147).trim())
})
