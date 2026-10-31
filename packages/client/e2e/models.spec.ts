import { expect, test } from "@playwright/test"
import { type FakeProvider, startProvider } from "./support/provider.ts"
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
  await page.getByLabel("Name").fill("Models test")
  await page.getByLabel("Base URL").fill(provider.baseUrl)
  // Left empty, the key is optional for this kind: no key is sent.
  await page.getByRole("button", { name: "Create connection" }).click()

  // Creating it fetches the models, and the first becomes the default for new chats.
  const models = page.getByRole("list", { name: "Models" })
  await expect(page.getByText("Found 2 models.")).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "for new chats" })).toContainText("Using Fake Large")
  await page.getByRole("button", { name: "Refresh from provider" }).click()
  await expect(page.getByText("0 added, 2 updated")).toBeVisible()
  await expect(models.getByText("Fake Large")).toBeVisible()
  // The listed context, from the provider; the output limit nobody reported is marked unknown.
  await expect(models.locator("li", { hasText: "Fake Large" })).toContainText("Context 131.1k")
  await expect(models.locator("li", { hasText: "Fake Large" })).toContainText("Output 4.1k?")

  await page.getByRole("button", { name: "Hide fake-small" }).click()
  await expect(models.getByText("Fake Small")).toBeHidden()
  await page.getByRole("switch", { name: "Show hidden models" }).click()
  await expect(models.locator("li", { hasText: "Fake Small" })).toContainText("hidden")

  await page.getByRole("button", { name: "Edit fake-large" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Display name").fill("My large model")
  await dialog.getByLabel("Max output (tokens)").fill("8000")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()
  await expect(models.locator("li", { hasText: "My large model" })).toContainText("Output 8k*")

  await page.getByRole("button", { name: "Add a model" }).click()
  await page.getByRole("dialog").getByLabel("Model id").fill("fake-large")
  await page.getByRole("dialog").getByRole("button", { name: "Add model" }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("already has a model called “fake-large”")
  await page.getByRole("dialog").getByLabel("Model id").fill("fake-unlisted")
  await page.getByRole("dialog").getByRole("button", { name: "Add model" }).click()
  await expect(models.locator("li", { hasText: "fake-unlisted" })).toContainText("added by you")
})

test("model generation settings take typed decimals and keep the reply length apart from the output limit", async ({
  page
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await page.getByLabel("Name").fill("Settings test")
  await page.getByLabel("Base URL").fill(provider.baseUrl)
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByText("Found 2 models.")).toBeVisible()

  const models = page.getByRole("list", { name: "Models" })
  const dialog = page.getByRole("dialog")
  await page.getByRole("button", { name: "Edit fake-large" }).click()
  // Typed key by key, as a person types: "0." on the way to "0.7" must survive.
  await dialog.getByLabel("Temperature").pressSequentially("0.7")
  await expect(dialog.getByLabel("Temperature")).toHaveValue("0.7")
  await dialog.getByLabel("Top P").pressSequentially("0.95")
  await dialog.getByLabel("Top P").clear()
  await dialog.getByLabel("Response length (tokens)").pressSequentially("1200")
  await dialog.getByLabel("Seed (-1: none)").pressSequentially("-")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog.getByText("each takes a number")).toBeVisible()
  await dialog.getByLabel("Seed (-1: none)").clear()
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()
  // The reply length is a setting; the output limit the provider reports is unchanged.
  await expect(models.locator("li", { hasText: "Fake Large" })).toContainText("Output 4.1k?")

  await page.getByRole("button", { name: "Edit fake-large" }).click()
  await expect(dialog.getByLabel("Temperature")).toHaveValue("0.7")
  await expect(dialog.getByLabel("Top P")).toHaveValue("")
  await expect(dialog.getByLabel("Response length (tokens)")).toHaveValue("1200")
  await expect(dialog.getByLabel("Max output (tokens)")).toHaveValue("")
  await expect(dialog.getByLabel("Advanced model settings (JSON)")).toHaveValue(/"temperature": 0.7/)
})
