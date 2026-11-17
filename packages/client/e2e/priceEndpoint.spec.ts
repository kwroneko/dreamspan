// The opt-in price endpoint in the UI (spec/PRICES.md §4, §7): the connection form's "Fetch prices
// from this server" switch, off by default with its hover, nothing asked of the server until it's
// on, and the model row's price line naming where its price came from. Layout audit at 1440 and
// 390 px in light and dark. The provider is a fake one serving a synthetic price list.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
const MODEL = "synthetic-small"

test.beforeAll(async () => {
  provider = await startProvider({
    models: [
      { id: MODEL, name: MODEL, context_length: 32768, pricing: { prompt: "0.000001", completion: "0.000002" } }
    ],
    prices: { object: "list", unit: "USD per 1M tokens", data: [{ id: MODEL, input: 0.25, output: 0.75 }] }
  })
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
    test(`fetching a connection's own prices: ${width} ${theme}`, async ({ page }, info) => {
      const connectionId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api
          .CreateConnection({
            kind: "openai-chat",
            settings: {
              name: `Prices ${width} ${theme}`,
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: "sk-synthetic"
          })
          .pipe(Effect.map((c) => c.id))
      )
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/connections/${connectionId}`)

      // Off by default: a refresh asks for models only.
      const before = provider.priceRequests
      await page.getByRole("button", { name: "Refresh from provider" }).click()
      const row = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: `Edit ${MODEL}` }) })
      await expect(row.locator("[data-price-source]")).toContainText(
        "$1 / $2 per M tokens, from the provider’s model list"
      )
      expect(provider.priceRequests).toBe(before)

      await page.getByText("Advanced", { exact: true }).click()
      const toggle = page.getByRole("switch", { name: "Fetch prices from this server" })
      await toggle.scrollIntoViewIfNeeded()
      await expect(toggle).not.toBeChecked()
      await hover(
        page,
        "Fetch prices from this server",
        /Asks this server for its model prices each time you refresh models/
      )
      await expectLayout(page, info, `price-endpoint-form-${width}-${theme}`)
      await toggle.click()
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()

      await page.getByRole("button", { name: "Refresh from provider" }).click()
      await expect(row.locator('[data-price-source="endpoint"]')).toContainText(
        "$0.25 / $0.75 per M tokens, from this server’s price list, fetched"
      )
      expect(provider.priceRequests).toBe(before + 1)
      await hover(page, /from this server’s price list/, /This server’s own price for the model/)
      await expectLayout(page, info, `price-endpoint-row-${width}-${theme}`)
    })
