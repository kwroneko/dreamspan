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
import { nextChip, nextReply } from "./support/strip.ts"

// Decisions wait a minute here, not "Who replies next"'s 3 s: the tests hold one while they look
// at the page, so a slow screenshot or audit can't let Auto's pick in. The real deadline has its
// own test (server test/nextSpeaker.test.ts, "no answer within the deadline").
const server = serverPerFile({ ...withAdmin, DECISION_TIMEOUT_MS: "60000" })
const shots = process.env["NEXTSPEAKER_SHOTS"]
let cookie: string
let provider: FakeProvider
let decide: Server
/** The decision requests received. */
const asked: Array<unknown> = []
let decisionConnection = ""
/** While true, decisions wait in `heldDecisions` until `releaseDecisions`. */
let holdDecisions = false
const heldDecisions: Array<() => void> = []
const releaseDecisions = () => {
  holdDecisions = false
  for (const answerNow of heldDecisions.splice(0)) answerNow()
}

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
      const answerNow = () => {
        if (response.destroyed) return
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            model: "typesafe/jev-1.13-20260917",
            answers: answer(body.questions),
            usage: { input_tokens: 320, output_tokens: 1, cost: 0.0000134 }
          })
        )
      }
      if (holdDecisions) heldDecisions.push(answerNow)
      else answerNow()
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

test.afterEach(() => {
  releaseDecisions()
  provider.release()
})

test.afterAll(async () => {
  await provider.stop()
  await new Promise((resolve) => decide.close(resolve))
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

/**
 * A group chat of Mira, Wren, Ash and Quill, played as Ana, with Ana's first line: one reply a
 * send, or (`single` false) a round of everyone Auto has reply, in turn.
 */
const groupChat = (single = true) =>
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
      if (single)
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

/** What a reply's header says while the decision model chooses who writes it. */
const CHOOSING = "Choosing who replies…"
const PLANNED = /Mira|Wren|Quill/

/** From now on, records every name each message's header shows, in order, by slot. */
const recordSpeakers = (page: Page) =>
  page.evaluate(() => {
    const seen: Record<string, Array<string>> = {}
    ;(window as unknown as { seenSpeakers: typeof seen }).seenSpeakers = seen
    const look = () => {
      for (const article of document.querySelectorAll("article[data-slot]")) {
        const label = article.querySelector("header > span")?.textContent?.trim() ?? ""
        const list = (seen[article.getAttribute("data-slot")!] ??= [])
        if (list.at(-1) !== label) list.push(label)
      }
    }
    look()
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true })
  })

const seenSpeakers = (page: Page) =>
  page.evaluate(() => (window as unknown as { seenSpeakers: Record<string, Array<string>> }).seenSpeakers)

const strip = (page: Page) => page.getByRole("group", { name: "This round" })

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
  // Off, the pill names Auto's pick, as always.
  await expect(nextChip(page)).toContainText(PLANNED)
  await expect(nextChip(page)).not.toContainText("chosen when you send")
  await nextChip(page).hover()
  await expect(tooltip(page)).toContainText("replies next")
  await expect(tooltip(page)).not.toContainText("decision model")
  await recordSpeakers(page)
  await page.getByLabel("Message", { exact: true }).fill("Anyone seen the Gull?")
  await page.keyboard.press("Enter")
  await expect(page.locator("article[data-slot]")).toHaveCount(3)
  await expect(page.getByText("The tide is turning.")).toBeVisible()
  const reply = page.locator("article[data-slot]").last()
  await expect(reply.locator("header").first()).not.toContainText("Ash")
  expect(asked.length).toBe(before)
  // Nothing to choose: the reply names Auto's pick from the start.
  const seen = (await seenSpeakers(page))[(await reply.getAttribute("data-slot"))!]!
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatch(PLANNED)
})

