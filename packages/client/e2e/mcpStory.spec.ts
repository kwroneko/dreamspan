// MCP servers in story chats (spec/MCP.md M3, §13.2) in the browser: This chat → Tools → From MCP
// servers lists the user's servers, each on or off for this branch over the account's Stories
// switch, with Reset while the branch has its own choice; a server with no allowed tools is shown
// disabled. Turning one on sends nothing to it. Layout audit at both widths and in both themes. A
// local fake MCP server only.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import type { McpConnectionId } from "@rp/shared/mcp.ts"
import { stCardV2 } from "../../server/test/formats/support.ts"
import { type FakeMcpServer, fakeTool, startFakeMcpServer } from "../../server/test/support/fakeMcpServer.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let mcp: FakeMcpServer
let archive: McpConnectionId
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

test.beforeAll(async () => {
  mcp = await startFakeMcpServer({ tools: [fakeTool("lookup", { annotations: { destructiveHint: true } })] })
  await admin((api) =>
    Effect.gen(function* () {
      const settings = { about: "", transport: "streamable-http" as const, url: mcp.streamableUrl, timeoutS: 30 }
      archive = (yield* api.CreateMcpConnection({ settings: { ...settings, name: "Archive" } })).connection.id
      // A second server whose only tool isn't allowed: listed, but it can't be turned on.
      const empty = (yield* api.CreateMcpConnection({ settings: { ...settings, name: "Empty" } })).connection
      yield* api.SetMcpUse({
        connectionId: empty.id,
        tools: { choices: { lookup: { on: false } }, reviewedRevision: empty.catalogRevision }
      })
    })
  )
})
test.afterAll(async () => {
  await mcp.close()
})

const audit = async (page: Page, info: Parameters<typeof expectLayout>[1], name: string) => {
  if (!process.env.LAYOUT_AUDIT) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, info, `${name}-${colorScheme}`, { scope: '[role="tabpanel"][aria-label="This chat"]' })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

for (const width of [1440, 390])
  test(`a story branch turns an MCP server on and back to the account's at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await admin((api) => api.SetMcpUse({ connectionId: archive, stories: false }))
    const imported = await page.request.post(`${server().url}/library/import?name=synthetic.json`, {
      data: Buffer.from(JSON.stringify(stCardV2())),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(imported.status()).toBe(200)
    const entityId = (await imported.json()).library.ref.entityId as EntityId
    const { chat, slotId } = await admin((api) =>
      Effect.map(
        api.StartChat({
          cards: [entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "The lamp is lit.", speakerEntityId: null }
        }),
        (r) => ({ chat: r.chat, slotId: r.entry.slotId })
      )
    )
    const read = () => admin((api) => api.GetCast({ chatId: chat.id, slotId, forkId: chat.currentForkId }))
    mcp.reset()
    await page.goto(`${server().url}/chats/${chat.id}`)
    const settings = await openPanel(page, "This chat")
    await settings.getByRole("switch", { name: "Tools", exact: true }).click()
    const servers = settings.locator("[data-mcp-servers]")
    const box = servers.getByRole("checkbox", { name: /^Archive/ })
    await expect(box).not.toBeChecked()
    await expect(servers).toContainText("1 tool")
    await expect(box).toHaveAccessibleDescription(
      /Click to let replies on this branch use Archive's tools\. Each call sends what the model writes in it to 127\.0\.0\.1:\d+\./
    )
    const empty = servers.getByRole("checkbox", { name: /^Empty/ })
    await expect(empty).toBeDisabled()
    await expect(servers).toContainText("None of its tools are allowed.")
    await expect(servers.getByRole("button", { name: "Reset" })).toHaveCount(0)
    await audit(page, info, `mcp-story-default-${width}`)

    // On for this branch, over the account's off.
    await box.click()
    await expect(box).toBeChecked()
    await expect.poll(async () => (await read()).agentMcp?.[archive]).toBe(true)
    const reset = servers.getByRole("button", { name: "Reset" })
    await expect(reset).toHaveAccessibleDescription("Goes back to your account setting: off.")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await audit(page, info, `mcp-story-chosen-${width}`)

    // Reset follows the account again.
    await reset.click()
    await expect(box).not.toBeChecked()
    await expect.poll(async () => (await read()).agentMcp).toBeUndefined()
    await expect(reset).toHaveCount(0)
    // Nothing reached the server by choosing.
    expect(mcp.requests()).toHaveLength(0)
  })
