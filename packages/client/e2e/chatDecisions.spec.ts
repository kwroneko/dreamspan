// This chat's Decisions setting (spec/AGENTIC.md §7): a decision a connection has on can be
// turned off for one chat. Off, the composer names Auto's pick again, a send asks the decision
// model nothing, and the reply's request view says the decision was off and what decided
// instead; it survives a reload, another chat keeps asking, and turning it back on asks again.
// With no decision on anywhere, the section isn't shown. At 1440 and 390, light and dark, with
// the layout audit on the section and its hover. A fake decision endpoint and a fake chat model
// on loopback; every card is made up.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout, layoutAudit } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextChip } from "./support/strip.ts"

const server = serverPerFile({ ...withAdmin, DECISION_TIMEOUT_MS: "60000" })
const shots = process.env["CHATDECISIONS_SHOTS"]
let cookie: string
let provider: FakeProvider
let decide: Server
const asked: Array<unknown> = []
let decisionConnection = ""

const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

/** Ash speaks next, whenever Ash is a candidate (Auto never picks Ash: talkativeness 0). */
const answer = (questions: Record<string, { criteria: Record<string, string> }>) => {
  const criteria = questions["next"]?.criteria ?? {}
  const choice = Object.keys(criteria).find((key) => criteria[key] === "Ash speaks next.") ?? "c0"
  return { next: { choice, probabilities: { [choice]: 0.91 }, confidence: 0.91 } }
}

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider({ reply: "*nods* The tide is turning." })
  decide = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const body = JSON.parse(raw) as { questions: Record<string, { criteria: Record<string, string> }> }
      asked.push(body)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: answer(body.questions),
          usage: { input_tokens: 320, output_tokens: 1, cost: 0.0000134 }
        })
      )
    })
  })
  await new Promise<void>((resolve) => decide.listen(0, "127.0.0.1", resolve))
  const decideUrl = `http://127.0.0.1:${(decide.address() as AddressInfo).port}`
  for (const [name, talkativeness] of Object.entries({ Mira: 1, Wren: 1, Ash: 0, Quill: 1 })) {
    const response = await fetch(`${server().url}/library/import?name=${name}.json`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name, description: `${name} drinks at the harbour tavern.`, extensions: { talkativeness } }
      })
    })
    expect(response.status).toBe(200)
  }
  decisionConnection = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-chatdecisions-chat-0042"
      })
      yield* api.RefreshModels({ connectionId: chat.id })
      const model = (yield* api.ListModels({ connectionId: chat.id, includeHidden: false })).find(
        (m) => m.key === "fake-small"
      )!
      yield* api.SetGenerationDefaults({ defaults: { model: { connection: chat.id, model: model.id }, preset: null } })
      const connection = yield* api.CreateConnection({
        kind: "system-one",
        settings: {
          name: "Jev",
          baseUrl: `${decideUrl}/decide`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-chatdecisions-decide-0042"
      })
      const jev = yield* api.AddUserModel({ connectionId: connection.id, key: "typesafe/jev-1.13", overrides: {} })
      yield* api.SetDecisionSettings({ connectionId: connection.id, model: jev.id, points: {} })
      return connection.id
    })
  )
})

test.afterAll(async () => {
  await provider.stop()
  await new Promise((resolve) => decide.close(resolve))
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

/** A group chat of Mira, Wren, Ash and Quill, played as Ana, one reply a send. */
const groupChat = () =>
  admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const id = (name: string) => cards.find((card) => card.name === name)!.entityId as EntityId
      const ana =
        cards.find((card) => card.name === "Ana")?.entityId ??
        (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      yield* api.SetPersona({ entityId: ana, persona: true })
      const started = yield* api.StartChat({
        cards: ["Mira", "Wren", "Ash", "Quill"].map(id),
        persona: ana,
        greeting: null,
        greeters: [],
        first: { _tag: "Send", content: "*I shake the rain off my coat.* Evening, all.", speakerEntityId: null }
      })
      yield* api.ChangeCast({ chatId: started.chat.id, slotId: null, change: { _tag: "ReplySingle", on: true } })
      return started.chat.id
    })
  )

const setPoint = (on: boolean) =>
  admin((api) =>
    Effect.gen(function* () {
      const [model] = yield* api.ListModels({ connectionId: decisionConnection as never, includeHidden: false })
      yield* api.SetDecisionSettings({
        connectionId: decisionConnection as never,
        model: model!.id,
        points: { next: { on, threshold: 0.5 } }
      })
    })
  )

