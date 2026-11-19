// The story helper in the browser (spec/SUBAGENTS.md SA8, §9): off by default in a story; This
// chat → Tools allows it, with a line saying where it may send what it reads; then the subagent
// model chip shows beside the model chip, and a reply's call to the helper shows its row,
// "Story helper", under the call's step. Settings → Assistant tools has its limits. Layout audit
// on the Tools section, the reply and the limits at 1440 and 390, light and dark. Synthetic data
// and a scripted loopback provider only.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

const HELPER = "Ask a helper to look things up or check a draft against the story"
const DRAFT = "Mira hands Tobin the brass key."
const REPORT = "No contradiction: Mira still has the brass key."
const ANSWER = "Mira turns the brass key over in her hand."

/** A reply that asks the helper to check its draft, then answers; the helper searches once, then reports. */
const startProvider = async () => {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "helper",
      object: "chat.completion.chunk",
      model: "story-small",
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: { prompt_tokens: 80, completion_tokens: 8 }
    })}\n\n`
  const send = (res: ServerResponse, parts: ReadonlyArray<string>) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end([...parts, "data: [DONE]\n\n"].join(""))
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
  const http = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "story-small", object: "model" }] }))
    }
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        messages: Array<{ role: string; content?: unknown }>
        tools?: Array<{ function: { name: string } }>
      }
      const results = body.messages.filter((m) => m.role === "tool").length
      if (JSON.stringify(body.messages[0]?.content ?? "").includes("You are a subagent"))
        return results === 0 && body.tools?.length
          ? call(res, "helper_search", "search_chat", { query: "key" })
          : text(res, REPORT)
      if (body.tools?.some((t) => t.function.name === "ask_helper") && results === 0)
        return call(res, "call_helper", "ask_helper", { task: "The key.", draft: DRAFT })
      return text(res, ANSWER)
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
  await admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic story",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "story-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const importCard = async (page: Page, name: string) => {
  const data = {
    name,
    description: `${name} keeps the lighthouse ledger.`,
    personality: "Careful.",
    scenario: "A stormy night.",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "Synthetic",
    character_version: "",
    extensions: {}
  }
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref.entityId as EntityId
}

// One account's settings: the cases run one after another.
test.describe.configure({ mode: "serial" })
const chip = (page: Page) => page.getByRole("button", { name: /^Subagent models: / })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the story helper at ${width}, ${theme}`, async ({ page }, info) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const card = await importCard(page, `Mira ${width} ${theme}`)
      const chatId = await admin((api) =>
        Effect.gen(function* () {
          const started = yield* api.StartChat({
            cards: [card],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "Who has the key?", speakerEntityId: null }
          })
          const id = started.chat.id
          yield* api.ChangeCast({ chatId: id, slotId: null, change: { _tag: "AgentEnabled", on: true } })
          yield* api.ChangeCast({
            chatId: id,
            slotId: null,
            change: { _tag: "OutputContract", contract: "final_text" }
          })
          return id as ChatId
        })
      )

      // Tools on, the helper off: no subagent chip.
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(page.getByTestId("composer")).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole("button", { name: /^Model: / })).toBeVisible()
      await expect(chip(page)).toHaveCount(0)

      // This chat → Tools: the helper is listed, unticked; ticked, it says where it may send.
      const settings = await openPanel(page, "This chat")
      const tools = settings.getByRole("region", { name: "Tools" }).or(settings.locator('section[aria-label="Tools"]'))
      const helper = tools.getByRole("checkbox", { name: HELPER })
      await helper.scrollIntoViewIfNeeded()
      await expect(helper).not.toBeChecked()
      await expect(tools.locator("[data-subagent-consent]")).toHaveCount(0)
      await helper.click()
      await expect(helper).toBeChecked()
      await expect(tools.locator("[data-subagent-consent]")).toContainText("only this chat's own model")
      await expectLayout(page, info, `story-helper-tools-${width}-${theme}`, { scope: 'section[aria-label="Tools"]' })
      await closePanel(page)

      // The subagent model chip beside the model chip.
      await expect(chip(page)).toContainText("Subagents: Same model")

      // A reply that asks the helper to check its draft: the row under the call's step.
      const slotId = await admin((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 })
          const reply = yield* api.Generate({ chatId, parentSlotId: path.entries.at(-1)!.slotId, branch: false })
          if (reply._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return reply.entry.slotId as SlotId
        })
      )
      expect(slotId).toBeTruthy()
      const reply = page.getByRole("article").filter({ hasText: ANSWER })
      await expect(reply).toHaveCount(1, { timeout: 30_000 })
      const badge = reply.locator("[data-steps-badge]")
      const row = reply.locator("[data-subagent]")
      await expect(async () => {
        if ((await row.count()) === 0 && (await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
        await expect(row).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await expect(row).toHaveAttribute("data-subagent", "helper-1")
      await expect(row).toHaveAttribute("data-subagent-status", "done")
      await expect(row).toContainText("Story helper")
      await expect(row).toContainText("draft check")
      await expect(row).toContainText("Same model · story-small")
      await row.getByRole("button", { name: /Subagent/ }).click()
      await expect(row).toContainText(DRAFT)
      await expectLayout(page, info, `story-helper-row-${width}-${theme}`, { scope: "article:last-of-type" })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

      // Settings → Assistant tools: the story helper's own limits.
      await page.goto(`${server().url}/settings/assistant-tools`)
      const limits = page.locator("[data-subagent-story-limits]")
      await expect(limits).toBeVisible({ timeout: 30_000 })
      await limits.getByLabel("Model requests", { exact: true }).fill("4")
      await page.locator("[data-subagent-limits]").getByRole("button", { name: "Save" }).click()
      await expect(
        page.locator("[data-subagent-limits]").getByRole("status").filter({ hasText: "Saved." })
      ).toBeVisible()
      expect(await admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.limits.story))).toEqual({
        requests: 4
      })
      await expectLayout(page, info, `story-helper-limits-${width}-${theme}`, {
        scope: "[data-subagent-story-limits]"
      })
      await admin((api) => api.ChangeSubagentSettings({ limits: null }))
    })
