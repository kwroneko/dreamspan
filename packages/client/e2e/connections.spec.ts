import { logoutFromSettings } from "./support/appMenu.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { chooseCustomServer, startProvider, type FakeProvider } from "./support/provider.ts"
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
  await chooseCustomServer(page)
  await page.getByLabel("Name", { exact: true }).fill(name)
  await page.getByLabel("Base URL", { exact: true }).fill(baseUrl)
  await page.getByLabel("API key", { exact: true }).fill(key)
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
  await chooseCustomServer(page)
  await page.getByLabel("Base URL", { exact: true }).fill("localhost port 5001")
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByText("Enter a full URL, such as http://localhost:8000/v1.")).toBeVisible()
  // Focus goes to the first invalid field, and its description carries the error.
  await expect(page.getByLabel("Base URL", { exact: true })).toBeFocused()
  await expect(page.getByLabel("Base URL", { exact: true })).toHaveAccessibleDescription(/Enter a full URL/)
  await page.getByLabel("Base URL", { exact: true }).fill("")

  await createConnection(page, "Local fake", provider.baseUrl, "sk-fake-key-123456")
  await expect(page.getByText("Key ending in 3456")).toBeVisible()

  await page.getByRole("button", { name: "Check", exact: true }).click()
  await expect(page.getByText("It works")).toBeVisible()
  await expect(page.getByText(/Route: direct/)).toBeVisible()
  expect(provider.keys).toContain("sk-fake-key-123456")

  await page.getByLabel("Name", { exact: true }).fill("Local fake renamed")
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
  await page.getByLabel("Concurrent requests", { exact: true }).fill("3")
  await second.getByLabel("Name", { exact: true }).fill("Renamed in the other tab")
  await second.getByRole("button", { name: "Save", exact: true }).click()
  await expect(second.getByRole("heading", { name: "Renamed in the other tab", level: 1 })).toBeVisible()

  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("changed since you opened it")
  await page.getByRole("button", { name: "Load the latest" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Renamed in the other tab")
  // The shared draft can already show that name before its asynchronous discard
  // finishes. Start the next edit only once the loaded form is clean.
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0)
  // The second tab may have opened the shared draft after concurrency was typed and
  // saved that visible value too. Make a fresh change after loading the latest version.
  await page.getByLabel("Concurrent requests", { exact: true }).fill("4")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByLabel("Concurrent requests", { exact: true })).toHaveValue("4")
  await expect(page.getByRole("alert")).toHaveCount(0)

  // The field already held 4 before Save: wait for the write before reloading another tab.
  await expect
    .poll(() =>
      asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.map(
          api.ListConnections(),
          (connections) => connections.find((c) => c.name === "Renamed in the other tab")?.maxConcurrent
        )
      )
    )
    .toBe(4)

  // A key typed against an address the other tab has since changed: refused, then reloaded.
  await second.reload()
  await second.getByLabel("Name", { exact: true }).fill("Renamed again")
  await second.getByRole("button", { name: "Save", exact: true }).click()
  await expect(second.getByRole("heading", { name: "Renamed again", level: 1 })).toBeVisible()
  await page.getByRole("button", { name: "Enter a new key" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Key", { exact: true }).fill("sk-two-tabs-key-222333")
  await dialog.getByRole("button", { name: "Save key" }).click()
  await expect(dialog.getByRole("alert")).toContainText("changed since you opened it")
  // Only possible with the reloaded row version.
  await dialog.getByRole("button", { name: "Save key" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Key ending in 2333")).toBeVisible()
  await second.close()
})

/** Another session points the named connection at another address, behind the page's back. */
const repoint = (name: string, baseUrl: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = (yield* api.ListConnections()).find((entry) => entry.name === name)!
      yield* api.UpdateConnection({
        connectionId: connection.id,
        expectedRowVersion: connection.rowVersion,
        settings: { ...connection, baseUrl }
      })
    })
  )

test("a key or header typed for one address isn't sent to the one another session switched to", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await createConnection(page, "Re-pointed", provider.baseUrl, "sk-repointed-first-0001")
  const from = new URL(provider.baseUrl).origin
  const to = new URL(other.baseUrl).origin

  await page.getByRole("button", { name: "Enter a new key" }).click()
  let dialog = page.getByRole("dialog")
  await dialog.getByLabel("Key", { exact: true }).fill("sk-repointed-victim-0002")
  await repoint("Re-pointed", other.baseUrl)
  await dialog.getByRole("button", { name: "Save key" }).click()
  await expect(dialog.getByRole("alert")).toContainText("changed since you opened it")
  await expect(dialog.getByRole("status")).toContainText(`The address changed from ${from} to ${to}`)
  await expect(dialog.getByLabel("Key", { exact: true })).toHaveValue("")
  await expect(dialog.getByRole("button", { name: "Save key" })).toBeDisabled()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await page.getByRole("button", { name: "Check", exact: true }).click()
  await expect(page.getByText("It doesn't work")).toBeVisible()
  expect(other.keys).not.toContain("sk-repointed-victim-0002")

  await repoint("Re-pointed", provider.baseUrl)
  await page.reload()
  await page.getByRole("button", { name: "Add headers" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Header 1 name").fill("X-Token")
  await dialog.getByLabel("Header 1 value").fill("header-victim-0003")
  await repoint("Re-pointed", other.baseUrl)
  await dialog.getByRole("button", { name: "Save headers" }).click()
  await expect(dialog.getByRole("status")).toContainText(`The address changed from ${from} to ${to}`)
  await expect(dialog.getByLabel("Header 1 value")).toHaveValue("")
  await expect(dialog.getByRole("button", { name: "Save headers" })).toBeDisabled()
  const saved = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListConnections())
  expect(saved.find((entry) => entry.name === "Re-pointed")!.headerNames).toEqual([])
})

test("a key isn't sent to a new address until it's typed again", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await createConnection(page, "Bound", provider.baseUrl, "sk-bound-key-abcdef")
  await page.getByLabel("Base URL", { exact: true }).fill(other.baseUrl)
  await page.getByRole("button", { name: "Save", exact: true }).click()

  const origin = new URL(other.baseUrl).origin
  await expect(page.getByText(`This key isn't allowed for ${origin}`)).toBeVisible()
  await page.getByRole("button", { name: "Check", exact: true }).click()
  await expect(page.getByText("It doesn't work")).toBeVisible()
  expect(other.keys).not.toContain("sk-bound-key-abcdef")

  await page.getByRole("button", { name: "Allow it" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Key", { exact: true }).fill("not-the-key")
  await dialog.getByRole("button", { name: "Allow" }).click()
  await expect(dialog.getByRole("alert")).toContainText("That isn't this credential's key")
  await dialog.getByLabel("Key", { exact: true }).fill("sk-bound-key-abcdef")
  await dialog.getByRole("button", { name: "Allow" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(`This key isn't allowed for ${origin}`)).toBeHidden()
  await page.getByRole("button", { name: "Check", exact: true }).click()
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
  await logoutFromSettings(alice)
  await alice.getByLabel("Handle", { exact: true }).fill("bob")
  await alice.getByLabel("Password", { exact: true }).fill("bob-password-1")
  await alice.getByRole("button", { name: "Log in" }).click()
  await alice.getByRole("link", { name: "Settings" }).click()
  await expect(alice.getByText("No connections yet")).toBeVisible()
  await expect(alice.locator("body")).not.toContainText("Alice's private gateway")
  await alice.close()
})