test("a queued round names only its own replies, including after reopening", async ({ page }) => {
  await setPoint(true)
  const chatId = await groupChat(false)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(nextChip(page)).toBeEnabled()
  provider.hold()
  await page.getByLabel("Message", { exact: true }).fill("Hold the current reply.")
  await page.getByRole("button", { name: "Send as Ana", exact: true }).click()
  await expect(page.locator("article[data-slot]").nth(2).locator("header").first()).toContainText("Ash")
  await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: chatId as never })
      const cards = yield* api.ListCards()
      const id = (name: string) => cards.find((card) => card.name === name)!.entityId as EntityId
      yield* api.Generate({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        speakerEntityId: id("Mira"),
        autoPick: true
      })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: "Start this round after the earlier queued reply.",
        replySpeakerEntityId: id("Wren"),
        round: [id("Ash"), id("Quill")],
        autoPick: true
      })
    })
  )
  await expect(strip(page)).toContainText("Then 2 more")
  await expect(strip(page)).not.toContainText("so far.")
  await page.reload()
  await expect(strip(page)).toContainText("Then 2 more")
  await expect(strip(page)).not.toContainText("so far.")
  // The older queued reply is being chosen; this round has still not started.
  holdDecisions = true
  provider.release()
  await expect(page.locator("article[data-slot] [data-choosing-speaker]")).toHaveText(CHOOSING)
  await expect(strip(page)).not.toContainText("Choosing who replies now.")
  if (shots) await page.screenshot({ path: `${shots}/queued-round-waiting.png`, animations: "disabled" })
  releaseDecisions()
  // The timeline virtualizes older rows: count the persisted path, not mounted articles.
  await expect
    .poll(
      () =>
        admin((api) =>
          Effect.gen(function* () {
            const chat = yield* api.GetChat({ chatId: chatId as never })
            const path = yield* api.ReadPath({
              chatId: chat.id,
              leafSlotId: chat.activeLeafSlotId,
              range: { _tag: "Bottom" },
              limit: 10
            })
            return { count: path.entries.length, status: path.entries.at(-1)?.version.status }
          })
        ),
      { timeout: 20_000 }
    )
    .toEqual({ count: 8, status: "complete" })
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  await expect(strip(page)).toHaveCount(0)
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
      // On, with Auto: the pill names no one, since the model chooses when you send.
      await expect(nextChip(page)).toHaveAccessibleName("Next: chosen when you send. Choose who replies next")
      await expect(nextChip(page)).toContainText("Next: chosen when you send")
      await expect(nextChip(page)).not.toContainText(PLANNED)
      await expect(page.getByRole("button", { name: "Get a reply", exact: true })).toBeVisible()
      await nextChip(page).hover()
      await expect(tooltip(page)).toContainText(
        "When you send, the decision model reads the chat and chooses who replies; if it can't decide, the chat's reply order does."
      )
      await expect(tooltip(page)).not.toContainText(PLANNED)
      if (shots) await page.screenshot({ path: `${shots}/pill-before-${width}-${colorScheme}.png` })
      await auditTooltip(page, `pill-before-${width}-${colorScheme}`)
      await expectLayout(page, test.info(), `pill-chip-${width}-${colorScheme}`)
      // The chooser's Auto row names no one either; a pick still names who replies.
      await nextChip(page).click()
      const auto = page.getByRole("radio", { name: /^Auto/ })
      await expect(auto).toHaveAccessibleName("Auto")
      await expect(auto).toBeChecked()
      await page.keyboard.press("Escape")

      // While the decision model chooses, the reply names no one: never Auto's pick, then Ash.
      const before = asked.length
      await recordSpeakers(page)
      holdDecisions = true
      await page.getByLabel("Message", { exact: true }).fill("Anyone seen the Gull?")
      await page.keyboard.press("Enter")
      const reply = page.locator("article[data-slot]").nth(2)
      await expect(reply.locator("[data-choosing-speaker]")).toHaveText(CHOOSING)
      await expect(reply.locator("header").first()).not.toContainText(PLANNED)
      await expect(reply.locator("header").first()).not.toContainText("Ash")
      if (shots) await page.screenshot({ path: `${shots}/choosing-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `choosing-${width}-${colorScheme}`)
      releaseDecisions()
      await expect(reply.getByText("The tide is turning.")).toBeVisible()
      await expect(reply.locator("header").first()).toContainText("Ash")
      expect(asked.length).toBe(before + 1)
      const slot = (await reply.getAttribute("data-slot"))!
      expect((await seenSpeakers(page))[slot]).toEqual([CHOOSING, "Ash"])

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

// A round (no one-reply-a-send): the strip names the turns already chosen and only counts the
// rest, never Auto's plan for them; each later turn is chosen when it comes, its reply naming no
// one until then.
for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`a round's turns are chosen as they come, at ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await setPoint(true)
      const chatId = await groupChat(false)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(nextChip(page)).toBeEnabled()
      await recordSpeakers(page)
      const before = asked.length
      holdDecisions = true
      provider.hold()
      await page.getByLabel("Message", { exact: true }).fill("Anyone seen the Gull?")
      // This checks the decision round; a late focus change mustn't swallow its send.
      await page.getByRole("button", { name: "Send as Ana", exact: true }).click()

      // The first turn, being chosen: no one named, in the reply or the strip.
      const first = page.locator("article[data-slot]").nth(2)
      await expect(first.locator("[data-choosing-speaker]")).toHaveText(CHOOSING)
      await expect(strip(page)).toContainText(
        /Choosing who replies now\. Then \d+ more, each chosen when it's their turn/
      )
      await expect(strip(page)).not.toContainText(PLANNED)
      await expect(strip(page)).not.toContainText("Ash")
      const turns = Number(/Then (\d+) more/.exec(await strip(page).innerText())![1])
      expect(turns).toBeGreaterThanOrEqual(1)
      if (shots) await page.screenshot({ path: `${shots}/round-choosing-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `round-choosing-${width}-${colorScheme}`)

      // Chosen: Ash, in the reply and the strip; the rest still only counted.
      releaseDecisions()
      await expect(first.locator("header").first()).toContainText("Ash")
      await expect(strip(page)).toContainText(`Ash so far. Then ${turns} more, each chosen when it's their turn`)
      await expect(strip(page)).not.toContainText(PLANNED)
      if (shots) await page.screenshot({ path: `${shots}/round-chosen-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `round-chosen-${width}-${colorScheme}`)

      // The round runs out, each later turn asked when it comes.
      provider.release()
      await expect(page.locator("article[data-slot]")).toHaveCount(3 + turns, { timeout: 20_000 })
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
      await expect(strip(page)).toHaveCount(0)
      expect(asked.length).toBe(before + 1 + turns)
      const seen = await seenSpeakers(page)
      expect(seen[(await first.getAttribute("data-slot"))!]).toEqual([CHOOSING, "Ash"])
      for (let i = 3; i < 3 + turns; i++) {
        const shown = seen[(await page.locator("article[data-slot]").nth(i).getAttribute("data-slot"))!]!
        // Never one name and then another: only the speaker chosen, after the choosing state at most.
        expect(shown.filter((label) => label !== CHOOSING)).toHaveLength(1)
        expect(shown.at(-1)).not.toBe(CHOOSING)
      }
    })
