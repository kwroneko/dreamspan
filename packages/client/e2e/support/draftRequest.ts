// A chat not sent yet shows its context size and its first request (DESIGN §2.1): the strip's
// Context chip, its popover, and View request's inspector tab (`/request/first`), built as the
// box changes. The model's provider gets nothing until the send. Synthetic data only.
import type { GenerationDefaults } from "@dreamspan/shared/generation.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, startProvider } from "./provider.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { modelChip, choices } from "./strip.ts"
import { expectLayout } from "./layoutAudit.ts"
import { expectTextBox } from "./textbox.ts"

export function draftRequestTests() {
  const server = serverPerFile(withAdmin)
  let provider: FakeProvider
  let entityId: string
  let originalModel: NonNullable<GenerationDefaults["model"]>

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
        // Counting with the provider is on: the preview still counts here.
        yield* api.SetTokenCounting({ connectionId: connection.id, via: connection.id })
        yield* api.AddUserModel({ connectionId: connection.id, key: "other-synthetic", overrides: {} })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
        originalModel = { connection: connection.id, model: model.id }
        yield* api.SetGenerationDefaults({ defaults: { model: originalModel, preset: null } })
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

  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"] as const) {
      test(`a chat not sent yet shows its first request: ${width} ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const before = provider.keys.length
        await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.SetGenerationDefaults({
            defaults: { model: originalModel, preset: null }
          })
        )
        await page.goto(`${server().url}/cards/${entityId}/chat`)
        if (width === 390 && (await page.getByRole("button", { name: "Close", exact: true }).isVisible()))
          await page.getByRole("button", { name: "Close", exact: true }).click()
        const chip = page.getByRole("button", { name: /^Context: about [\d,]+ tokens in your first request/ })
        await expect(chip).toBeVisible()
        await expect(chip).toContainText(/~[\d.]+k? tokens/)
        await expectLayout(page, info, `draft-strip-${width}-${theme}`)

        // Typing changes the request: Send's, with the message.
        const content = `The ferry is late at ${width} in ${theme}.`
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(content)
        await chip.click()
        const popover = page.getByRole("dialog", { name: "Context" })
        await expect(popover).toContainText("what your first send would send")
        await expect(popover).toContainText("nothing is sent until you send")
        // A request inspector tab, as every other inspector (owner, 2026-11-23): switched to, with
        // the new chat kept in its own tab, and Back returns to it.
        await popover.getByRole("link", { name: "View request" }).click()
        await expect(page).toHaveURL(/\/request\/first\?/)
        const heading = page.getByRole("heading", { name: "Your first request" })
        await expect(heading).toBeVisible()
        await expect(page.getByRole("dialog")).toHaveCount(0)
        const shown = page.locator("[data-workbench-tab]")
        await expect(shown).toHaveCount(1)
        await expect(shown).toContainText("Nothing has been sent.")
        await expect(shown).toContainText(
          "Random choices, the current time and automatic decisions can change it when you send."
        )
        const messages = page.getByRole("region", { name: "Messages", exact: true })
        await expect(messages).toContainText(content)
        await expect(messages).toContainText("Mira keeps the ledger at the river crossing.")
        await expectLayout(page, info, `draft-request-${width}-${theme}`)
        await page.screenshot({ path: info.outputPath(`draft-request-${width}-${theme}.png`) })

        // Back returns to the new chat as it was; forward shows the request again.
        await page.goBack()
        await expect(heading).toBeHidden()
        await expectTextBox(page.getByRole("textbox", { name: "Message", exact: true }), content)
        await page.goForward()
        await expect(page.getByRole("region", { name: "Messages", exact: true })).toContainText(content)
        await page.getByRole("link", { name: "← Back to the new chat" }).click()
        await expectTextBox(page.getByRole("textbox", { name: "Message", exact: true }), content)

        // None of it reached the model's provider.
        // Picking a model changes what Send would use without changing the composer text.
        await modelChip(page).click()
        await choices(page, "Model")
          .getByRole("radio", { name: /other-synthetic/ })
          .click()
        await expect(modelChip(page)).toContainText("other-synthetic")
        await chip.click()
        await page.getByRole("link", { name: "View request", exact: true }).click()
        await expect(page.getByRole("heading", { name: "Your first request" })).toBeVisible()
        await expect(page.locator("[data-workbench-tab]")).toContainText("other-synthetic")
        expect(provider.keys.length).toBe(before)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      })
    }
  }
}
