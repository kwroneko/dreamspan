import { join } from "node:path"
import { Effect } from "effect"
import { expect, test } from "@playwright/test"
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import { png } from "../../server/test/formats/support.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { startProvider, type FakeProvider, REPLY } from "./support/provider.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { removeAttachment } from "./support/attachments.ts"

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

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`image estimates, draft uploads and inspector at ${width} ${theme}`, async ({ page }) => {
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/chats/${chat.id}`)
      await expect(page.getByTestId("messages").getByText(REPLY, { exact: true })).toBeVisible()
      await expect(page.getByText(/1 image in the next request: ~255 tokens/)).toBeVisible()
      await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
      await page
        .getByLabel("Choose images", { exact: true })
        .setInputFiles({ name: "draft-drawing.png", mimeType: "image/png", buffer: png() })
      await expect(page.getByText(/2 images in the next request: ~510 tokens/)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `composer-${width}-${theme}.png`) })
      await removeAttachment(page.getByRole("button", { name: "Remove draft-drawing.png", exact: true }))
      await expect(page.getByText(/1 image in the next request: ~255 tokens/)).toBeVisible()
      await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
      const badge = page.getByText("Image 1: ~255 tokens", { exact: true })
      await expect(badge).toBeVisible()
      await badge.scrollIntoViewIfNeeded()
      await expect(page.getByText("provider's formula", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `inspector-${width}-${theme}.png`) })
    })
  }
