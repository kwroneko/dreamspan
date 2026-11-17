// Settings → Tools → MCP servers (spec/MCP.md §13.1), against a local fake MCP server:
// add, check, allow tools, sign-in, delete, and the layout of each surface at both widths and
// in both themes. Never a third-party server.
import { expect, type Page, test } from "@playwright/test"
import { type FakeMcpServer, fakeTool, startFakeMcpServer } from "../../server/test/support/fakeMcpServer.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const KEY = "sk-mcp-e2e-synthetic-key-4321"
let mcp: FakeMcpServer
test.beforeAll(async () => {
  mcp = await startFakeMcpServer({
    key: KEY,
    tools: [
      fakeTool("search_notes", { title: "Search notes", annotations: { readOnlyHint: true } }),
      fakeTool("write_note", { annotations: { destructiveHint: true } }),
      { name: "broken", inputSchema: { type: "string" } }
    ]
  })
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
  test(`add, check, allow tools and delete an MCP server at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/mcp`)
    await expect(page.getByText("No MCP servers yet")).toBeVisible()
    await audit(page, info, "mcp-empty", width)
    mcp.reset()

    // The form says what's missing, and nothing is sent until it's added.
    await page.getByRole("link", { name: "Add a server" }).click()
    await page.getByLabel("Address", { exact: true }).fill("example dot com")
    await page.getByRole("button", { name: "Add and check" }).click()
    await expect(page.getByText("Enter a full address, such as https://example.com/mcp.")).toBeVisible()
    await audit(page, info, "mcp-new", width)
    expect(mcp.requests()).toHaveLength(0)

    const name = `Notes ${width}`
    await page.getByLabel("Name", { exact: true }).fill(name)
    await page.getByLabel("Address", { exact: true }).fill(mcp.streamableUrl)
    await page.getByLabel("Bearer token", { exact: true }).fill(KEY)
    await page.getByRole("button", { name: "Add and check" }).click()
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
    await expect(page.getByText("Token ending in 4321")).toBeVisible()
    expect(mcp.requests().every((request) => request.headers.authorization === `Bearer ${KEY}`)).toBe(true)

    // The tools as listed: usable ones on, the broken one marked and off.
    const tools = page.getByRole("list", { name: "Tools" })
    await expect(tools.getByRole("checkbox", { name: /Search notes/ })).toBeChecked()
    await expect(tools.getByRole("checkbox", { name: /write_note/ })).toBeChecked()
    await expect(tools.getByRole("checkbox", { name: /broken/ })).toBeDisabled()
    await expect(tools.getByText("Can't be used: Its parameters aren't valid.")).toBeVisible()
    await expect(tools.getByText("Only reads")).toBeVisible()
    await tools.getByRole("checkbox", { name: /write_note/ }).click()
    await expect(tools.getByRole("checkbox", { name: /write_note/ })).not.toBeChecked()

    // Check again: one request each, all recorded.
    await page.getByRole("button", { name: "Check now" }).click()
    await expect(page.getByText("It works")).toBeVisible()
    await expect(page.getByRole("list", { name: "Recent calls" }).getByText("List tools").first()).toBeVisible()
    await audit(page, info, "mcp-server", width)

    // The list shows it, ready.
    await page.goto(`${server().url}/settings/mcp`)
    await expect(page.getByRole("link", { name })).toBeVisible()
    await expect(page.getByText("Ready")).toBeVisible()
    await audit(page, info, "mcp-list", width)

    // Delete: to the bin, and off the list.
    await page.getByRole("link", { name }).click()
    await page.getByRole("button", { name: "Delete", exact: true }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
    await expect(page.getByText("No MCP servers yet")).toBeVisible()
    await page.goto(`${server().url}/bin`)
    await expect(page.getByText(name).first()).toBeVisible()
  })
