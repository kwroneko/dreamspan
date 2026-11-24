// A new chat's request before it is sent (DESIGN §2.1, owner: "Make sure this doesn't cause
// anything to be sent to inference providers"): a new chat is a pending chat (DraftChatPage.tsx),
// so its context chip and request inspector are the chat's own, built from the real chat by the
// reader with no provider call. The model's provider gets nothing until the send. Synthetic data.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let entityId: string

test.beforeAll(async () => {
  provider = await startProvider()
  entityId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
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
        apiKey: "sk-draft-request-test-0042"
      })
      // Counting with the provider is on: a new chat still counts here.
      yield* api.SetTokenCounting({ connectionId: connection.id, via: connection.id })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const card = yield* api.CreateCard({
        label: "Mira",
        name: "Mira",
        description: "Mira keeps the ledger at the river crossing."
      })
      return card.entityId
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a new chat's context and request ask the provider nothing at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const completions = provider.completions.length
      await page.goto(`${server().url}/cards/${entityId}/chat`)
      await expect(page).toHaveURL(/[?&]draft=/)
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("The bell rings twice.")
      const chip = page.getByRole("button", { name: /^Context: about / })
      await expect(chip).toBeVisible()
      await chip.click()
      const popover = page.getByRole("dialog", { name: "Context" })
      await expect(popover).toBeVisible()
      await expectLayout(page, info, `draft-context-${width}-${theme}`)
      await popover.getByRole("link", { name: "View request" }).click()
      await expect(page).toHaveURL(/\/request\/next/)
      await expect(page.getByText("Mira keeps the ledger at the river crossing.").first()).toBeVisible()
      await expectLayout(page, info, `draft-request-${width}-${theme}`)
      // Nothing was sent, and the new chat is still a draft.
      expect(provider.completions.length).toBe(completions)
      await page.goBack()
      await expect(page).toHaveURL(/[?&]draft=/)
      expect(provider.completions.length).toBe(completions)
    })
