import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("an admin sets the proxy, which shows without its password; bad settings are explained", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/network`)
  await expect(page.getByText("No proxy is set")).toBeVisible()

  // Requiring the proxy without one, and a bypass entry the server can't read.
  await page.getByRole("switch", { name: "Require the proxy for everyone else" }).click()
  await page.getByLabel("Bypass list", { exact: true }).fill("intranet.example\nnot a host!")
  await page.getByRole("button", { name: "Save" }).click()
  const alert = page.getByRole("alert")
  await expect(alert).toContainText("These settings can't be used")
  await expect(alert).toContainText("Bypass entry not understood: not a host!")
  await expect(alert).toContainText("Requiring the proxy needs a proxy to be set")

  await page.getByRole("radio", { name: "Set a proxy" }).click()
  await page.getByLabel("Proxy URL").fill("socks5://vpnuser:proxy-secret@vpn.example:1080")
  await page.getByLabel("Bypass list", { exact: true }).fill("intranet.example")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Saved.")).toBeVisible()
  await expect(page.getByText("socks5://vpn.example:1080")).toBeVisible()
  await expect(page.locator("body")).not.toContainText("proxy-secret")
  await expect(page.locator("body")).not.toContainText("vpnuser")

  await page.reload()
  await expect(page.getByText("socks5://vpn.example:1080")).toBeVisible()
  await expect(page.getByRole("switch", { name: "Require the proxy for everyone else" })).toBeChecked()
  await expect(page.getByLabel("Bypass list", { exact: true })).toHaveValue("intranet.example")
})

test("a user who isn't an admin has no network settings", async ({ page }) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateUser({ handle: "ursula", displayName: "Ursula", role: "user", password: "ursula-password-1" })
  )
  await apiLogin(page.request, server(), "ursula", "ursula-password-1")
  await page.goto(`${server().url}/settings`)
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Network" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0)
  await page.goto(`${server().url}/settings/network`)
  await expect(page.getByRole("alert")).toContainText("Only an admin can change instance settings")
})
