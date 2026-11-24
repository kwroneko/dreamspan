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

  // The request opened in a browser tab of its own (a middle click on View request): that tab
  // has no tab of the new chat, so the link opens one beside the request, which stays.
  test("a first request in a new browser tab opens the new chat beside it", async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetGenerationDefaults({ defaults: { model: originalModel, preset: null } })
    )
    await page.goto(`${server().url}/cards/${entityId}/chat`)
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("The bell rings twice.")
    await page.getByRole("button", { name: /^Context: about [\d,]+ of [\d,]+ tokens in your first request/ }).click()
    const opened = context.waitForEvent("page")
    await page
      .getByRole("dialog", { name: "Context" })
      .getByRole("link", { name: "View request" })
      .click({ button: "middle" })
    const other = await opened
    await other.setViewportSize({ width: 1440, height: 900 })
    const heading = other.getByRole("heading", { name: "Your first request" })
    await expect(heading).toBeVisible()
    const strip = other.getByRole("tablist", { name: "Open tabs", exact: true })
    await expect(strip).toHaveCount(0)

    await other.getByRole("link", { name: "← Go to the new chat", exact: true }).click()
    const tabs = strip.getByRole("tab")
    await expect(tabs).toHaveCount(2)
    const requestTab = strip.getByRole("tab", { name: /Your first request/ })
    await expect(requestTab).toHaveAttribute("aria-selected", "false")
    await expect(tabs.filter({ hasNotText: "Your first request" })).toHaveAttribute("aria-selected", "true")
    await expect(other.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
    await requestTab.click()
    await expect(heading).toBeVisible()
    await other.close()
  })

  // The request beside the chat (Open beside), then a reload, which makes the tabs' ids afresh
  // (a deploy reloads the page too): the link still switches to the chat's own tab, in its own
  // frame, and opens no second new chat where the request is.
  test("after a reload, the link switches to the new chat's tab beside the request", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetGenerationDefaults({ defaults: { model: originalModel, preset: null } })
    )
    await page.goto(`${server().url}/cards/${entityId}/chat`)
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("The tide is out.")
    await page.getByRole("button", { name: /^Context: about [\d,]+ of [\d,]+ tokens in your first request/ }).click()
    await page
      .getByRole("dialog", { name: "Context" })
      .getByRole("link", { name: "View request" })
      .click({ button: "right" })
    await page.getByRole("menuitem", { name: /beside/i }).click()
    const heading = page.getByRole("heading", { name: "Your first request" })
    await expect(heading).toBeVisible()
    const frames = page.locator("section[data-frame]")
    await expect(frames).toHaveCount(2)
    await page.reload()
    await expect(heading).toBeVisible()
    await expect(frames).toHaveCount(2)

    await page.getByRole("link", { name: "← Go to the new chat", exact: true }).click()
    const tabs = page.getByRole("tablist", { name: "Open tabs", exact: true }).getByRole("tab")
    const chatTabs = tabs.filter({ hasNotText: "Your first request" })
    const requestTab = tabs.filter({ hasText: "Your first request" })
    await expect(chatTabs).toHaveCount(1)
    await expect(requestTab).toHaveCount(1)
    await expect(tabs).toHaveCount(2)
    const focused = page.locator("section[data-frame][data-focused]")
    await expect(focused.getByRole("tab", { selected: true })).toHaveCount(1)
    await expect(focused.getByRole("tab", { selected: true })).not.toContainText("Your first request")
    await expect(focused).not.toContainText("Your first request")
    await expect(heading).toBeVisible()
  })

  test("the first request's link switches to the new chat's own tab", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetGenerationDefaults({ defaults: { model: originalModel, preset: null } })
    )
    await page.goto(`${server().url}/cards/${entityId}/chat`)
    const box = page.getByRole("textbox", { name: "Message", exact: true })
    await box.fill("The lantern by the ferry is lit.")
    // One tab shows no strip; the request's own tab makes two.
    const strip = page.getByRole("tablist", { name: "Open tabs", exact: true })
    const tabs = strip.getByRole("tab")
    await expect(strip).toHaveCount(0)
    await page.getByRole("button", { name: /^Context: about [\d,]+ of [\d,]+ tokens in your first request/ }).click()
    await page.getByRole("dialog", { name: "Context" }).getByRole("link", { name: "View request" }).click()
    const heading = page.getByRole("heading", { name: "Your first request" })
    await expect(heading).toBeVisible()
    await expect(tabs).toHaveCount(2)
    const requestTab = strip.getByRole("tab", { name: /Your first request/ })
    const chatTab = tabs.filter({ hasNotText: "Your first request" })
    await expect(requestTab).toHaveAttribute("aria-selected", "true")
    await expect(chatTab).toHaveAttribute("aria-selected", "false")

    const link = page.getByRole("link", { name: "← Go to the new chat", exact: true })
    await link.hover()
    await expect(page.getByText("Switches to the new chat's tab.", { exact: true })).toBeVisible()
    await link.click()
    // The new chat's own tab is shown, with its text; the request's tab stays; no second chat tab.
    await expect(chatTab).toHaveAttribute("aria-selected", "true")
    await expect(requestTab).toHaveAttribute("aria-selected", "false")
    await expectTextBox(box, "The lantern by the ferry is lit.")
    await expect(tabs).toHaveCount(2)
    await requestTab.click()
    await expect(heading).toBeVisible()
    await expect(page.locator("[data-workbench-tab]:visible")).toContainText("Nothing has been sent.")

    // With the chat's tab closed, the link opens the chat in a new tab; the request's tab stays.
    await chatTab.click({ button: "middle" })
    await expect(strip).toHaveCount(0)
    await link.click()
    await expect(tabs).toHaveCount(2)
    await expect(chatTab).toHaveAttribute("aria-selected", "true")
    await expect(requestTab).toHaveAttribute("aria-selected", "false")
    await expect(box).toBeVisible()
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
        const chip = page.getByRole("button", { name: /^Context: about [\d,]+ of [\d,]+ tokens in your first request/ })
        await expect(chip).toBeVisible()
        await expect(chip).toContainText(/^[\d.]+k? \/ [\d.]+k$/)
        await expectLayout(page, info, `draft-strip-${width}-${theme}`)

        // Typing changes the request: Send's, with the message.
        const content = `The ferry is late at ${width} in ${theme}.`
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(content)
        await chip.click()
        const popover = page.getByRole("dialog", { name: "Context" })
        await expect(popover.getByRole("list", { name: "Parts of the request" })).toContainText("Character cards")
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
        await page.getByRole("link", { name: "← Go to the new chat" }).click()
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
