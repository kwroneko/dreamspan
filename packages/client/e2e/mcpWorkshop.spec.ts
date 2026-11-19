// MCP servers in workshops (spec/MCP.md M2, §13.1 Use it in, §13.3 the chip, §13.4 Changes) in the
// browser: the server's Use it in switches, its On / Off row in the workshop's chip, a call the
// model makes running without asking with its progress in the step's row, and its change in the
// step and the Changes tab, which can't be undone from the app, and the run inspector's server
// grouping and ledger line. Layout audit at both widths and in both themes. A local fake MCP
// server and a scripted loopback provider only.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeMcpServer, fakeTool, startFakeMcpServer } from "../../server/test/support/fakeMcpServer.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
let mcp: FakeMcpServer
let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

test.beforeAll(async () => {
  mcp = await startFakeMcpServer({
    tools: [fakeTool("lookup", { title: "Look up", annotations: { destructiveHint: true } })]
  })
  provider = await startWorkshopProvider({
    perTask: true,
    calls: [{ name: "mcp_archive_lookup", arguments: { text: "the lighthouse" } }]
  })
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic workshop",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      yield* api.CreateMcpConnection({
        settings: {
          name: "Archive",
          about: "Looks things up in the synthetic archive.",
          transport: "streamable-http",
          url: mcp.streamableUrl,
          timeoutS: 30
        }
      })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
  await mcp.close()
})

const audit = async (page: Page, info: Parameters<typeof expectLayout>[1], name: string, scope?: string) => {
  if (!process.env.LAYOUT_AUDIT) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, info, `${name}-${colorScheme}`, scope ? { scope } : undefined)
  }
  await page.emulateMedia({ colorScheme: "light" })
}

for (const width of [1440, 390])
  test(`a workshop uses an MCP server it turned on at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const [connection] = await admin((api) => api.ListMcpConnections())
    // Each run starts from the account default: off for workshops.
    await admin((api) => api.SetMcpUse({ connectionId: connection!.id, workshops: false, stories: false }))

    // Use it in: both switches off, each explained.
    await page.goto(`${server().url}/settings/mcp/${connection!.id}`)
    const uses = page.locator("[data-mcp-uses]")
    const workshops = uses.getByRole("switch", { name: "Workshops" })
    await expect(workshops).not.toBeChecked()
    await expect(uses.getByRole("switch", { name: "Stories" })).toHaveAccessibleDescription(
      /Each call sends what the model writes in it to 127\.0\.0\.1:\d+\./
    )
    await audit(page, info, `mcp-uses-${width}`)

    // A workshop: the server's row is Off by default; On here overrides it.
    const workshop = await admin((api) => api.CreateWorkshop({ title: `MCP ${width}` }))
    mcp.reset()
    await page.goto(`${server().url}/chats/${workshop.id}`)
    await expect(page.getByTestId("composer")).toBeVisible()
    const chip = nextReply(page).getByRole("button", { name: /^What the assistant may do: / })
    await chip.click()
    const popover = page.getByRole("dialog", { name: "What the assistant may do" })
    const row = popover.locator(`[data-capability-target="${connection!.id}"]`)
    await expect(row).toContainText("Archive")
    await expect(row.getByRole("button", { name: "Off", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(row.getByRole("button", { name: "Ask first" })).toHaveCount(0)
    await row.getByRole("button", { name: "On", exact: true }).click()
    await expect(row.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(row.getByRole("button", { name: "Use the default" })).toBeVisible()
    await audit(page, info, `mcp-chip-${width}`, '[role="dialog"]')
    await page.keyboard.press("Escape")
    // Nothing reached the server by turning it on.
    expect(mcp.requests()).toHaveLength(0)

    // The model calls it: it runs without asking, its progress shows in the step's row while it
    // runs, and the change can't be undone from the app.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    mcp.state.call = async (_name, _args, _signal, progress) => {
      await progress(1, 2, "Searching the shelves")
      await held
      return { content: [{ type: "text", text: "Found it." }] }
    }
    await page.getByLabel("Message", { exact: true }).fill("Look up the lighthouse.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    const running = page.getByRole("article").last()
    await expect(running.locator("[data-step-progress]")).toHaveText("Searching the shelves (50%)", {
      timeout: 30_000
    })
    await audit(page, info, `mcp-progress-${width}`, "article:last-of-type")
    release()
    mcp.state.call = null
    const reply = page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER }).last()
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await expect(reply.locator("[data-step-progress]")).toHaveCount(0)
    expect(mcp.methods()).toContain("tools/call")
    await expect(reply.locator("[data-approval]")).toHaveCount(0)
    const changes = await openPanel(page, "Changes")
    const effect = changes.locator('[data-effect-kind="mcp.call"]').first()
    await expect(effect).toContainText("Called Look up on Archive")
    await expect(effect.getByRole("button", { name: "Undo" })).toHaveCount(0)
    await expect(effect.getByText("Can’t be undone from the app")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await audit(
      page,
      info,
      `mcp-changes-${width}`,
      width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
    )

    // The run inspector groups the tool under its server and says where the call went.
    const versionId = await admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.GetChat({ chatId: workshop.id })
        const window = yield* api.ReadPath({
          chatId: workshop.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Around", slot: chat.activeLeafSlotId! },
          limit: 3
        })
        return window.entries.find((e) => e.slotId === chat.activeLeafSlotId)!.version.id
      })
    )
    await page.goto(`${server().url}/chats/${workshop.id}/context/${versionId}#run-steps`)
    const offered = page.getByRole("region", { name: "Tools offered" })
    const fromArchive = offered.getByRole("region", { name: "From Archive" })
    await expect(fromArchive).toBeVisible({ timeout: 30_000 })
    await expect(fromArchive.getByRole("heading", { level: 4 })).toHaveText(/^From Archive, listed .+/)
    await expect(fromArchive.getByRole("region", { name: "mcp_archive_lookup" })).toBeVisible()
    const steps = page.getByRole("region", { name: "Steps" })
    const sent = steps.getByRole("region", { name: "Sent to the server: mcp_archive_lookup" })
    await expect(sent.locator("[data-mcp-sent]")).toHaveText(
      /^Sent to 127\.0\.0\.1:\d+ \(Archive\) at .+ · .+ · .+ back$/
    )
    await expect(steps.getByRole("region", { name: "What the server returned" })).toContainText("Found it.")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await audit(page, info, `mcp-inspector-tools-${width}`, '[aria-label="Tools offered"]')
    await audit(page, info, `mcp-inspector-steps-${width}`, '[aria-label="Steps"]')
  })
