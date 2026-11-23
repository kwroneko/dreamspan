// A chat not saved yet (before the first send) has the full Model tab (owner, 2026-11-23): model
// settings are the model's, not the chat's, so its editor shows for the model the first send
// uses, and a setting saved there is in that send's request.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let cardId = ""

test.beforeAll(async () => {
  provider = await startProvider()
  cardId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: true })
      const large = models.find((model) => model.key === "fake-large")!
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: large.id }, preset: null }
      })
      const card = yield* api.CreateCard({ label: "Harbor keeper", name: "Harbor keeper" })
      return card.entityId as string
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  test(`a new chat's Model tab edits the model's settings at ${width}, and the first send uses them`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/cards/${cardId}/chat`)
    const tab = await openPanel(page, "Model")
    await expect(tab).not.toContainText("Available once the chat is saved")
    const temperature = tab.getByRole("textbox", { name: "Temperature", exact: true })
    await expect(temperature).toBeVisible({ timeout: 30_000 })
    const value = width === 1440 ? "0.3" : "0.6"
    await temperature.fill(value)
    await tab.getByRole("button", { name: "Save model settings", exact: true }).click()
    await expect(tab.getByRole("button", { name: "Save model settings", exact: true })).toBeEnabled()
    await expect
      .poll(async () => {
        const models = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const connections = yield* api.ListConnections()
            return yield* api.ListModels({ connectionId: connections[0]!.id, includeHidden: true })
          })
        )
        return models.find((model) => model.key === "fake-large")?.overrides.settings?.samplers?.temperature
      })
      .toBe(Number(value))

    // The first send saves the chat; its request carries the setting.
    // On a phone the panel is a sheet over the chat: closed first.
    if (width === 390) await page.keyboard.press("Escape")
    const text = `Is the harbor quiet at ${width}?`
    await page.getByLabel("Message", { exact: true }).fill(text)
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const sent = () => provider.completionBytes.find((bytes) => bytes.includes(text))
    await expect.poll(sent).toBeTruthy()
    expect((JSON.parse(sent()!) as { temperature?: number }).temperature).toBe(Number(value))
  })
