// Settings' navigation: groups in a column beside the page on a wide screen; on a phone the list,
// each page alone under a way back to it; every page at its own address; no Admin heading for
// a user who isn't one.
import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("beside the page: the groups, the first page at /settings, and a link lands on the page it names", async ({
  browser
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings`)
  await expect(page).toHaveURL(/\/settings\/connections$/)
  const nav = page.getByRole("navigation", { name: "Settings" })
  for (const [group, pages] of [
    ["Models", ["Connections", "Keys", "Costs", "Network"]],
    ["Chatting", ["Chats", "Display", "Notifications"]],
    ["Account", ["Account", "Users"]],
    ["Admin", ["Server status"]]
  ] as const) {
    const section = nav.getByRole("region", { name: group })
    await expect(section.getByRole("link")).toHaveText([...pages])
  }

  await page.goto(`${server().url}/settings/chats`)
  await expect(nav.getByRole("link", { name: "Chats", exact: true })).toHaveAttribute("aria-current", "page")
  await page.goto(`${server().url}/settings/status`)
  await expect(page.getByRole("heading", { name: "Admin diagnostics" })).toBeVisible()
  // The page's own title, not the list's.
  await expect(page).toHaveTitle(/^Server status/)
  await context.close()
})

test("on a phone: the list, a page alone under the way back, and back to the list", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  const main = page.getByRole("main")
  await page.goto(`${server().url}/settings`)
  await expect(main.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible()
  await expect(page).toHaveURL(/\/settings$/)
  await main.getByRole("link", { name: "Chats", exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/chats$/)
  await expect(main.getByRole("navigation", { name: "Settings" })).toBeHidden()
  await expect(main.getByRole("heading", { level: 1, name: "Chats" })).toBeVisible()
  await main.getByRole("link", { name: "Settings", exact: true }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(main.getByRole("navigation", { name: "Settings" })).toBeVisible()

  // A link from elsewhere opens its page directly.
  await page.goto(`${server().url}/settings/keys`)
  await expect(main.getByRole("heading", { level: 1, name: "Keys" })).toBeVisible()
  // A page inside one has its own way back (Cancel, "← Connections"), so no second one above it.
  await page.goto(`${server().url}/settings/connections/new`)
  await expect(main.getByRole("heading", { name: "New connection" })).toBeVisible()
  await expect(main.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0)
  await context.close()
})

test("a user who isn't an admin sees no Admin group: the server's status is under Account, without diagnostics", async ({
  page
}) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateUser({ handle: "uma", displayName: "Uma", role: "user", password: "uma-password-1" })
  )
  await apiLogin(page.request, server(), "uma", "uma-password-1")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${server().url}/settings/status`)
  const nav = page.getByRole("navigation", { name: "Settings" })
  await expect(nav.getByRole("region", { name: "Account" }).getByRole("link")).toHaveText(["Account", "Server status"])
  await expect(nav.getByRole("region", { name: "Admin" })).toHaveCount(0)
  await expect(page.getByText(/^Running/)).toBeVisible()
  await expect(page.getByRole("heading", { name: "Admin diagnostics" })).toHaveCount(0)
})
