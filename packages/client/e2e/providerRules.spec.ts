// The model page's provider rules and locked Prefill (livefix): their help on hover, their copy,
// and the layout audit at 1440 and 390 px in light and dark.
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
const PINNED = "deepseek/deepseek-v4.1-flash"
const UNPINNED = "xiaomi/mimo-v2.6-pro"

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
      // Route rules: DeepSeek pinned to Together, and MiMo left to the router.
      yield* api.AddUserModel({
        connectionId: connection.id,
        key: PINNED,
        overrides: { prefill: "assistant", settings: { routing: { only: ["together"] } } }
      })
      yield* api.AddUserModel({ connectionId: connection.id, key: UNPINNED, overrides: { prefill: "assistant" } })
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
    test(`provider rules: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/connections/${connectionId}`)

      await expectLayout(page, info, `connection-settings-${width}-${theme}`, { scope: "main" })
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

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  test(`route rules of a pinned and an unpinned model: ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/connections/${connectionId}`)

    // Pinned to Together: its rule applies and Prefill is locked.
    await page.getByRole("button", { name: `Edit ${PINNED}`, exact: true }).click()
    let dialog = page.getByRole("dialog")
    let rules = dialog.getByRole("region", { name: "Provider rules", exact: true })
    await rules.scrollIntoViewIfNeeded()
    await expect(rules).toContainText("No prefill through Together")
    await expect(dialog.getByRole("combobox", { name: "Prefill", exact: true })).toBeDisabled()
    await help(page, "Provider rules", /Some apply only when the model.s routing picks one provider/)
    await noInternals(page)
    await expectLayout(page, info, `route-pinned-${width}`, { scope: '[role="dialog"]' })
    await page.keyboard.press("Escape")

    // Not pinned: a note says where prefill fails, and Prefill stays editable.
    await page.getByRole("button", { name: `Edit ${UNPINNED}`, exact: true }).click()
    dialog = page.getByRole("dialog")
    rules = dialog.getByRole("region", { name: "Provider rules", exact: true })
    await rules.scrollIntoViewIfNeeded()
    await expect(rules).toContainText("Prefill fails on StreamLake")
    await expect(rules).toContainText("pin a provider to be sure")
    await expect(dialog.getByRole("combobox", { name: "Prefill", exact: true })).toBeEnabled()
    await noInternals(page)
    await expectLayout(page, info, `route-unpinned-${width}`, { scope: '[role="dialog"]' })
  })
