// A model pinned to one OpenRouter provider is priced by that provider's own endpoint: the price
// in the model's row and a note under the model page's Provider rules, with their help on hover,
// the fallback note when the price can't be had, and the layout audit at 1440 and 390 px in
// light and dark. The provider is a fake one serving OpenRouter's documented endpoint list.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let connectionId = ""
const PINNED = "synthetic-lab/synthetic-flash"
const FAILING = "synthetic-lab/synthetic-missing"

test.beforeAll(async () => {
  provider = await startProvider({
    // The list's own price for both: $50 and $150 per million tokens.
    models: [PINNED, FAILING].map((id) => ({
      id,
      name: id,
      context_length: 32768,
      pricing: { prompt: "0.00005", completion: "0.00015" }
    })),
    endpoints: {
      [PINNED]: {
        data: {
          id: PINNED,
          name: "Synthetic Flash",
          endpoints: [
            {
              name: "Together | synthetic-flash",
              provider_name: "Together",
              tag: "together",
              context_length: 128000,
              pricing: { prompt: "0.0000002", completion: "0.0000006", input_cache_read: "0.00000005" }
            },
            {
              name: "DeepInfra | synthetic-flash",
              provider_name: "DeepInfra",
              tag: "deepinfra/fp8",
              pricing: { prompt: "0.0000001", completion: "0.0000003" }
            }
          ]
        }
      }
    }
  })
  connectionId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openrouter",
        settings: {
          name: "Router",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-synthetic"
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: true })
      const pin = (key: string, routing: Record<string, unknown>) =>
        api.EditModel({
          modelId: models.find((m) => m.key === key)!.id,
          overrides: { settings: { routing } },
          expectedRowVersion: models.find((m) => m.key === key)!.rowVersion
        })
      // Pinned with the slug written in capitals; the provider's list has it as "together".
      yield* pin(PINNED, { only: ["Together"] })
      // Pinned, but the listing can't be had.
      yield* pin(FAILING, { order: ["Fireworks"], allow_fallbacks: false })
      return connection.id
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const hover = async (page: Page, text: string | RegExp, tip: RegExp) => {
  const target = page.getByText(text).filter({ visible: true }).first()
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await expect(page.getByText(tip).filter({ visible: true }).first()).toBeVisible()
  await page.mouse.move(0, 0)
}

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a pinned model's own price on its row and model page: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/connections/${connectionId}`)

      // The row's price changes from the model's general one to Together's once its list is in.
      const row = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: `Edit ${PINNED}` }) })
      await expect(row.locator('[data-price-source="pinned"]')).toContainText("$0.2 / $0.6 per M tokens (Together)")
      await expect(row).not.toContainText("$50")
      await hover(page, /per M tokens \(Together\)/, /Together.s own price, because the routing pins it/)
      expect(provider.endpointRequests).toContain(PINNED)

      await page.getByRole("button", { name: `Edit ${PINNED}`, exact: true }).click()
      const dialog = page.getByRole("dialog")
      const rules = dialog.getByRole("region", { name: "Provider rules", exact: true })
      await rules.scrollIntoViewIfNeeded()
      await expect(rules).toContainText("Priced as Together.")
      await hover(page, "Priced as Together.", /Costs use this provider.s own price, not the model.s usual one/)
      expect(await page.locator("body").innerText()).not.toMatch(/endpoint|upstream|payload/i)
      await expectLayout(page, info, `pinned-price-${width}-${theme}`, { scope: '[role="dialog"]' })
      await page.keyboard.press("Escape")

      // A pinned provider the list has no price for: the general price, and a note saying so.
      await expect(
        page
          .getByRole("listitem")
          .filter({ has: page.getByRole("button", { name: `Edit ${FAILING}` }) })
          .locator('[data-price-source="fallback"]')
      ).toContainText("$50 / $150 per M tokens")
      await page.getByRole("button", { name: `Edit ${FAILING}`, exact: true }).click()
      const failing = page.getByRole("dialog").getByRole("region", { name: "Provider rules", exact: true })
      await failing.scrollIntoViewIfNeeded()
      await expect(failing).toContainText("price couldn’t be fetched, so the model’s usual price applies")
      await hover(page, /price couldn.t be fetched/, /OpenRouter gave no price for it/)
      await expectLayout(page, info, `pinned-price-fallback-${width}-${theme}`, { scope: '[role="dialog"]' })
    })
