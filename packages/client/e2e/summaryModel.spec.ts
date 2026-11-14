// Choosing the model that writes summaries (audit item 067): Settings → Chats sets the account's
// ("Same as the chat's model" until one is chosen), and a chat's Summary settings set its own,
// or follow the account's again (each kept over a reload), at 1440 and 390 in light and dark, with the layout audit.
// Synthetic card; the connection is local and never called.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { openSummarySettings } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let cookie: string
let chatId: ChatId
let connection: string
const rpc = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  ;({ chatId, connection } = await rpc((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Summary fixture", name: "Summary fixture" })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "A synthetic story begins.", speakerEntityId: null }
      })
      const local = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* api.AddUserModel({ connectionId: local.id, key: "cheap-model", overrides: {} })
      yield* api.AddUserModel({ connectionId: local.id, key: "story-model", overrides: {} })
      return { chatId: started.chat.id, connection: local.id as string }
    })
  ))
})

const pick = async (page: import("@playwright/test").Page, trigger: string, model: string) => {
  await page.getByRole("button", { name: trigger, exact: true }).click()
  const picker = page.locator("[data-model-picker]")
  await picker.getByRole("searchbox", { name: "Find a model", exact: true }).fill(model)
  await picker.getByRole("radio", { name: new RegExp(model) }).click()
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`summary model in settings and in a chat at ${width} in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await rpc((api) => api.ChangeGenerationDefaults({ change: { summarizer: null } }))
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)

      // The account's: the chat's model until one is chosen.
      await page.goto(`${server().url}/settings/chats`)
      const models = page.getByRole("region", { name: "Models for summaries" })
      const account = models.getByRole("button", { name: "Summary model", exact: true })
      await expect(account).toContainText("Same as the chat's model")
      await expectLayout(page, info, `summary-model-settings-${width}-${theme}`, {
        scope: 'section[aria-label="Models for summaries"]'
      })
      await page.screenshot({ path: info.outputPath(`settings-${width}-${theme}.png`) })
      await pick(page, "Summary model", "cheap-model")
      await expect(account).toContainText("cheap-model")
      await expect
        .poll(() => rpc((api) => api.GetGenerationDefaults()).then((d) => d.lcm?.summarizer?.connection))
        .toBe(connection)

      // The chat follows the account's, then picks its own, then follows again.
      await page.goto(`${server().url}/chats/${chatId}`)
      const section = await openSummarySettings(page)
      const own = section.getByRole("button", { name: "This chat's summary model", exact: true })
      await expect(own).toContainText("Account default: Local · cheap-model")
      await pick(page, "This chat's summary model", "story-model")
      await expect(own).toContainText("story-model")
      await expectLayout(page, info, `summary-model-chat-${width}-${theme}`, {
        scope: 'section[aria-label="Summary settings"]'
      })
      await page.screenshot({ path: info.outputPath(`chat-${width}-${theme}.png`) })
      await own.click()
      await page.getByRole("button", { name: "Use the account default", exact: true }).click()
      await expect(own).toContainText("Account default: Local · cheap-model")
      await page.reload()
      await expect(
        (await openSummarySettings(page)).getByRole("button", { name: "This chat's summary model", exact: true })
      ).toContainText("Account default: Local · cheap-model")

      // A deleted choice remains visible and can still be cleared.
      const gone = await rpc((api) =>
        Effect.gen(function* () {
          const c = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Gone",
              baseUrl: "http://127.0.0.1:9/v1",
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const m = yield* api.AddUserModel({ connectionId: c.id, key: "gone-model", overrides: {} })
          const shown = yield* api.GetChat({ chatId })
          yield* api.ChangeCast({
            chatId,
            slotId: shown.activeLeafSlotId,
            change: { _tag: "SummaryModel", model: { connection: c.id, model: m.id } }
          })
          yield* api.ChangeGenerationDefaults({ change: { summarizer: { connection: c.id, model: m.id } } })
          yield* api.DeleteConnection({ connectionId: c.id })
          return c.id
        })
      )
      expect(gone).toBeTruthy()
      await page.reload()
      await openSummarySettings(page)
      await expect(own).toContainText("Model unavailable")
      await own.click()
      await page.getByRole("button", { name: "Use the account default", exact: true }).click()
      await expect(own).toContainText("Account default: Model unavailable")
      await expectLayout(page, info, `summary-model-unavailable-${width}-${theme}`, {
        scope: 'section[aria-label="Summary settings"]'
      })

      // Taking the account's off: summaries follow each chat's model again.
      await page.goto(`${server().url}/settings/chats`)
      await expect(account).toContainText("Model unavailable")
      await account.click()
      await page.getByRole("button", { name: "Same as the chat's model", exact: true }).click()
      await expect(account).toContainText("Same as the chat's model")
      await expect.poll(() => rpc((api) => api.GetGenerationDefaults()).then((d) => d.lcm?.summarizer)).toBe(undefined)
    })