const lastVersion = (chatId: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: chatId as never })
      const window = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: chat.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 1
      })
      return window.entries.at(-1)!.version
    })
  )

const tooltip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"]')
const PLANNED = /Mira|Wren|Quill/
const PANEL = '[role="tabpanel"][aria-label="This chat"]'

const send = async (page: Page, text: string, messages: number) => {
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.keyboard.press("Enter")
  await expect(page.locator("article[data-slot]")).toHaveCount(messages)
  await expect(page.locator("article[data-slot]").last().getByText("The tide is turning.")).toBeVisible()
}

test("with no decision on for any connection, a chat shows no Decisions setting", async ({ page }) => {
  await setPoint(false)
  const chatId = await groupChat()
  await page.goto(`${server().url}/chats/${chatId}`)
  const settings = await openPanel(page, "This chat")
  await expect(settings.getByRole("group", { name: "Who replies" })).toBeVisible()
  await expect(settings.getByRole("group", { name: "Decisions" })).toHaveCount(0)
})

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`a decision turned off for one chat, at ${width} ${colorScheme}`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await setPoint(true)
      const chatId = await groupChat()
      const other = await groupChat()
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(nextChip(page)).toContainText("chosen when you send")

      let settings = await openPanel(page, "This chat")
      const section = () => settings.getByRole("group", { name: "Decisions" })
      const point = () => section().getByRole("switch", { name: "Who replies next" })
      await expect(point()).toBeChecked()
      // Only what a connection has on is listed.
      await expect(section().getByRole("switch")).toHaveCount(1)
      await point().scrollIntoViewIfNeeded()
      if (width === 1440) {
        await point().hover()
        await expect(tooltip(page)).toContainText("Click to stop asking in this chat.")
        const violations = await layoutAudit(page, { scope: '[data-layout-overlay="Tooltip floats above the page"]' })
        expect.soft(violations, "the switch's hover").toEqual([])
      }
      await point().click()
      await expect(point()).not.toBeChecked()
      await expect(section()).toContainText("Off for this chat: nothing is sent for it here.")
      await expect(section()).toContainText("The chat's reply order, or your own pick, chose who replied.")
      await page.mouse.move(0, 0)
      if (shots) await settings.screenshot({ path: `${shots}/setting-off-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `chat-decisions-off-${width}-${colorScheme}`, { scope: PANEL })

      // The composer follows at once: Auto's pick is named again.
      if (width === 390) await closePanel(page)
      await expect(nextChip(page)).not.toContainText("chosen when you send")
      await expect(nextChip(page)).toContainText(PLANNED)
      const before = asked.length
      await send(page, "Anyone seen the Gull?", 3)
      expect(asked.length).toBe(before)
      const reply = await lastVersion(chatId)
      expect(reply.speakerPick).toBeUndefined()

      // A reload keeps it; the other chat still asks.
      await page.reload()
      settings = await openPanel(page, "This chat")
      await expect(point()).not.toBeChecked()

      // The reply's request view says the decision was off, and what decided.
      await page.goto(`${server().url}/chats/${chatId}/context/${reply.id}`)
      const off = page.locator('[data-decision-off="next"]')
      await expect(off).toHaveText(
        "Off in this chat, so the decision model wasn't asked. The chat's reply order, or your own pick, chose who replied."
      )
      if (shots) await page.screenshot({ path: `${shots}/inspector-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `chat-decisions-inspector-${width}-${colorScheme}`)

      await page.goto(`${server().url}/chats/${other}`)
      await expect(nextChip(page)).toContainText("chosen when you send")
      await send(page, "And here?", 3)
      expect(asked.length).toBe(before + 1)
      expect((await lastVersion(other)).speakerPick?.by).toBe("decision")

      // Back on in the first chat: it asks again.
      await page.goto(`${server().url}/chats/${chatId}`)
      settings = await openPanel(page, "This chat")
      await point().scrollIntoViewIfNeeded()
      await point().click()
      await expect(point()).toBeChecked()
      if (shots) await settings.screenshot({ path: `${shots}/setting-on-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `chat-decisions-on-${width}-${colorScheme}`, { scope: PANEL })
      if (width === 390) await closePanel(page)
      await expect(nextChip(page)).toContainText("chosen when you send")
      await send(page, "Who's for another round?", 5)
      expect(asked.length).toBe(before + 2)
      expect((await lastVersion(chatId)).speakerPick?.by).toBe("decision")
    })
