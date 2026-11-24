// The next-reply strip above the composer (owner, 2026-11-23): its order (who replies, the model,
// the preset, then the next request's size and cache), the context chip's size against the
// request view's own count, the context chip counting nothing while keys are coming, the cache
// chip for a model added by hand on each kind of provider (working, or not there at all, never a
// dead chip), and the phone width. A loopback provider speaks both Chat Completions and Messages.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cacheChip, nextReply } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
/** SCREENSHOT_DIR keeps the screenshots. */
const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const REPLY = "The lanterns stay lit."
const chatChunk = (body: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: "fake", ...body })}\n\n`
const anthropicEvents = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "synthetic",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 0, output_tokens: 1 }
    }
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
]

let provider: { url: string; close: () => Promise<void> }
test.beforeAll(async () => {
  const http = createServer((req, res: ServerResponse) => {
    req.resume()
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://loopback.invalid").pathname
      if (url.endsWith("/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const event of anthropicEvents) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        return res.end()
      }
      if (url.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(chatChunk({ choices: [{ index: 0, delta: { role: "assistant", content: REPLY } }] }))
        res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
        res.write(
          chatChunk({
            choices: [],
            usage: { prompt_tokens: 2_100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1_900 } }
          })
        )
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "none" } }))
    })
  })
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done))
  provider = {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => http.close(() => done()))
  }
})
test.afterAll(async () => {
  await provider.close()
})

// A card long enough for any provider's minimum cacheable prefix (OpenAI's is 1,024 tokens).
const DESCRIPTION = Array.from(
  { length: 120 },
  (_, i) => `Harbor ledger line ${i + 1}: the tide tables, the lantern oil and the ferry times.`
).join("\n")

/**
 * A chat with one reply from a model added by hand to a connection of `provider`, bound to the
 * chat as the user's default when it was made.
 */
let cards = 0
const chatWith = (connection: { provider: string; kind: string; baseUrl: string }, key: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const created = yield* api.CreateConnection({
        provider: connection.provider,
        kind: connection.kind as never,
        settings: {
          name: `Synthetic ${connection.provider}`,
          baseUrl: connection.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-synthetic-strip-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: created.id, key, overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: created.id, model: model.id }, preset: null }
      })
      const card = yield* api.CreateCard({ label: `Mira ${++cards}`, name: "Mira", description: DESCRIPTION })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The road flooded.", speakerEntityId: null }
      })
      yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      return started.chat.id
    })
  )

const openChat = async (page: Page, chatId: ChatId) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByRole("article").last()).toContainText(REPLY)
  await expect(page.getByRole("article").last().getByText("generating", { exact: true })).toHaveCount(0, {
    timeout: 30_000
  })
}

const contextChip = (page: Page) => nextReply(page).getByRole("button", { name: /^Context: about / })
/** The chip's tokens, from its name: "Context: about 2,345 of 131,072 tokens in your next request. Details". */
const chipTokens = async (page: Page) =>
  Number(
    /^Context: about ([\d,]+)/.exec((await contextChip(page).getAttribute("aria-label")) ?? "")![1]!.replaceAll(",", "")
  )

test.describe("a model added by hand gets a working cache chip, or none", () => {
  for (const [label, connection, key, warm] of [
    ["Anthropic", { provider: "anthropic", kind: "anthropic", baseUrl: "" }, "synthetic-custom-claude", true],
    [
      "OpenAI, a fine-tune",
      { provider: "openai", kind: "openai-chat", baseUrl: "/v1" },
      "ft:gpt-4.1-mini:synthetic::abc123",
      true
    ],
    [
      "OpenRouter, an upstream with no stated lifetime",
      { provider: "openrouter", kind: "openrouter", baseUrl: "/v1" },
      "deepseek/synthetic-custom",
      false
    ],
    [
      "an OpenAI-compatible server",
      { provider: "openai-compatible", kind: "openai-chat", baseUrl: "/v1" },
      "synthetic-local",
      false
    ]
  ] as const)
    test(`${label}: ${warm ? "the cache is warm after a reply" : "no cache chip"}`, async ({ page }) => {
      const chatId = await chatWith({ ...connection, baseUrl: `${provider.url}${connection.baseUrl}` }, key)
      await openChat(page, chatId)
      // The size shows for every provider.
      await expect(contextChip(page)).toBeVisible()
      if (warm) await expect(cacheChip(page)).toHaveText(/^Cache warm \d+:\d\d$/)
      else {
        // No dead chip: absent, not disabled, once the estimate is in.
        await expect(contextChip(page)).toBeVisible()
        await expect(nextReply(page).getByRole("button", { name: /^Cache/ })).toHaveCount(0)
      }
    })
})

test.describe("the strip", () => {
  let chatId: ChatId
  test.beforeAll(async () => {
    chatId = await chatWith(
      { provider: "anthropic", kind: "anthropic", baseUrl: provider.url },
      "synthetic-strip-claude"
    )
  })

  test("reads who replies, the model, the preset, then the next request's size and cache", async ({ page }) => {
    await openChat(page, chatId)
    await expect(cacheChip(page)).toBeVisible()
    const names = await nextReply(page)
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent ?? ""))
    const at = (pattern: RegExp) => names.findIndex((name) => pattern.test(name))
    const order = [/^Next: /, /^(Model: |Choose a model$)/, /^Prompt preset: /, /^Context: /, /^Cache/].map(at)
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test("the context chip's size is the request view's, with its parts", async ({ page }) => {
    await openChat(page, chatId)
    const chip = contextChip(page)
    await expect(chip).toHaveText(/^[\d.]+k? \/ [\d.]+k$/)
    const tokens = await chipTokens(page)
    await chip.click()
    const details = page.getByRole("dialog", { name: "Context", exact: true })
    const parts = details.getByRole("list", { name: "Parts of the request" })
    await expect(parts).toContainText("Character cards")
    await expect(parts).toContainText("Chat history")
    await expect(details).toContainText("All 2 messages fit.")
    // A request inspector tab, as a reply's: the chat keeps its own tab.
    await details.getByRole("link", { name: "View request", exact: true }).click()
    await expect(page).toHaveURL(/\/request\/next\?chat=/)
    await expect(page.getByRole("heading", { name: "Your next request", exact: true })).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(
      page.getByText(new RegExp(`^Built now: .*, about ${tokens.toLocaleString("en-US")} tokens\\.`))
    ).toBeVisible()
  })

  test("View request has the link's open menu", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openChat(page, chatId)
    await contextChip(page).click()
    await page.getByRole("link", { name: "View request", exact: true }).click({ button: "right" })
    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem", { name: /^Open/ }).first()).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: /new browser tab/ })).toBeVisible()
  })

  test("typing counts nothing until it pauses, then once", async ({ page }) => {
    const effective = await admin((api) =>
      Effect.map(api.GetNextContext({ chatId, leafSlotId: null }), (next) => next.model!)
    )
    const counts: Array<{ tag?: string; payload?: unknown }> = []
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === "string") {
          const rpc = JSON.parse(data) as (typeof counts)[number]
          if (rpc.tag === "CountTokens" || rpc.tag === "GetNextRequest") counts.push(rpc)
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await openChat(page, chatId)
    const before = await chipTokens(page)
    const box = page.getByTestId("composer")
    await box.click()
    const typed = "Synthetic forty characters typed slowly."
    // Human speed: about 150 ms between keys, under the 800 ms pause.
    await box.pressSequentially(typed, { delay: 150 })
    expect(counts).toEqual([])
    await expect.poll(() => counts.length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => chipTokens(page)).toBeGreaterThan(before)
    await page.waitForTimeout(2_000)
    expect(counts).toMatchObject([
      {
        tag: "CountTokens",
        payload: {
          localOnly: true,
          model: { connection: effective.connection, model: effective.model },
          texts: [typed]
        }
      }
    ])
    await contextChip(page).click()
    await expect(page.getByRole("list", { name: "Parts of the request" })).toContainText("Your message")
  })

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`fits at ${width} px (${theme})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await openChat(page, chatId)
        await expect(cacheChip(page)).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow).toBeLessThanOrEqual(0)
        await expectLayout(page, info, `next-reply-strip-${width}-${theme}`, {
          scope: '[role="group"][aria-label="Next reply"]'
        })
        await shoot(page, `chat-strip-${width}-${theme}`)
        await contextChip(page).click()
        await expectLayout(page, info, `next-reply-context-${width}-${theme}`, {
          scope: '[role="dialog"]',
          hovered: true
        })
        await shoot(page, `chat-context-popover-${width}-${theme}`)
        await page.keyboard.press("Escape")
        await cacheChip(page).click()
        await expectLayout(page, info, `next-reply-cache-${width}-${theme}`, {
          scope: '[role="dialog"]',
          hovered: true
        })
        await shoot(page, `chat-cache-popover-${width}-${theme}`)
      })
})

