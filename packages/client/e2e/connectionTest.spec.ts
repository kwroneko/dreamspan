// Testing a connection (owner, 2026-11-20): on the new connection form the values as typed are
// tested with nothing saved, the test lists the models and sends one short message to the model
// chosen, and with no default model yet the user picks it there. A connection's page has the
// same test near its top. The layout audit runs at 1440 and 390 px with LAYOUT_AUDIT=1.
import { expect, type Page, test, type TestInfo } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { chooseCustomServer, type FakeProvider, REPLY, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.describe.configure({ mode: "serial" })
let provider: FakeProvider
test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const audit = async (page: Page, info: TestInfo, surface: string) => {
  if (!process.env.LAYOUT_AUDIT) return
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expectLayout(page, info, `${surface}-${width}`, { scope: "main" })
    // The whole page, for review.
    await page.screenshot({ path: info.outputPath(`${surface}-${width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

test("the new connection form tests the typed values without saving, and the user picks the default", async ({
  page
}, info) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await chooseCustomServer(page)
  await page.getByLabel("Base URL", { exact: true }).fill(provider.baseUrl)
  await page.getByLabel("API key", { exact: true }).fill("sk-typed-test-key-7781")

  const testButton = page.getByRole("button", { name: "Test", exact: true })
  await expect(testButton).toBeInViewport()
  // Its explanation says what it sends.
  await testButton.hover()
  await expect(testButton).toHaveAccessibleDescription(/sends one short message to the chosen model/)
  await expect(page.getByText(/sends one short message to the chosen model/).last()).toBeVisible()
  await testButton.click()
  const result = page.getByRole("status").filter({ hasText: "It works" })
  await expect(result).toContainText("2 models listed")
  await expect(result).toContainText(/Route: direct/)
  // No model chosen yet: nothing went to a model.
  expect(provider.completions.length).toBe(0)
  await audit(page, info, "new-connection-listed")

  // The listed models are the choices for the default; choosing one lets the test send to it.
  await page.getByRole("combobox", { name: "Default model for new chats", exact: true }).click()
  await page.getByRole("option", { name: "fake-large" }).click()
  await page.getByRole("button", { name: "Send test message" }).click()
  await expect(result).toContainText(`fake-large replied in`)
  await expect(result).toContainText(REPLY)
  expect(provider.completions.length).toBe(1)
  expect(provider.keys).toContain("sk-typed-test-key-7781")
  await audit(page, info, "new-connection-replied")

  // Nothing was saved: no connection, no key, no default.
  const saved = await admin((api) => api.ListConnections())
  expect(saved).toEqual([])
  expect(await admin((api) => api.ListCredentials())).toEqual([])
  expect((await admin((api) => api.GetGenerationDefaults())).model).toBeNull()

  // An unreachable server fails in plain words.
  await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:9/v1")
  await testButton.click()
  const failed = page.getByRole("alert").filter({ hasText: "It doesn't work" })
  await expect(failed).toContainText("The server couldn't be reached")
  await audit(page, info, "new-connection-failed")
  await page.getByLabel("Base URL", { exact: true }).fill(provider.baseUrl)

  // Created: the chosen model is the default, and the page's own test is near its top.
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByRole("status").filter({ hasText: "for new chats" })).toContainText(
    "Using Fake Large for new chats"
  )
  const defaults = await admin((api) => api.GetGenerationDefaults())
  expect(defaults.model).not.toBeNull()
  const pageTest = page.getByRole("button", { name: "Test", exact: true })
  await expect(pageTest).toBeInViewport()
  await pageTest.click()
  const pageResult = page.getByRole("status").filter({ hasText: "It works" })
  await expect(pageResult).toContainText("fake-large replied in")
  await expect(pageResult).toContainText(REPLY)
  await audit(page, info, "connection-tested")

  // On a phone the test is in reach too.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole("button", { name: "Test", exact: true })).toBeInViewport()
})
