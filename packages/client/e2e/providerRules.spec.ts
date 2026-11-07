// The connection's "Model ID prefix" setting and the model page's provider rules and locked
// Prefill (livefix): their help on hover, their copy, and the layout audit at 1440 and 390 px
// in light and dark.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let connectionId = ""
const GEMINI = "google/gemini-3.5-flash-lite"

test.beforeAll(async () => {
  provider = await startProvider()
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
        }
      })
      // Added by id: OpenRouter's Gemini gets its provider rules (no prefill, locked).
      yield* api.AddUserModel({ connectionId: connection.id, key: GEMINI, overrides: { prefill: "assistant" } })
      return connection.id
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

/** Hovers a "?": its help shows beside it, and is its description for screen readers. */
const help = async (page: Page, name: string, text: RegExp) => {
  const hint = page.getByRole("button", { name: `About ${name}`, exact: true })
  await hint.scrollIntoViewIfNeeded()
  await hint.hover()
  await expect(hint).toHaveAccessibleDescription(text)
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible()
  await page.mouse.move(0, 0)
}

const noInternals = async (page: Page) => {
  const shown = await page.locator("body").innerText()
  expect(shown).not.toMatch(/\bshims?\b|nudge|payload|thinkingLevels/i)
}

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`model ID prefix and provider rules: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/connections/${connectionId}`)

      // The connection's setting: a short label, its help on hover, saved like the others.
      const prefix = page.getByLabel("Model ID prefix", { exact: true })
      await expect(prefix).toBeVisible()
      await help(page, "Model ID prefix", /before its model IDs.*price and limits/)
      await expectLayout(page, info, `connection-settings-${width}-${theme}`, { scope: "main" })
      await prefix.fill("acme.")
      await page.getByRole("button", { name: "Save", exact: true }).first().click()
      await expect(page.getByRole("button", { name: "Save", exact: true }).first()).toBeDisabled()
      await page.reload()
      await expect(page.getByLabel("Model ID prefix", { exact: true })).toHaveValue("acme.")
      await page.getByLabel("Model ID prefix", { exact: true }).fill("")
      await page.getByRole("button", { name: "Save", exact: true }).first().click()
      await expect(page.getByRole("button", { name: "Save", exact: true }).first()).toBeDisabled()
      await noInternals(page)

      // The model page: the rules listed with their help, and Prefill locked off with its reason.
      await page.getByRole("button", { name: `Edit ${GEMINI}`, exact: true }).click()
      const dialog = page.getByRole("dialog")
      const rules = dialog.getByRole("region", { name: "Provider rules", exact: true })
      await rules.scrollIntoViewIfNeeded()
      await expect(rules).toContainText("No prefill: this provider refuses one for Gemini.")
      await help(page, "Provider rules", /refuses or needs for this model/)
      const prefill = dialog.getByRole("combobox", { name: "Prefill", exact: true })
      await expect(prefill).toBeDisabled()
      await expect(prefill).toContainText("Provider: no")
      await help(page, "Prefill", /refuses a prefill for this model/)
      await noInternals(page)
      await rules.scrollIntoViewIfNeeded()
      await expectLayout(page, info, `model-provider-rules-${width}-${theme}`, { scope: '[role="dialog"]' })
      await dialog.getByRole("button", { name: "Save" }).last().scrollIntoViewIfNeeded()
      await expectLayout(page, info, `model-provider-rules-end-${width}-${theme}`, { scope: '[role="dialog"]' })
    })
