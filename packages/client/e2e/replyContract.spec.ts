// How an agent reply is given (spec/REPLY-CONTRACT.md §3.1): This chat → Tools has the choice
// "How the reply is given" (Send tool, the default; Plain answer; Either), kept over a reload for
// the chat it was set in. Under the send tool a character may pass: the chat shows the small
// line "Mira stays silent" as a version of the reply, and swiping it generates an actual reply.
// While "Replies must say" who's in the scene, Plain answer and Either are greyed out, with why.
// A scripted loopback provider (no_reply, then send_message); every card is made up. At 1440 and
// 390, light and dark, with the layout audit on This chat → Tools and the message list.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { showActions } from "./support/message.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

const ANSWER = "Mira sets down her cup and laughs."

/** Passes the first request of each chat, then sends the reply. */
const startProvider = async () => {
  const seen = new Map<string, number>()
  const send = (res: ServerResponse, name: string, args: object) => {
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "agent-small", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(
      [
        chunk({
          role: "assistant",
          tool_calls: [
            { index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }
          ]
        }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n"
      ].join("")
    )
  }
  const http = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "agent-small", object: "model" }] }))
    }
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: unknown }> }
      // The chat's own first message names it, so each test's chat is counted apart.
      const key = JSON.stringify(body.messages).match(/Evening at ([^.]+)\./)?.[1] ?? "?"
      const n = seen.get(key) ?? 0
      seen.set(key, n + 1)
      if (n === 0) send(res, "no_reply", {})
      else send(res, "send_message", { message: ANSWER })
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
  const response = await fetch(`${server().url}/library/import?name=Mira.json`, {
    method: "POST",
    headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
    body: JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Mira", description: "Mira keeps the harbour tavern." }
    })
  })
  expect(response.status).toBe(200)
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
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})

test.afterAll(async () => {
  await provider.stop()
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

/** A 1:1 chat with Mira, and the user's first message. */
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
        first: { _tag: "Send", content: `Evening at ${label}.`, speakerEntityId: null }
      })
      return started.chat.id
    })
  )

const castOf = (chatId: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: chatId as never })
      return yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })
    })
  )

const PANEL = '[role="tabpanel"][aria-label="This chat"]'

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`how the reply is given, and a silent reply swiped, at ${width} ${colorScheme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), colorScheme)
      const chatId = await chatWithMira(`${width} ${colorScheme}`)
      const other = await chatWithMira(`${width} ${colorScheme} other`)
      await page.goto(`${server().url}/chats/${chatId}`)
      let settings = await openPanel(page, "This chat")
      const contract = () => settings.getByRole("radiogroup", { name: "How the reply is given" })
      // Only with Tools on.
      await expect(contract()).toHaveCount(0)
      const tools = settings.getByRole("switch", { name: "Tools", exact: true })
      await tools.scrollIntoViewIfNeeded()
      await tools.click()
      const sendTool = contract().getByRole("radio", { name: /^Send tool/ })
      await expect(sendTool).toBeChecked()
      const plain = contract().getByRole("radio", { name: /^Plain answer/ })
      await plain.scrollIntoViewIfNeeded()
      await plain.click()
      await expect(plain).toBeChecked()
      await expect.poll(async () => (await castOf(chatId)).outputContract).toBe("final_text")
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `reply-contract-${width}-${colorScheme}`, { scope: PANEL })

      await page.reload()
      settings = await openPanel(page, "This chat")
      await expect(contract().getByRole("radio", { name: /^Plain answer/ })).toBeChecked()
      expect((await castOf(other)).outputContract).toBeUndefined()

      // Back to the send tool; the next reply passes.
      await contract()
        .getByRole("radio", { name: /^Send tool/ })
        .scrollIntoViewIfNeeded()
      await contract()
        .getByRole("radio", { name: /^Send tool/ })
        .click()
      await expect.poll(async () => (await castOf(chatId)).outputContract).toBe("send_message")
      if (width === 390) await closePanel(page)
      await page.getByRole("button", { name: "Mira replies" }).click()
      const reply = page.getByRole("article").filter({ hasText: "Mira stays silent" })
      await expect(reply).toBeVisible()
      await expect(reply.locator("[data-silent]")).toHaveText("Mira stays silent")
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `silent-line-${width}-${colorScheme}`, { scope: '[data-testid="messages"]' })

      // Swiping the silent line asks for an actual reply.
      // On a phone a tap on the line shows the message's actions, as on any message.
      if (width === 390) await reply.locator("[data-silent]").click()
      else await showActions(reply)
      await reply.getByRole("button", { name: "Generate another version" }).click()
      const answered = page.getByRole("article").filter({ hasText: ANSWER })
      await expect(answered).toBeVisible()
      await expect(answered.locator("[data-silent]")).toHaveCount(0)
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `silent-swiped-${width}-${colorScheme}`, { scope: '[data-testid="messages"]' })

      // While every reply must say who's in the scene, the send tool is the only way, and the
      // other two say why.
      settings = await openPanel(page, "This chat")
      const must = settings.getByRole("radiogroup", { name: "Who's in the scene" }).getByRole("radio", {
        name: /^Replies must say/
      })
      await must.scrollIntoViewIfNeeded()
      await must.click()
      await expect.poll(async () => (await castOf(chatId)).sendPresence).toBe("required")
      await expect(contract().getByRole("radio", { name: /^Send tool/ })).toBeChecked()
      await expect(contract().getByRole("radio", { name: /^Plain answer/ })).toBeDisabled()
      await expect(contract().getByRole("radio", { name: /^Either/ })).toBeDisabled()
      await expect(settings.getByText("Send tool only, while replies must say who's in the scene.")).toBeVisible()
      if (width === 1440) {
        await contract().getByText("Plain answer", { exact: true }).hover()
        await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
          "they say it when they send the reply"
        )
      }
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `reply-contract-forced-${width}-${colorScheme}`, { scope: PANEL })
    })
