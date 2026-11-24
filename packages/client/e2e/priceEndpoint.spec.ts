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
    prices: {
      object: "list",
      unit: "USD per 1M tokens",
      data: [
        {
          id: MODEL,
          input: 0.25,
          output: 0.75,
          pct_of_list: 80,
          routes: [{ target: "fast", upstream: "fast-1", input: 0.3, output: 0.9, pct_of_list: 90 }]
        }
      ]
    }
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
      const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: `Edit ${MODEL}` }) })
      // The price in its column; where it came from in its hover.
      await expect(row.locator('[data-price-source="list"]')).toHaveText("$1 / $2")
      await hover(page, "$1 / $2", /from the provider’s model list/)
      expect(provider.priceRequests).toBe(before)

      await page.getByText("Advanced", { exact: true }).click()
      const toggle = page.getByRole("switch", { name: "Fetch prices from this server" })
      await toggle.scrollIntoViewIfNeeded()
      await expect(toggle).not.toBeChecked()
      await hover(
        page,
        "Fetch prices from this server",
        /Asks this server for its model prices when you refresh models, and about every hour/
      )
      await expectLayout(page, info, `price-endpoint-form-${width}-${theme}`)
      await toggle.click()
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()

      await page.getByRole("button", { name: "Refresh from provider" }).click()
      await expect(row.locator('[data-price-source="endpoint"]')).toHaveText("$0.25 / $0.75")
      await hover(page, "$0.25 / $0.75", /from this server’s price list, fetched .*, 80 % of list price/)
      // The routes the server lists, with their own prices (PRICES §4.4).
      await expect(row.locator("[data-price-routes]")).toHaveText("Routes: fast $0.300 / $0.900 (90 %)")
      await hover(page, /^Routes: fast/, /Where this server may send the model/)
      expect(provider.priceRequests).toBe(before + 1)
      // The switch says what the server answered last (PRICES §4.5).
      await expect(page.locator('[data-price-feed="supported"]')).toContainText("Prices fetched")
      await hover(page, "$0.25 / $0.75", /This server’s own price for the model/)
      await expectLayout(page, info, `price-endpoint-row-${width}-${theme}`)
    })
