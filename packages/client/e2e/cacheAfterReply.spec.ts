// The cache chip while a reply is written (CacheIndicator.tsx): the server works out no
// estimate until the reply ends (CacheWarmth.hold), so the chip says it waits for the reply
// instead of showing the last estimate as current, then shows the one that follows.
import { join } from "node:path"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, REPLY, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cacheChip } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chatId: ChatId

test.beforeAll(async () => {
  provider = await startProvider()
  chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
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
        apiKey: "sk-cache-chip-test-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The road flooded.", speakerEntityId: null }
      })
      yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      return started.chat.id
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

test("while a reply is written the cache chip waits for it, then shows the estimate after it", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const chip = cacheChip(page)
  await expect(chip).toHaveText(/^Cache warm \d+:\d\d$/)

  provider.hold()
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("The tide turns.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(chip).toHaveText("Cache after reply")
  await expect(chip).toHaveAccessibleName("Cache: worked out again when this reply ends. Details")
  await chip.click()
  const details = page.getByRole("dialog", { name: "Cache", exact: true })
  await expect(details).toContainText("the estimate is worked out again when this reply ends")
  await page.keyboard.press("Escape")
  await expect(details).toHaveCount(0)
  for (const [width, theme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
    [390, "dark"]
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: theme })
    await expect(chip).toBeVisible()
    await shoot(page, `cache-after-reply-${width}-${theme}`)
  }

  provider.release()
  await expect(page.getByRole("article").filter({ hasText: REPLY })).toHaveCount(2)
  await expect(chip).toHaveText(/^Cache warm \d+:\d\d$/)
})
