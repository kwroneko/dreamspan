import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

test.describe("with an admin password", () => {
  const server = serverPerFile(withAdmin)

  test("an admin creates, resets and disables a user, and the user changes their password", async ({
    page,
    browser
  }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/users`)
    await page.getByRole("button", { name: "New user" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Handle").fill("carol")
    await dialog.getByLabel("Display name").fill("Carol")
    await dialog.getByLabel("Password").fill("short")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog.getByRole("alert")).toContainText(/8/)
    await dialog.getByLabel("Password").fill("carol-password-1")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog).toBeHidden()
    const users = page.getByRole("list", { name: "Users" })
    await expect(users.locator("li", { hasText: "Carol" })).toBeVisible()

    // The same handle again is the server's to refuse.
    await page.getByRole("button", { name: "New user" }).click()
    dialog = page.getByRole("dialog")
    await dialog.getByLabel("Handle").fill("carol")
    await dialog.getByLabel("Password").fill("another-password-1")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog.getByRole("alert")).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await users.locator("li", { hasText: "Carol" }).getByRole("button", { name: "Set password" }).click()
    await page.getByRole("dialog").getByLabel("New password").fill("carol-password-2")
    await page.getByRole("dialog").getByRole("button", { name: "Set password" }).click()
    await expect(page.getByRole("dialog")).toBeHidden()

    // Carol changes her own password, which ends her session.
    const carol = await browser.newPage()
    await apiLogin(carol.request, server(), "carol", "carol-password-2")
    await carol.goto(`${server().url}/settings/account`)
    await carol.getByLabel("Current password").fill("wrong-password")
    await carol.getByLabel("New password").fill("carol-password-3")
    await carol.getByRole("button", { name: "Change password" }).click()
    await expect(carol.getByRole("alert")).toContainText("current password doesn't match")
    await carol.getByLabel("Current password").fill("carol-password-2")
    await carol.getByRole("button", { name: "Change password" }).click()
    await expect(carol.getByText("Password changed")).toBeVisible()
    await carol.getByLabel("Handle").fill("carol")
    await carol.getByLabel("Password").fill("carol-password-3")
    await carol.getByRole("button", { name: "Log in" }).click()
    await expect(carol.getByText("Signed in as Carol (user)")).toBeVisible()
    await carol.close()

    await users.locator("li", { hasText: "Carol" }).getByRole("button", { name: "Disable" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Disable" }).click()
    await expect(users.locator("li", { hasText: "Carol" })).toContainText("disabled")
    await users.locator("li", { hasText: "Carol" }).getByRole("button", { name: "Enable" }).click()
    await expect(users.locator("li", { hasText: "Carol" })).not.toContainText("disabled")
  })
})

test.describe("without passwords", () => {
  const server = serverPerFile()

  test("the passwordless admin is told to set a password first, then sets one and logs in", async ({ page }) => {
    await page.goto(`${server().url}/settings/users`)
    await page.getByRole("button", { name: "New user" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Handle").fill("dave")
    await dialog.getByLabel("Password").fill("dave-password-1")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog.getByRole("alert")).toContainText("Set your own password before creating accounts")
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await page.goto(`${server().url}/settings/account`)
    await expect(page.getByText("No account has a password")).toBeVisible()
    await expect(page.getByLabel("Current password")).toHaveCount(0)
    await page.getByLabel("New password").fill("local-password-1")
    await page.getByRole("button", { name: "Set password" }).click()
    await expect(page.getByText("Password changed")).toBeVisible()
    await page.getByLabel("Handle").fill("local")
    await page.getByLabel("Password").fill("local-password-1")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByText("Signed in as local (admin)")).toBeVisible()
  })
})
