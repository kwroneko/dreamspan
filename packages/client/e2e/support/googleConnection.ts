// Shared by the provider browser gate and the focused layout audit. Synthetic HTTP only.
import { expect, test } from "@playwright/test"
import { json, sse, startMockProvider } from "../../../server/test/support/mockProvider.ts"
import { expectLayout } from "./layoutAudit.ts"
import { chooseDefaultModelIfNone } from "./provider.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

export const googleConnectionTests = () => {
  const server = serverPerFile(withAdmin)
  let mock: Awaited<ReturnType<typeof startMockProvider>>
  test.beforeAll(async () => {
    mock = await startMockProvider((request, res) => {
      expect(request.headers["x-goog-api-key"]).toBe("synthetic-google-browser-key")
      // Test sends the default model one short message after listing the models.
      if (request.path.startsWith("/v1beta/models/gemini-2.5-flash:streamGenerateContent?"))
        return sse(
          res,
          [
            {
              candidates: [{ content: { parts: [{ text: "Hello." }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
            }
          ],
          { done: false }
        )
      expect(request.path).toContain("/v1beta/models?")
      json(res, 200, {
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Synthetic Flash",
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            thinking: true,
            supportedGenerationMethods: ["generateContent"]
          }
        ]
      })
    })
  })
  test.afterAll(async () => {
    await mock?.close()
  })
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`Google connection ${width} ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        await page.goto(`${server().url}/settings/connections/new`)
        await page.getByRole("combobox", { name: "Provider", exact: true }).click()
        await page
          .getByRole("option")
          .filter({ has: page.getByText("Google AI Studio", { exact: true }) })
          .click()
        await expect(page.getByRole("combobox", { name: "API type", exact: true })).toHaveCount(0)
        await expect(page.getByLabel("Region", { exact: true })).toHaveCount(0)
        await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute(
          "placeholder",
          "https://generativelanguage.googleapis.com/v1beta"
        )
        await page.getByText("Advanced", { exact: true }).click()
        await expect(
          page.getByText("Caching is automatic; cache reads are counted apart from other input.")
        ).toBeVisible()
        await expect(page.getByText("Cache lifetime is unknown. This app doesn’t create saved caches.")).toBeVisible()
        await expect(page.getByText(/Gemini 4 Carbon and Argon:/)).toBeVisible()
        await expect(page.getByRole("combobox", { name: "Cache markers", exact: true })).toHaveCount(0)
        await expectLayout(page, info, `google-new-${width}-${theme}`, { scope: "main" })
        const name = `Google ${width} ${theme}`
        await page.getByLabel("Name", { exact: true }).fill(name)
        await page.getByLabel("Base URL", { exact: true }).fill(`${mock.url}/v1beta`)
        await page.getByLabel("API key", { exact: true }).fill("synthetic-google-browser-key")
        await chooseDefaultModelIfNone(page, "gemini-2.5-flash")
        await page.getByRole("button", { name: "Create connection" }).click()
        await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
        await page.getByRole("button", { name: "Test", exact: true }).click()
        // Later variants share the account, whose default model is then on an earlier connection,
        // so only the first sends a message; every one lists the models.
        await expect(page.getByRole("status").filter({ hasText: "It works" })).toBeVisible()
        await page.getByRole("button", { name: "Refresh from provider", exact: true }).click()
        await expect(
          page.getByRole("table", { name: "Models", exact: true }).getByText("Synthetic Flash", { exact: true })
        ).toBeVisible()
        await page.getByText("Advanced", { exact: true }).click()
        await expectLayout(page, info, `google-detail-${width}-${theme}`, { scope: "main" })
        await page.reload()
        await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
        await expect(page.getByText("synthetic-google-browser-key", { exact: true })).toHaveCount(0)
      })
}
