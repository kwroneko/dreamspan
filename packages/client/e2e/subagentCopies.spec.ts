// Subagents that work on files (spec/SUBAGENTS.md SA6, §3.3) in the browser: a workshop reply
// starts a `code` subagent in its own copy of the working folder; the subagent's row says where
// its copy is, Open folder shows the copy in Files with the file it wrote, and Changes lists the
// kept copy and its file under its handle. The type editor offers where a type works. Layout
// audit at 1440 and 390, light and dark. A scripted loopback provider and synthetic text only;
// copies are made in the command sandbox, so the test needs it.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)
const ANSWER = "The subagent added notes in its copy."

interface Body {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>
}

/** The reply runs a command that makes a folder, then starts a code subagent in a copy of it; the subagent writes one file. */
const startProvider = async () => {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "copies",
      object: "chat.completion.chunk",
      model: "workshop-small",
      choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`
  const send = (res: ServerResponse, parts: ReadonlyArray<string>) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(parts.join("") + "data: [DONE]\n\n")
  }
  const call = (res: ServerResponse, id: string, name: string, args: object) =>
    send(res, [
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }),
      chunk({}, "tool_calls")
    ])
  const text = (res: ServerResponse, value: string) =>
    send(res, [chunk({ role: "assistant", content: value }), chunk({}, "stop")])
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "workshop-small", object: "model" }] }))
    }
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const body = JSON.parse(raw) as Body
      const child = JSON.stringify(body.messages[0]?.content ?? "").includes("You are a subagent")
      const from = body.messages.findLastIndex((m) => m.role === "user")
      const done = body.messages.slice(Math.max(0, from)).filter((m) => m.role === "tool").length
      if (child)
        return done === 0
          ? call(res, "child_write", "write_file", { path: "notes.md", content: "Synthetic notes.\n" })
          : text(res, "Wrote notes.md in my copy.")
      if (!JSON.stringify(body.messages).includes("Draft a chapter")) return text(res, "Ready.")
      if (done === 0)
        return call(res, "call_setup", "bash", {
          command: "mkdir -p chapter && echo text > chapter/one.md && cd chapter"
        })
      if (done === 1)
        return call(res, "call_agent", "agent", {
          type: "code",
          task: "Add notes.md with notes on the chapter.",
          name: "notes",
          copy: true
        })
      return text(res, ANSWER)
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

let provider: Awaited<ReturnType<typeof startProvider>>

test.beforeAll(async () => {
  provider = await startProvider()
  await admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic copies",
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
  test(`a code subagent's copy: its row, Open folder and Changes at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const workshop = await admin((api) => api.CreateWorkshop({ title: `Copies ${width}` }))
    await page.goto(`${server().url}/chats/${workshop.id}`)
    await expect(page.getByTestId("composer")).toBeVisible()
    await page.getByLabel("Message", { exact: true }).fill("Draft a chapter, with notes.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    const reply = page.getByRole("article").filter({ hasText: ANSWER }).last()
    await expect(reply).toBeVisible({ timeout: 90_000 })

    // The row: its copy, kept with its change, and Open folder. A finished reply's steps fold;
    // its header badge opens them (once the fold has settled).
    const row = reply.locator('[data-subagent="code-1"]')
    const badge = reply.locator("[data-steps-badge]")
    await expect(async () => {
      if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
      await expect(row).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await expect(row).toContainText("Work on files")
    const copy = row.locator('[data-subagent-copy="kept"]')
    await expect(copy).toContainText(/Its copy: \/files\/\.subagents\/code-[a-z0-9]{6}/)
    const path = /\/files\/\.subagents\/code-[a-z0-9]{6}/.exec((await copy.textContent()) ?? "")![0]
    await audit(page, info, `subagent-copy-row-${width}`, "article:last-of-type")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    // Changes: the kept copy and the file it wrote, under its handle.
    const changes = await openPanel(page, "Changes")
    const kept = changes.locator('[data-effect-kind="subagent.copy"]').first()
    await expect(kept).toContainText(`code-1: Kept its copy of /files/chapter at ${path}`)
    await expect(kept.getByText("Kept", { exact: true })).toBeVisible()
    await expect(changes.locator('[data-effect-kind="file.create"]').first()).toContainText(
      `code-1: Created ${path}/notes.md`
    )
    await audit(
      page,
      info,
      `subagent-copy-changes-${width}`,
      width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
    )
    if (width === 390) await page.keyboard.press("Escape")

    // Open folder: the copy in Files, with the file it wrote and the folder it copied.
    await row.getByRole("link", { name: "Open folder" }).click()
    await expect(page).toHaveURL(new RegExp(`/files\\?path=${encodeURIComponent(path).replace(/\./g, "\\.")}`))
    await expect(page.getByText("notes.md", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("one.md", { exact: true }).first()).toBeVisible()
    await audit(page, info, `subagent-copy-files-${width}`)
  })

test("the type editor says where a type works", async ({ page }, info) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(`${server().url}/settings/assistant-tools`)
    const code = page.locator('[data-subagent-type="code"]')
    await expect(code).toBeVisible()
    await code.getByRole("button", { name: "Edit" }).click()
    const editor = page.locator('[data-subagent-type-editor="code"]')
    const works = editor.getByRole("group", { name: "Works in" })
    await expect(works.getByRole("button", { name: "Your folder" })).toHaveAttribute("aria-pressed", "true")
    await works.getByRole("button", { name: "Its own copy" }).click()
    await expect(works.getByRole("button", { name: "Its own copy" })).toHaveAttribute("aria-pressed", "true")
    await audit(page, info, `subagent-type-folder-${width}`, '[data-subagent-type-editor="code"]')
    await editor.getByRole("button", { name: "Save" }).click()
    await expect(editor).toHaveCount(0)
    const saved = await admin((api) => api.GetSubagentTypes({}))
    expect(saved.types.find((t) => t.id === "code")?.isolation).toBe("copy")
    // Back as it came, for the next width.
    await page.locator('[data-subagent-type="code"]').getByRole("button", { name: "Edit" }).click()
    await page.locator('[data-subagent-type-editor="code"]').getByRole("button", { name: "Restore" }).click()
    await expect(page.locator('[data-subagent-type-editor="code"]')).toHaveCount(0)
  }
})
