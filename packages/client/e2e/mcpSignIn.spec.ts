// Signing in with an MCP server (spec/MCP.md §2.4, M5) against a local fake MCP server and a fake
// authorization server: the server says it wants sign-in, Sign in opens its page in a new tab,
// the tab comes back to the app, finishes and closes, and the server's page shows the sign-in
// and the tools; Sign out forgets it. Layout of each surface at both widths, both themes.
import { expect, type Page, test } from "@playwright/test"
import { type FakeAuthServer, startFakeAuthServer } from "../../server/test/support/fakeAuthServer.ts"
import { type FakeMcpServer, fakeTool, startFakeMcpServer } from "../../server/test/support/fakeMcpServer.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let auth: FakeAuthServer
let mcp: FakeMcpServer
test.beforeAll(async () => {
  auth = await startFakeAuthServer()
  mcp = await startFakeMcpServer({ auth, tools: [fakeTool("search_notes", { title: "Search notes" })] })
})
test.afterAll(async () => {
  await mcp.close()
  await auth.close()
})

const audit = async (page: Page, info: Parameters<typeof expectLayout>[1], name: string, width: number) => {
  if (!process.env.LAYOUT_AUDIT) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, info, `${name}-${width}-${colorScheme}`)
  }
  await page.emulateMedia({ colorScheme: "light" })
}

for (const width of [1440, 390])
  test(`sign in with an MCP server at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/mcp/new`)
    const name = `Signed ${width}`
    await page.getByLabel("Name", { exact: true }).fill(name)
    await page.getByLabel("Address", { exact: true }).fill(mcp.streamableUrl)
    await page.getByRole("button", { name: "Add and check" }).click()
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
    await expect(page.getByText(/asks you to sign in/).first()).toBeVisible()

    const block = page.locator("[data-mcp-sign-in]")
    await expect(block.getByText("Not signed in.")).toBeVisible()
    const signIn = block.getByRole("button", { name: "Sign in", exact: true })
    await expect(signIn).toHaveAccessibleDescription(/Opens 127\.0\.0\.1:\d+'s sign-in page in a new tab/)
    await audit(page, info, "mcp-sign-in-before", width)

    // The tab goes to the server's sign-in page, comes back to the app and closes itself.
    const [tab] = await Promise.all([page.waitForEvent("popup"), signIn.click()])
    await tab.waitForEvent("close")
    expect(auth.requests()).toContain("token:authorization_code")
    await expect(block.getByText(/Signed in/)).toBeVisible()
    // Signing in checked the server again: its tools are listed now.
    await expect(
      page.getByRole("list", { name: "Tools" }).getByRole("checkbox", { name: /Search notes/ })
    ).toBeChecked()
    await audit(page, info, "mcp-sign-in-after", width)

    await block.getByRole("button", { name: "Sign out" }).click()
    await expect(block.getByText("Not signed in.")).toBeVisible()

    // The page the sign-in comes back to, when it can't finish.
    await page.goto(`${server().url}/mcp/oauth/callback?state=stale&code=x`)
    await expect(page.getByText("This sign-in has expired or was started elsewhere.", { exact: false })).toBeVisible()
    await audit(page, info, "mcp-sign-in-callback", width)
  })
