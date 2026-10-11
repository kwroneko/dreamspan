import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, type TestServer, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let other: FakeProvider
test.beforeAll(async () => {
  provider = await startProvider()
  other = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
  await other.stop()
})

const createConnection = async (page: Page, name: string, baseUrl: string, key: string) => {
  await page.goto(`${server().url}/settings/connections`)
  await page.getByRole("link", { name: "New connection" }).click()
  await page.getByLabel("Name").fill(name)
  await page.getByLabel("Base URL").fill(baseUrl)
  await page.getByLabel("Key", { exact: true }).fill(key)
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
}

const addUser = (s: TestServer, handle: string) =>
  asUser(s, ADMIN.handle, ADMIN.password, (api) =>
    api.CreateUser({ handle, displayName: handle, role: "user", password: `${handle}-password-1` })
  )

test("create, check, edit, route and delete a connection", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections`)
  await expect(page.getByText("No connections yet")).toBeVisible()

  // The form explains what's missing before anything is sent.
  await page.getByRole("link", { name: "New connection" }).click()
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByText("Give the connection a name.")).toBeVisible()

  await createConnection(page, "Local fake", provider.baseUrl, "sk-fake-key-123456")
  await expect(page.getByText("Key ending in 3456")).toBeVisible()

  await page.getByRole("button", { name: "Check" }).click()
  await expect(page.getByText("It works")).toBeVisible()
  await expect(page.getByText(/Route: direct/)).toBeVisible()
  expect(provider.keys).toContain("sk-fake-key-123456")

  await page.getByLabel("Name").fill("Local fake renamed")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Local fake renamed", level: 1 })).toBeVisible()

  await page.getByRole("button", { name: "Add headers" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Header 1 name").fill("X-Gateway-Token")
  await dialog.getByLabel("Header 1 value").fill("header-secret-value")
  await dialog.getByRole("button", { name: "Save headers" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("list", { name: "Header names" })).toContainText("X-Gateway-Token")
  await expect(page.locator("body")).not.toContainText("header-secret-value")

  await page.getByRole("radio", { name: /Direct/ }).click()
  await page.getByRole("button", { name: "Save route" }).click()
  await expect(page.getByRole("button", { name: "Save route" })).toBeDisabled()
  await page.goto(`${server().url}/settings/connections`)
  await expect(page.getByText("direct", { exact: true })).toBeVisible()

  await page.getByRole("link", { name: "Local fake renamed" }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page).toHaveURL(`${server().url}/settings/connections`)
  await expect(page.getByText("No connections yet")).toBeVisible()
})

test("two tabs: a change made in the other is loaded, and the next try succeeds", async ({ page, context }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await createConnection(page, "Two tabs", provider.baseUrl, "sk-two-tabs-key-000111")
  const second = await context.newPage()
  await second.goto(page.url())

  // The other tab renames it while this one edits the concurrency.
  await page.getByLabel("Concurrent requests").fill("3")
  await second.getByLabel("Name").fill("Renamed in the other tab")
  await second.getByRole("button", { name: "Save", exact: true }).click()
  await expect(second.getByRole("heading", { name: "Renamed in the other tab", level: 1 })).toBeVisible()

  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("changed since you opened it")
  await page.getByRole("button", { name: "Load the latest" }).click()
  await expect(page.getByLabel("Name")).toHaveValue("Renamed in the other tab")
  await page.getByLabel("Concurrent requests").fill("3")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByLabel("Concurrent requests")).toHaveValue("3")
  await expect(page.getByRole("alert")).toHaveCount(0)

  // A key typed against an address the other tab has since changed: refused, then reloaded.
  await second.reload()
  await second.getByLabel("Name").fill("Renamed again")
  await second.getByRole("button", { name: "Save", exact: true }).click()
  await expect(second.getByRole("heading", { name: "Renamed again", level: 1 })).toBeVisible()
  await page.getByRole("button", { name: "Enter a new key" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Key").fill("sk-two-tabs-key-222333")
  await dialog.getByRole("button", { name: "Save key" }).click()
  await expect(dialog.getByRole("alert")).toContainText("changed since you opened it")
  // Only possible with the reloaded row version.
  await dialog.getByRole("button", { name: "Save key" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Key ending in 2333")).toBeVisible()
  await second.close()
})

test("a key isn't sent to a new address until it's typed again", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await createConnection(page, "Bound", provider.baseUrl, "sk-bound-key-abcdef")
  await page.getByLabel("Base URL").fill(other.baseUrl)
  await page.getByRole("button", { name: "Save", exact: true }).click()

  const origin = new URL(other.baseUrl).origin
  await expect(page.getByText(`This key isn't allowed for ${origin}`)).toBeVisible()
  await page.getByRole("button", { name: "Check" }).click()
  await expect(page.getByText("It doesn't work")).toBeVisible()
  expect(other.keys).not.toContain("sk-bound-key-abcdef")

  await page.getByRole("button", { name: "Allow it" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Key").fill("not-the-key")
  await dialog.getByRole("button", { name: "Allow" }).click()
  await expect(dialog.getByRole("alert")).toContainText("That isn't this credential's key")
  await dialog.getByLabel("Key").fill("sk-bound-key-abcdef")
  await dialog.getByRole("button", { name: "Allow" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(`This key isn't allowed for ${origin}`)).toBeHidden()
  await page.getByRole("button", { name: "Check" }).click()
  await expect(page.getByText("It works")).toBeVisible()
  expect(other.keys).toContain("sk-bound-key-abcdef")
})

test("another user never sees someone's connections", async ({ browser }) => {
  await addUser(server(), "alice")
  await addUser(server(), "bob")
  const alice = await browser.newPage()
  await apiLogin(alice.request, server(), "alice", "alice-password-1")
  await createConnection(alice, "Alice's private gateway", provider.baseUrl, "sk-alice-secret-0001")
  const aliceUrl = alice.url()

  const bob = await browser.newPage()
  await apiLogin(bob.request, server(), "bob", "bob-password-1")
  await bob.goto(`${server().url}/settings/connections`)
  await expect(bob.getByText("No connections yet")).toBeVisible()
  await expect(bob.locator("body")).not.toContainText("Alice's private gateway")
  await bob.goto(aliceUrl)
  await expect(bob.getByText("This connection doesn't exist")).toBeVisible()
  await bob.goto(`${server().url}/settings/keys`)
  await expect(bob.getByText("No saved keys")).toBeVisible()

  // And the server agrees, whatever the page shows.
  const bobsView = await asUser(server(), "bob", "bob-password-1", (api) =>
    Effect.all([api.ListConnections(), api.ListCredentials()])
  )
  expect(bobsView).toEqual([[], []])
  await bob.close()

  // In the same tab: Alice logs out and Bob logs in. Nothing of hers is left behind.
  await alice.goto(`${server().url}/settings/connections`)
  await expect(alice.getByText("Alice's private gateway")).toBeVisible()
  await alice.getByRole("button", { name: "Log out" }).click()
  await alice.getByLabel("Handle").fill("bob")
  await alice.getByLabel("Password").fill("bob-password-1")
  await alice.getByRole("button", { name: "Log in" }).click()
  await alice.getByRole("link", { name: "Settings" }).click()
  await expect(alice.getByText("No connections yet")).toBeVisible()
  await expect(alice.locator("body")).not.toContainText("Alice's private gateway")
  await alice.close()
})
