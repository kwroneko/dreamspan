import { Effect } from "effect"
import { expect, test } from "@playwright/test"
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import { png } from "../../server/test/formats/support.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chat: { id: ChatId; reply: VersionId }

test.beforeAll(async () => {
  provider = await startProvider()
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const headers = { cookie, origin: server().url, "content-type": "application/octet-stream" }
  const card = await fetch(`${server().url}/library/import?name=Mira.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Mira",
        description: "Mira studies maps of the harbor.",
        first_mes: "Show me your drawing."
      }
    })
  })
  expect(card.status).toBe(200)
  const uploaded = await fetch(`${server().url}/chat/image`, { method: "POST", headers, body: png() })
  expect(uploaded.status).toBe(200)
  const image = (await uploaded.json()) as { mediaId: string }
  chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic vision provider",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "gpt-4o", overrides: { vision: true } })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "What does this drawing show?", speakerEntityId: null, images: [image] }
      })
      const reply = yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      if (reply._tag !== "Posted") return yield* Effect.die("Expected a posted reply")
      return { id: started.chat.id, reply: reply.entry.version.id }
    })
  )
})
test.afterAll(async () => {
  await provider?.stop()
})

test("inspector: a sent image shows at its message and opens in the viewer", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  const thumbnail = page.getByRole("button", { name: /^Image 1, sent to the model, / })
  await expect(thumbnail).toBeVisible()
  await expect(thumbnail.locator("img")).toBeVisible()
  await expect(thumbnail).toHaveAccessibleName("Image 1, sent to the model, ~255 tokens")
  // It sits in the message that carries the image, not in another one.
  await expect(
    page.locator("details", { has: thumbnail }).getByText("What does this drawing show?").first()
  ).toBeVisible()
  await thumbnail.scrollIntoViewIfNeeded()
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/inspector-image-1920-dark.png` })
  await thumbnail.click()
  await expect(page.getByRole("img", { name: /Image 1/ }).last()).toBeVisible()
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/inspector-image-open-1920-dark.png` })
})
