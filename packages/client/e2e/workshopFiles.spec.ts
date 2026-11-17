// Files and commands in workshops (spec/FILES-AND-ENVIRONMENT.md §5, §7, milestone 1) in the
// browser: the chip's Change your files / Run commands / Internet from commands rows, the
// internet switch turned off for this workshop, and a run that writes a file, reads it back and
// runs a command on it, with its changes in the Changes tab. Layout audit at both widths and in
// both themes. A scripted loopback provider and synthetic text only.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { unquoteToolData } from "../../server/test/support/toolData.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)
const PLAN = "The lighthouse keeper climbs the stairs."

test.beforeAll(async () => {
  provider = await startWorkshopProvider({
    perTask: true,
    calls: [
      { name: "write_file", arguments: { path: "notes/plan.md", content: `${PLAN}\n` } },
      { name: "read_file", arguments: { path: "notes/plan.md" } },
      {
        name: "bash",
        arguments: {
          command: "wc -w < notes/plan.md; curl -sS -m 5 -o /dev/null https://example.com || echo no-internet"
        }
      }
    ],
    // The answer quotes what the run read back and what the command printed.
    answer: (body) => {
      const results = body.messages
        .filter((m) => m.role === "tool")
        .map((m) => unquoteToolData(String(m.content ?? "")))
      const read = results.some((r) => r.includes(PLAN)) ? "Read back the plan" : "The plan was missing"
      const words = /exit: 0[\s\S]*\b6\b/.test(results.at(-1) ?? "") ? "six words" : "no count"
      const last = results.at(-1) ?? ""
      const offline =
        last.includes("Internet from commands is off") && last.includes("no-internet") ? "offline" : "online"
      return `${read}: ${words}, ${offline}.`
    }
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
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
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
  test(`a workshop writes a file, reads it back and runs a command at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const workshop = await admin((api) => api.CreateWorkshop({ title: `Files ${width}` }))
    await page.goto(`${server().url}/chats/${workshop.id}`)
    await expect(page.getByTestId("composer")).toBeVisible()

    // The chip: files and commands are allowed by default; the internet for commands is its own switch.
    await nextReply(page)
      .getByRole("button", { name: /^What the assistant may do: / })
      .click()
    const popover = page.getByRole("dialog", { name: "What the assistant may do" })
    await expect(popover.locator('[data-capability="files"]')).toContainText("Change your files")
    const commands = popover.locator('[data-capability="commands"]')
    await expect(commands).toContainText("Run commands")
    await expect(commands).not.toContainText("Not available here")
    const network = popover.locator('[data-capability="commands.network"]')
    await expect(network).toContainText("Internet from commands")
    await expect(network.getByRole("button", { name: "Ask first" })).toHaveCount(0)
    await network.getByRole("button", { name: "Off", exact: true }).click()
    await expect(network.getByRole("button", { name: "Off", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(network.getByRole("button", { name: "Use the default" })).toBeVisible()
    await audit(page, info, `files-chip-${width}`, '[role="dialog"]')
    await page.keyboard.press("Escape")

    // The run: it writes the plan, reads it back and counts its words offline.
    await page.getByLabel("Message", { exact: true }).fill("Keep a plan in notes/plan.md.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    const reply = page.getByRole("article").filter({ hasText: "Read back the plan: six words, offline." }).last()
    await expect(reply).toBeVisible({ timeout: 60_000 })
    const changes = await openPanel(page, "Changes")
    const created = changes.locator('[data-effect-kind="file.create"]').first()
    await expect(created).toContainText("Created /files/notes/plan.md")
    await expect(created.getByRole("button", { name: "Undo" })).toBeVisible()
    const ran = changes.locator('[data-effect-kind="shell.run"]').first()
    await expect(ran).toContainText("Ran `wc -w")
    await expect(ran.getByRole("button", { name: "Undo" })).toHaveCount(0)
    await expect(ran.getByText("Can’t be undone from the app")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await audit(
      page,
      info,
      `files-changes-${width}`,
      width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
    )

    // Undo removes the file it made.
    await created.getByRole("button", { name: "Undo" }).click()
    await expect(created).toContainText("Undone")
  })