test("an open next request refreshes after a sampler-only model edit", async ({ page }) => {
  const chatId = await chatWith(
    { provider: "openai-compatible", kind: "openai-chat", baseUrl: `${provider.url}/v1` },
    "synthetic-sampler-preview"
  )
  const setTemperature = (temperature: number) =>
    admin((api) =>
      Effect.gen(function* () {
        const { model: choice } = yield* api.GetGenerationDefaults()
        const models = yield* api.ListModels({ connectionId: choice!.connection, includeHidden: true })
        const model = models.find((model) => model.id === choice!.model)!
        yield* api.EditModel({
          modelId: model.id,
          expectedRowVersion: model.rowVersion,
          overrides: { settings: { samplers: { temperature } } }
        })
      })
    )
  await setTemperature(0.5)
  await openChat(page, chatId)
  await contextChip(page).click()
  await page.getByRole("link", { name: "View request", exact: true }).click()
  const size = page.getByText(/^Built now: .* tokens\./)
  await expect(page.getByText(/temperature 0\.5\b/)).toBeVisible()
  const before = await size.textContent()
  await setTemperature(0.8)
  await expect(page.getByText(/temperature 0\.8\b/)).toBeVisible()
  await expect(size).toHaveText(before!)
})

test.describe("a chat not sent yet", () => {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`its context chip has the same popover and View request (${width} ${theme})`, async ({ page }, info) => {
        const entityId = await admin((api) =>
          Effect.gen(function* () {
            const created = yield* api.CreateConnection({
              provider: "anthropic",
              kind: "anthropic",
              settings: {
                name: "Synthetic first",
                baseUrl: provider.url,
                compat: {},
                cacheTtlS: null,
                maxConcurrent: null,
                presetOverrideRefId: null
              },
              apiKey: "sk-synthetic-strip-0042"
            })
            const model = yield* api.AddUserModel({ connectionId: created.id, key: "synthetic-first", overrides: {} })
            yield* api.SetGenerationDefaults({
              defaults: { model: { connection: created.id, model: model.id }, preset: null }
            })
            const card = yield* api.CreateCard({ label: `Mira ${++cards}`, name: "Mira", description: DESCRIPTION })
            return card.entityId
          })
        )
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        await page.goto(`${server().url}/cards/${entityId}/chat`)
        if (width === 390 && (await page.getByRole("button", { name: "Close", exact: true }).isVisible()))
          await page.getByRole("button", { name: "Close", exact: true }).click()
        const chip = nextReply(page).getByRole("button", {
          name: /^Context: about [\d,]+ of [\d,]+ tokens in your first/
        })
        await expect(chip).toHaveText(/^[\d.]+k? \/ [\d.]+k$/)
        await shoot(page, `new-chat-strip-${width}-${theme}`)
        await chip.click()
        const details = page.getByRole("dialog", { name: "Context", exact: true })
        await expect(details.getByRole("list", { name: "Parts of the request" })).toContainText("Character cards")
        await expectLayout(page, info, `new-chat-context-${width}-${theme}`, {
          scope: '[role="dialog"]',
          hovered: true
        })
        await shoot(page, `new-chat-context-popover-${width}-${theme}`)
        await details.getByRole("link", { name: "View request", exact: true }).click()
        await expect(page).toHaveURL(/\/request\/first\?/)
        await expect(page.getByRole("heading", { name: "Your first request", exact: true })).toBeVisible()
      })
})

