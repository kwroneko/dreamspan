// A local program as an MCP server (spec/MCP.md §2.2, M6), on a server started with
// MCP_LOCAL_PROGRAMS=on: the admin picks Local program, gives the program and its arguments,
// the app runs it in the sandbox and lists its tools; the page shows Environment and the
// program's output instead of sign-in and route. Skipped where the sandbox can't run. Layout of
// each surface at both widths, both themes.
import { expect, type Page, test } from "@playwright/test"
import { linuxBwrap } from "../../server/src/sandbox/linuxBwrap.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, MCP_LOCAL_PROGRAMS: "on" })
const sandbox = await linuxBwrap.available()

/** A tiny MCP server over stdio, as one argument for `node -e`. */
const PROGRAM = [
  `const rl = require("readline").createInterface({ input: process.stdin });`,
  `process.stderr.write("notes server ready\\n");`,
  `const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");`,
  `rl.on("line", (line) => { const m = JSON.parse(line); if (m.id === undefined) return;`,
  `if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } } });`,
  `if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "find_note", title: "Find a note", inputSchema: { type: "object" } }] } });`,
  `send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } }) });`
].join(" ")

const audit = async (page: Page, info: Parameters<typeof expectLayout>[1], name: string, width: number) => {
  if (!process.env.LAYOUT_AUDIT) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, info, `${name}-${width}-${colorScheme}`)
  }
  await page.emulateMedia({ colorScheme: "light" })
}

for (const width of [1440, 390])
  test(`add a local program at ${width}px`, async ({ page }, info) => {
    test.skip(!sandbox.ok, "the sandbox can't run here")
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/mcp/new`)
    const name = `Notes ${width}`
    await page.getByLabel("Name", { exact: true }).fill(name)
    await page.getByLabel("Transport", { exact: true }).click()
    await page.getByRole("option", { name: /Local program/ }).click()
    await expect(page.getByLabel("Address", { exact: true })).toHaveCount(0)
    await page.getByLabel("Program", { exact: true }).fill("node")
    await page.getByLabel("Arguments", { exact: true }).fill(`-e\n${PROGRAM}`)
    await audit(page, info, "mcp-local-new", width)
    await page.getByRole("button", { name: "Add and check" }).click()
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
    await expect(page.getByRole("list", { name: "Tools" }).getByRole("checkbox", { name: /Find a note/ })).toBeChecked()
    // A program has variables, not a sign-in or a route.
    await expect(page.getByRole("heading", { name: "Environment" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Sign-in" })).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Network route" })).toHaveCount(0)
    await page.getByRole("button", { name: "Add variables" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Variable 1 name").fill("NOTES_TOKEN")
    await dialog.getByLabel("Variable 1 value").fill("synthetic-value")
    await dialog.getByRole("button", { name: "Save variables" }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText("NOTES_TOKEN")).toBeVisible()
    await page.getByRole("button", { name: "Show", exact: true }).click()
    await expect(page.locator("[data-mcp-program-output]")).toBeVisible()
    await audit(page, info, "mcp-local-page", width)
  })
