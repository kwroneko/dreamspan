import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

test.describe("no passwords set", () => {
  const server = serverPerFile()

  test("the local admin goes straight in, and the login page says no login is needed", async ({ page }) => {
    await page.goto(server().url)
    await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible()
    await expect(page.getByTitle("Signed in as local (admin)")).toBeVisible()
    await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0)

    await page.goto(`${server().url}/login`)
    await expect(page.getByText("No login needed")).toBeVisible()
    await page.getByRole("link", { name: "Continue" }).click()
    await expect(page).toHaveURL(`${server().url}/`)
  })
})

test.describe("login required", () => {
  const server = serverPerFile(withAdmin)

  test("routes to login, refuses a wrong password, then returns to the page asked for", async ({ page }) => {
    await page.goto(`${server().url}/settings/account`)
    await expect(page).toHaveURL(/\/login\?next=/)
    await page.getByLabel("Handle").fill(ADMIN.handle)
    await page.getByLabel("Password").fill("not-the-password")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByRole("alert")).toContainText("Wrong handle or password")
    await expect(page.getByLabel("Password")).toHaveValue("")

    await page.getByLabel("Password").fill(ADMIN.password)
    await page.getByLabel("Password").press("Enter")
    await expect(page).toHaveURL(`${server().url}/settings/account`)

    await page.getByRole("button", { name: "Log out" }).first().click()
    await expect(page).toHaveURL(`${server().url}/login`)
    await page.goto(server().url)
    await expect(page).toHaveURL(/\/login/)
  })

  test("after login, next never leaves the site, however it's spelled", async ({ page }) => {
    // Browsers drop tabs and newlines from URLs and read a backslash as a slash.
    const tricks = [
      "/\t/evil.test/x",
      "/\r/evil.test/x",
      "/\n/evil.test/x",
      "/\\evil.test/x",
      "//evil.test/x",
      "https://evil.test/x"
    ]
    await page.route(
      (url) => url.hostname === "evil.test",
      (route) => route.fulfill({ status: 200, contentType: "text/html", body: "phished" })
    )
    for (const next of tricks) {
      await page.context().clearCookies()
      await page.goto(`${server().url}/login?next=${encodeURIComponent(next)}`)
      await page.getByLabel("Handle").fill(ADMIN.handle)
      await page.getByLabel("Password").fill(ADMIN.password)
      await page.getByRole("button", { name: "Log in" }).click()
      await expect(page.getByTitle("Signed in as admin (admin)"), JSON.stringify(next)).toBeVisible()
      expect(new URL(page.url()).origin, JSON.stringify(next)).toBe(server().url)
    }
  })

  test("a logout the server fails says so, and stays logged in", async ({ page }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/account`)
    await page.route("**/auth/logout", (route) => route.fulfill({ status: 500, body: "" }))
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Log out" }).click()
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("alert")).toContainText(
      "couldn't log you out (500)"
    )
    await expect(page).toHaveURL(`${server().url}/settings/account`)
  })

  test("a disabled account can't log in, and a disabled user's open tab is sent to login", async ({ browser }) => {
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.CreateUser({ handle: "dora", displayName: "Dora", role: "user", password: "dora-password-1" })
    )
    const dora = await browser.newPage()
    await dora.goto(`${server().url}/login`)
    await dora.getByLabel("Handle").fill("dora")
    await dora.getByLabel("Password").fill("dora-password-1")
    await dora.getByRole("button", { name: "Log in" }).click()
    await expect(dora.getByTitle("Signed in as Dora (user)")).toBeVisible()

    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const users = yield* api.ListUsers()
        yield* api.SetUserDisabled({ userId: users.find((user) => user.handle === "dora")!.id, disabled: true })
      })
    )

    // The next call from the open tab finds the session gone.
    await dora.getByRole("link", { name: "Settings" }).click()
    await expect(dora).toHaveURL(/\/login\?next=/)
    await dora.getByLabel("Handle").fill("dora")
    await dora.getByLabel("Password").fill("dora-password-1")
    await dora.getByRole("button", { name: "Log in" }).click()
    await expect(dora.getByRole("alert")).toContainText("Wrong handle or password")
    await dora.close()
  })
})

test.describe("throttled", () => {
  const server = serverPerFile(withAdmin)

  test("too many attempts: the server's Retry-After holds the form back", async ({ page }) => {
    // Nine wrong guesses straight to the endpoint, then the tenth and eleventh from the page.
    for (let i = 0; i < 9; i++) {
      const response = await page.request.post(`${server().url}/auth/login`, {
        data: { handle: ADMIN.handle, password: `wrong-${i}` },
        headers: { origin: server().url }
      })
      expect(response.status()).toBe(401)
    }
    await page.goto(`${server().url}/login`)
    await page.getByLabel("Handle").fill(ADMIN.handle)
    await page.getByLabel("Password").fill("wrong-again")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByRole("alert")).toContainText("Wrong handle or password")
    await page.getByLabel("Password").fill(ADMIN.password)
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByRole("alert")).toContainText("Too many attempts")
    await expect(page.getByText(/try again in 1[45]:\d\d/)).toBeVisible()
    // The countdown stays out of the live region, so it isn't announced every second.
    await expect(page.getByRole("alert")).not.toContainText(/\d:\d\d/)
    await expect(page.getByRole("button", { name: "Log in" })).toBeDisabled()
  })
})

test.describe("proxy mode", () => {
  const server = serverPerFile({ AUTH_MODE: "proxy" })

  test("the login page sends the user to the reverse proxy", async ({ page }) => {
    await page.goto(`${server().url}/login`)
    await page.getByLabel("Handle").fill("anyone")
    await page.getByLabel("Password").fill("anything-at-all")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByText("Login happens at your reverse proxy")).toBeVisible()
  })
})
