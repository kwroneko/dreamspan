// "Who replies next" (DESIGN §2.3, spec/AGENTIC.md §7): the decision connection's Decisions card
// has the point, off until turned on, with its explanation on hover; once on, the Next pill's hover
// says the decision model picks, a send's reply is written by the character it picked (Ash, whom
// Auto never picks here: talkativeness 0), the pill's hover then says so, and the run inspector
// shows "The decision model picked Ash (91%)". At 1440 and 390, light and dark, with the layout
// audit on the card and on the pill's hover. A fake decision endpoint and a fake chat model on
// loopback; every card is made up.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout, layoutAudit } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextChip } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
const shots = process.env["NEXTSPEAKER_SHOTS"]
let cookie: string
let provider: FakeProvider
let decide: Server
/** The decision requests received. */
const asked: Array<unknown> = []
let decisionConnection = ""

const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

/** Ash speaks next, whatever is said, as long as Ash is a candidate (else the first). */
const answer = (questions: Record<string, { criteria: Record<string, string> }>) => {
  const criteria = questions["next"]!.criteria
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
        apiKey: "sk-nextspeaker-chat-0042"
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
        apiKey: "sk-nextspeaker-decide-0042"
      })
      const jev = yield* api.AddUserModel({ connectionId: connection.id, key: "typesafe/jev-1.13", overrides: {} })
      // The model chosen, nothing turned on yet.
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

/** A group chat of Mira, Wren, Ash and Quill, played as Ana, one reply a send, with Ana's first line. */
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

const tooltip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"]')

/** The layout audit over the tooltip showing now, without moving the pointer off what it explains. */
const auditTooltip = async (page: Page, surface: string) => {
  const violations = await layoutAudit(page, { scope: '[data-layout-overlay="Tooltip floats above the page"]' })
  await test.info().attach(`${surface} measurements`, {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json"
  })
  expect.soft(violations, `${surface}: layout violations`).toEqual([])
}

test("the point is off by default, and its switch explains it on hover", async ({ page }) => {
  await setPoint(false)
  await page.goto(`${server().url}/settings/connections/${decisionConnection}`)
  const point = page.getByRole("switch", { name: "Who replies next" })
  await expect(point).toBeEnabled()
  await expect(point).not.toBeChecked()
  await expect(
    page.getByText("the decision model reads the last few messages and picks who speaks next", { exact: false })
  ).toBeVisible()
  await point.hover()
  await expect(tooltip(page)).toContainText("Click to ask about who replies next")
  await point.click()
  await expect(point).toBeChecked()
  await page.reload()
  await expect(page.getByRole("switch", { name: "Who replies next" })).toBeChecked()
})

test("off, nothing is sent and Auto picks", async ({ page }) => {
  await setPoint(false)
  const chatId = await groupChat()
  const before = asked.length
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(nextChip(page)).toBeEnabled()
  await nextChip(page).hover()
  await expect(tooltip(page)).toContainText("replies next")
  await expect(tooltip(page)).not.toContainText("decision model")
  await page.getByLabel("Message", { exact: true }).fill("Anyone seen the Gull?")
  await page.keyboard.press("Enter")
  await expect(page.locator("article[data-slot]")).toHaveCount(3)
  await expect(page.getByText("The tide is turning.")).toBeVisible()
  await expect(page.locator("article[data-slot]").last().locator("header").first()).not.toContainText("Ash")
  expect(asked.length).toBe(before)
})

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`on, the decision model picks who replies, at ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await setPoint(true)

      // The Decisions card, with the point on.
      await page.goto(`${server().url}/settings/connections/${decisionConnection}`)
      await expect(page.getByRole("switch", { name: "Who replies next" })).toBeChecked()
      const card = page.getByRole("heading", { name: "Decisions" })
      await card.evaluate((element) => element.scrollIntoView({ block: "start" }))
      if (shots)
        await page.screenshot({ path: `${shots}/decisions-${width}-${colorScheme}.png`, animations: "disabled" })
      await expectLayout(page, test.info(), `decisions-next-${width}-${colorScheme}`)

      const chatId = await groupChat()
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(nextChip(page)).toBeEnabled()
      await nextChip(page).hover()
      await expect(tooltip(page)).toContainText("The decision model picks who replies next; if it can't decide,")
      if (shots) await page.screenshot({ path: `${shots}/pill-before-${width}-${colorScheme}.png` })
      await auditTooltip(page, `pill-before-${width}-${colorScheme}`)

      const before = asked.length
      await page.getByLabel("Message", { exact: true }).fill("Anyone seen the Gull?")
      await page.keyboard.press("Enter")
      const reply = page.locator("article[data-slot]").nth(2)
      await expect(reply.getByText("The tide is turning.")).toBeVisible()
      await expect(reply.locator("header").first()).toContainText("Ash")
      expect(asked.length).toBe(before + 1)

      await nextChip(page).hover()
      await expect(tooltip(page)).toContainText("The decision model picked Ash for the last reply (91%).")
      if (shots) await page.screenshot({ path: `${shots}/pill-after-${width}-${colorScheme}.png` })
      await auditTooltip(page, `pill-after-${width}-${colorScheme}`)

      // The run inspector says who picked the speaker.
      const versionId = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.GetChat({ chatId: chatId as never })
          const window = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: chat.activeLeafSlotId,
            range: { _tag: "Bottom" },
            limit: 1
          })
          return window.entries.at(-1)!.version.id
        })
      )
      await page.goto(`${server().url}/chats/${chatId}/context/${versionId}`)
      await expect(page.getByText("The decision model picked Ash (91%)")).toBeVisible()
      if (shots) await page.screenshot({ path: `${shots}/inspector-${width}-${colorScheme}.png` })
    })