test("every place that shows the next request's size shows the same number", async ({ page }) => {
  // A small context, so the history is cut and the boundary line shows; then another model,
  // so the cache chip shows its uncached part out of the request's total.
  const { chatId, other } = await admin((api) =>
    Effect.gen(function* () {
      const created = yield* api.CreateConnection({
        provider: "anthropic",
        kind: "anthropic",
        settings: {
          name: "Synthetic boundary",
          baseUrl: provider.url,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-synthetic-strip-0042"
      })
      const model = yield* api.AddUserModel({
        connectionId: created.id,
        key: "synthetic-boundary",
        overrides: { context: 4000 }
      })
      const other = yield* api.AddUserModel({
        connectionId: created.id,
        key: "synthetic-boundary-two",
        overrides: { context: 4000 }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: created.id, model: model.id }, preset: null }
      })
      const card = yield* api.CreateCard({
        label: `Mira ${++cards}`,
        name: "Mira",
        description: DESCRIPTION.split("\n").slice(0, 30).join("\n")
      })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The road flooded.", speakerEntityId: null }
      })
      // Summarization off: the cut history then stays above the boundary line.
      yield* api.SetLcmEnabled({ chatId: started.chat.id, enabled: false })
      let parent = started.entry.slotId
      for (let i = 0; i < 40; i++) {
        const sent = yield* api.SendMessage({
          chatId: started.chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Turn ${i}: ${"the ferry waits at the harbor while the tide tables are checked again and again. ".repeat(4)}`,
          reply: false
        })
        if (sent._tag !== "Posted") throw new Error("expected a message")
        parent = sent.entry.slotId
      }
      yield* api.Generate({ chatId: started.chat.id, parentSlotId: parent, branch: false })
      return { chatId: started.chat.id, other: { connection: created.id, model: other.id } }
    })
  )
  const start = await admin((api) =>
    Effect.gen(function* () {
      yield* api.SetGenerationDefaults({ defaults: { model: other, preset: null } })
      return (yield* api.GetNextContext({ chatId, leafSlotId: null })).historyStart
    })
  )
  expect(start?.slotId).toBeTruthy()
  // At the first message sent, where the boundary line is.
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}?slot=${start!.slotId}`)
  const line = page.getByText(/The next request is about [\d,]+ tokens\./)
  await expect(line).toBeVisible({ timeout: 30_000 })
  const boundary = /The next request is about ([\d,]+) tokens\./.exec((await line.textContent()) ?? "")![1]!
  const tokens = await chipTokens(page)
  expect(tokens.toLocaleString("en-US")).toBe(boundary)
  await expect(cacheChip(page)).toHaveAttribute("aria-label", new RegExp(` of ${boundary} tokens uncached`))
  await contextChip(page).click()
  await page.getByRole("link", { name: "View request", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Your next request", exact: true })).toBeVisible()
  await expect(page.getByText(new RegExp(`^Built now: .*, about ${boundary} tokens\\.`))).toBeVisible()
})
