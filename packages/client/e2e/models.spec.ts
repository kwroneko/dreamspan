import { expect, test } from "@playwright/test"
import { chooseCustomServer, type FakeProvider, startProvider, chooseDefaultModelIfNone } from "./support/provider.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

test("refresh, hide, edit and add models", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await chooseCustomServer(page)
  await page.getByLabel("Name", { exact: true }).fill("Models test")
  await page.getByLabel("Base URL", { exact: true }).fill(provider.baseUrl)
  // Left empty, the key is optional for this kind: no key is sent.
  await chooseDefaultModelIfNone(page)
  await page.getByRole("button", { name: "Create connection" }).click()

  // Creating it fetches the models, and the one typed on the form becomes the default for new chats.
  const models = page.getByRole("table", { name: "Models" })
  await expect(page.getByText("Found 2 models.")).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "for new chats" })).toContainText("Using Fake Large")
  await page.getByRole("button", { name: "Refresh from provider" }).click()
  await expect(page.getByText("0 added, 2 updated")).toBeVisible()
  await expect(models.getByText("Fake Large")).toBeVisible()
  // The listed context, from the provider; the output limit nobody reported is shown as assumed.
  await expect(models.getByRole("row").filter({ hasText: "Fake Large" })).toContainText("Context 131.1k")
  await expect(models.getByRole("row").filter({ hasText: "Fake Large" })).toContainText("Output 65.5k (assumed)")

  await page.getByRole("button", { name: "Hide fake-small" }).click()
  // All lists it, marked hidden; Visible leaves it out.
  await expect(models.getByRole("row").filter({ hasText: "Fake Small" })).toContainText("hidden")
  await page.getByRole("tab", { name: /^Visible/ }).click()
  await expect(models.getByText("Fake Small")).toBeHidden()
  await page.getByRole("tab", { name: /^All/ }).click()

  await page.getByRole("button", { name: "Edit fake-large" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Display name").fill("My large model")
  // The provider's limits are read-only until the pencil opens your own value.
  await expect(dialog.getByLabel("Your output limit (tokens)", { exact: true })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Set the output limit yourself" }).click()
  await dialog.getByLabel("Your output limit (tokens)", { exact: true }).fill("8000")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()
  await expect(models.getByRole("row").filter({ hasText: "My large model" })).toContainText("Output 8k*")

  await page.getByRole("button", { name: "Add a model" }).click()
  await page.getByRole("dialog").getByLabel("Model id", { exact: true }).fill("fake-large")
  await page.getByRole("dialog").getByRole("button", { name: "Add model" }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("already has a model called “fake-large”")
  await page.getByRole("dialog").getByLabel("Model id", { exact: true }).fill("fake-unlisted")
  await page.getByRole("dialog").getByRole("button", { name: "Add model" }).click()
  await expect(models.getByRole("row").filter({ hasText: "fake-unlisted" })).toContainText("added by you")
})

test("model settings take typed decimals and keep the reply length apart from the output limit", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await chooseCustomServer(page)
  await page.getByLabel("Name", { exact: true }).fill("Settings test")
  await page.getByLabel("Base URL", { exact: true }).fill(provider.baseUrl)
  await chooseDefaultModelIfNone(page)
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByText("Found 2 models.")).toBeVisible()

  const models = page.getByRole("table", { name: "Models" })
  const dialog = page.getByRole("dialog")
  await page.getByRole("button", { name: "Edit fake-large" }).click()
  const field = (name: string) => dialog.getByRole("textbox", { name, exact: true })
  // Typed key by key, as a person types: "0." on the way to "0.7" must survive.
  await field("Temperature").pressSequentially("0.7")
  await expect(field("Temperature")).toHaveValue("0.7")
  await field("Top P").pressSequentially("0.95")
  await field("Top P").clear()
  await field("Reply length").pressSequentially("1200")
  await field("Seed").pressSequentially("x")
  await dialog.getByRole("button", { name: "Save model settings" }).click()
  await expect(dialog.getByText("Check the fields marked below.")).toBeVisible()
  await field("Seed").clear()
  await dialog.getByRole("button", { name: "Save model settings" }).click()
  await expect(dialog).toBeHidden()
  // The reply length is a setting; the output limit the provider reports is unchanged.
  await expect(models.getByRole("row").filter({ hasText: "Fake Large" })).toContainText("Output 65.5k (assumed)")

  await page.getByRole("button", { name: "Edit fake-large" }).click()
  await expect(field("Temperature")).toHaveValue("0.7")
  await expect(field("Top P")).toHaveValue("")
  await expect(field("Reply length")).toHaveValue("1200")
  await expect(field("Your output limit (tokens)")).toHaveCount(0)
  // The limits are at the sliders' ends, with where each comes from.
  const length = dialog.getByRole("group", { name: "Length", exact: true })
  await expect(length.locator('[data-limit="context"]')).toContainText("Max 131,072")
  const about = length.getByRole("button", { name: "About Context window", exact: true })
  await expect(about).toHaveAccessibleDescription("Reported by the provider.")
  await length.getByRole("button", { name: "Set the context window yourself" }).click()
  await expect(field("Your context window (tokens)")).toBeFocused()
  await length.getByRole("button", { name: "Use reported" }).click()
  await expect(field("Your context window (tokens)")).toHaveCount(0)
})
