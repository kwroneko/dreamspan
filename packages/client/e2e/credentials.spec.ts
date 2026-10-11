import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

test("save, rename, allow, replace and delete a key, which never comes back out", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const origin = new URL(provider.baseUrl).origin
  await page.goto(`${server().url}/settings/keys`)
  await expect(page.getByText("No saved keys")).toBeVisible()

  await page.getByRole("button", { name: "Save a key" }).click()
  let dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name").fill("Shared gateway key")
  await dialog.getByLabel("Key").fill("sk-shared-secret-9876")
  await dialog.getByLabel("Addresses it may be sent to").fill(`${provider.baseUrl}\nnot a url`)
  await expect(dialog.getByText("Not a URL: not a url")).toBeVisible()
  await dialog.getByLabel("Addresses it may be sent to").fill(provider.baseUrl)
  await dialog.getByRole("button", { name: "Save key" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Key ending in 9876")).toBeVisible()
  await expect(page.getByRole("list", { name: "Addresses Shared gateway key may be sent to" })).toContainText(origin)
  await expect(page.locator("body")).not.toContainText("sk-shared-secret")

  await page.getByRole("button", { name: "Rename" }).click()
  await page.getByRole("dialog").getByLabel("Name").fill("Gateway key")
  await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click()
  await expect(page.getByText("Gateway key", { exact: true })).toBeVisible()

  // A connection uses it, so replacing the key offers the connection's address.
  await page.goto(`${server().url}/settings/connections/new`)
  await page.getByLabel("Name").fill("Uses the saved key")
  await page.getByLabel("Base URL").fill(provider.baseUrl)
  await page.getByRole("radio", { name: "Use a saved key" }).click()
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByText("saved as “Gateway key”")).toBeVisible()

  await page.goto(`${server().url}/settings/keys`)
  await page.getByRole("button", { name: "Allow an address" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Address").fill("https://second.example/v1")
  await dialog.getByLabel("Key").fill("sk-shared-secret-9876")
  await dialog.getByRole("button", { name: "Allow" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("list", { name: "Addresses Gateway key may be sent to" })).toContainText(
    "https://second.example"
  )

  await page.getByRole("button", { name: "Replace key" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("New key", { exact: true }).fill("sk-replaced-secret-5555")
  // Nothing is ticked for the user: each address is confirmed, and new ones are flagged.
  const used = dialog.getByRole("checkbox", { name: new RegExp(origin.replace(/[.:/]/g, "\\$&")) })
  await expect(used).not.toBeChecked()
  await expect(dialog.getByRole("checkbox", { name: /second\.example/ })).not.toBeChecked()
  await dialog.getByLabel("Another address").fill("https://third.example")
  await dialog.getByRole("button", { name: "Add" }).click()
  await expect(dialog.getByRole("checkbox", { name: /third\.example.*new/ })).toBeChecked()
  await used.click()
  await dialog.getByRole("button", { name: "Replace key" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("Key ending in 5555")).toBeVisible()
  const allowed = page.getByRole("list", { name: "Addresses Gateway key may be sent to" })
  await expect(allowed).toContainText(origin)
  await expect(allowed).toContainText("https://third.example")
  await expect(allowed).not.toContainText("second.example")

  const stored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCredentials())
  expect(JSON.stringify(stored)).not.toContain("secret")

  await page.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("1 connection uses it")
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete key" }).click()
  await expect(page.getByText("No saved keys")).toBeVisible()
  const connections = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListConnections().pipe(Effect.map((list) => list.map((connection) => connection.hasKey)))
  )
  expect(connections).toEqual([false])
})

test("replacing a key without its connections' address warns first, and the connection says why it's blocked", async ({
  page
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await page.getByLabel("Name").fill("Strandable")
  await page.getByLabel("Base URL").fill(provider.baseUrl)
  await page.getByLabel("Key", { exact: true }).fill("sk-strandable-key-0001")
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByRole("heading", { name: "Strandable", level: 1 })).toBeVisible()
  const connectionUrl = page.url()

  await page.goto(`${server().url}/settings/keys`)
  await page.getByRole("button", { name: "Replace key" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("New key", { exact: true }).fill("sk-strandable-key-0002")
  await dialog.getByRole("button", { name: "Replace key" }).click()
  await expect(dialog.getByRole("status")).toContainText("Some connections will stop working")
  await expect(dialog.getByRole("status")).toContainText("Strandable")
  await dialog.getByRole("button", { name: "Replace anyway" }).click()
  await expect(dialog).toBeHidden()

  await page.goto(connectionUrl)
  const blocked = page.getByRole("status").filter({ hasText: "isn't allowed for" })
  await expect(blocked).toContainText("when the key is replaced without allowing it")
  await expect(blocked).not.toContainText("someone else")
})
