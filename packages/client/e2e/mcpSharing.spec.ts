// Sharing an admin's MCP server (spec/MCP.md §3, M5) against a local fake MCP server: the admin
// picks a person in the share dialog, that person sees the server marked as shared, without its
// address's path or key and without the owner's settings, and can turn it on for themselves.
// Layout of each surface at both widths, both themes.
import { expect, type Page, test } from "@playwright/test"
import { type FakeMcpServer, fakeTool, startFakeMcpServer } from "../../server/test/support/fakeMcpServer.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const KEY = "sk-team-key-4321"
const server = serverPerFile(withAdmin)
let mcp: FakeMcpServer
test.beforeAll(async () => {
  mcp = await startFakeMcpServer({ key: KEY, tools: [fakeTool("search_notes", { title: "Search notes" })] })
})
test.afterAll(async () => {
  await mcp.close()
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
  test(`share an MCP server at ${width}px`, async ({ browser }, info) => {
    const handle = `pat${width}`
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.CreateUser({ handle, displayName: `Pat ${width}`, role: "user", password: `${handle}-password-1` })
    )
    const created = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.CreateMcpConnection({
        settings: {
          name: `Team ${width}`,
          about: "Shared notes",
          transport: "streamable-http",
          url: `${mcp.streamableUrl}?space=hidden-part`,
          timeoutS: 5
        },
        apiKey: KEY
      })
    )
    const id = created.connection.id

    const admin = await browser.newPage({ viewport: { width, height: 900 } })
    await apiLogin(admin.request, server(), ADMIN.handle, ADMIN.password)
    await admin.goto(`${server().url}/settings/mcp/${id}`)
    await expect(admin.getByText("Only you.")).toBeVisible()
    await admin.getByRole("button", { name: "Change", exact: true }).click()
    const dialog = admin.getByRole("dialog")
    await dialog.getByRole("radio", { name: /Chosen people/ }).click()
    await dialog.getByRole("checkbox", { name: new RegExp(`Pat ${width}`) }).click()
    await audit(admin, info, "mcp-share-dialog", width)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toBeHidden()
    await expect(admin.getByText("1 person you chose.")).toBeVisible()
    await audit(admin, info, "mcp-share-owner", width)
    await admin.close()

    const user = await browser.newPage({ viewport: { width, height: 900 } })
    await apiLogin(user.request, server(), handle, `${handle}-password-1`)
    await user.goto(`${server().url}/settings/mcp`)
    await expect(user.getByText(/^Shared by /).first()).toBeVisible()
    await user.getByRole("link", { name: `Team ${width}` }).click()
    await expect(user.getByRole("heading", { name: `Team ${width}`, level: 1 })).toBeVisible()
    await expect(user.locator("[data-mcp-shared-server]")).toBeVisible()
    // None of the owner's settings, and never the address's path or the key.
    await expect(user.getByRole("heading", { name: "Sharing" })).toHaveCount(0)
    await expect(user.getByRole("button", { name: "Check now" })).toHaveCount(0)
    await expect(user.getByText("hidden-part")).toHaveCount(0)
    await expect(user.getByText(KEY.slice(-4))).toHaveCount(0)
    await expect(
      user.getByRole("list", { name: "Tools" }).getByRole("checkbox", { name: /Search notes/ })
    ).toBeVisible()
    await audit(user, info, "mcp-shared-user", width)
    await user.close()
  })
