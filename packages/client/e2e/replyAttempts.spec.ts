// The reply contract's records in the browser (spec/REPLY-CONTRACT.md milestones 2 to 4): a model
// that only ever writes text (copying the chat's speaker label once) fails after three asks. With
// the refusal judge chosen and "Also check replies that were never sent" turned on in Settings →
// Chats, the judge reads that text and the failed reply says it was found a refusal; the run
// inspector lists the four attempts and why each wasn't the reply; Settings → Models → Reply
// behaviour counts the reply as never sent, each figure explained on hover. A scripted loopback provider; every card is made up.
// At 1440 and 390, light and dark, with the layout audit on each surface.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

/** Text, never a send; the judge's question gets REFUSED. The second answer copies a speaker label. */
const startProvider = async () => {
  const seen = new Map<string, number>()
  const http = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "agent-small", object: "model" }] }))
    }
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const text = JSON.stringify((JSON.parse(raw) as { messages: unknown }).messages)
      const key = text.match(/Night at ([^.]+)\./)?.[1] ?? "?"
      const judge = text.includes("You check whether")
      const n = judge ? 0 : (seen.get(key) ?? 0)
      if (!judge) seen.set(key, n + 1)
      const content = judge ? "REFUSED" : n === 1 ? "Mira: I would rather not." : "I won't write this scene."
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "agent-small", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end([chunk({ role: "assistant", content }), chunk({}, "stop"), "data: [DONE]\n\n"].join(""))
    })
  })
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    stop: () => new Promise<void>((done) => http.close(() => done()))
  }
}

let provider: Awaited<ReturnType<typeof startProvider>>

test.beforeAll(async () => {
  provider = await startProvider()
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic agent",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "agent-small", overrides: {} })
      const choice = { connection: connection.id, model: model.id }
      yield* api.SetGenerationDefaults({ defaults: { model: choice, preset: null } })
      yield* api.ChangeGenerationDefaults({ change: { judge: choice } })
      yield* api.CreateCard({ label: "Mira", name: "Mira" })
    })
  )
})

test.afterAll(async () => {
  await provider.stop()
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

const chatWithMira = (label: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const mira = cards.find((card) => card.name === "Mira")!.entityId as EntityId
      const ana =
        cards.find((card) => card.name === "Ana")?.entityId ??
        (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      yield* api.SetPersona({ entityId: ana, persona: true })
      const started = yield* api.StartChat({
        cards: [mira],
        persona: ana,
        greeting: null,
        greeters: [],
        first: { _tag: "Send", content: `Night at ${label}.`, speakerEntityId: null }
      })
      return started.chat.id
    })
  )

const lastVersion = (chatId: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const path = yield* api.ReadPath({
        chatId: chatId as never,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 5
      })
      return path.entries.at(-1)!.version
    })
  )

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`a reply never sent: the ending check, its attempts and the per-model counts, at ${width} ${colorScheme}`, async ({
      page
    }, info) => {
      test.setTimeout(150_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), colorScheme)

      // The ending check is off until turned on, beside the judge.
      await page.goto(`${server().url}/settings/chats`)
      const check = page.getByRole("switch", { name: "Also check replies that were never sent" })
      await expect(check).toBeEnabled()
      if (!(await check.isChecked())) await check.click()
      await expect(check).toBeChecked()
      await expect.poll(async () => (await admin((api) => api.GetGenerationDefaults())).judgeEndings).toBe(true)
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `ending-check-${width}-${colorScheme}`)

      const chatId = await chatWithMira(`${width} ${colorScheme}`)
      await page.goto(`${server().url}/chats/${chatId}`)
      const settings = await openPanel(page, "This chat")
      const tools = settings.getByRole("switch", { name: "Tools", exact: true })
      await tools.scrollIntoViewIfNeeded()
      await tools.click()
      await expect(tools).toBeChecked()
      if (width === 390) await closePanel(page)
      await page.getByRole("button", { name: "Mira replies" }).click()
      const reply = page.getByRole("article").filter({ hasText: "The model didn't send a reply" })
      await expect(reply).toBeVisible()
      await expect(reply).toContainText("wrote text 4 times")
      await expect(reply.getByText("found it a refusal")).toBeVisible()
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `unsent-refused-${width}-${colorScheme}`, { scope: '[data-testid="messages"]' })

      // The run inspector: every attempt, and why each wasn't the reply.
      const version = await lastVersion(chatId)
      expect(version.mark).toBe("refused")
      await page.goto(`${server().url}/chats/${chatId}/context/${version.id}`)
      const attempts = page.getByRole("region", { name: "Reply attempts" })
      await expect(attempts).toContainText("Never sent, though the app asked 3 times.")
      const rows = attempts.getByRole("listitem")
      await expect(rows).toHaveCount(4)
      await expect(rows.nth(0)).toHaveText(/Wrote text without sending it/)
      await expect(rows.nth(1)).toHaveText(/Copied the chat's own markup/)
      await attempts.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `reply-attempts-${width}-${colorScheme}`, {
        scope: '[aria-label="Reply attempts"]'
      })

      // Settings → Models → Reply behaviour.
      await page.goto(`${server().url}/settings/model-behaviour`)
      const row = page.getByRole("listitem").filter({ hasText: "Synthetic agent" })
      await expect(row).toBeVisible()
      const figure = (label: string) =>
        row
          .locator("div")
          .filter({ has: page.getByText(label, { exact: true }) })
          .getByRole("definition")
      await expect(figure("Never sent")).toContainText("(100%)")
      await expect(figure("Stopped")).toHaveText("0 (0%)")
      // Each figure says what it counts on hover.
      await row.getByRole("button", { name: "About Stopped", exact: true }).hover()
      const explained = page.getByText(/Replies stopped before they were sent/)
      await expect(explained.last()).toBeVisible()
      await page.mouse.move(0, 0)
      await expect(explained).toHaveCount(1)
      await expectLayout(page, info, `model-behaviour-${width}-${colorScheme}`)
    })
