// Tools loaded as a workshop run goes (spec/TOOL-LOADING.md §7), in the run inspector: those sent
// from the start, those the assistant loaded (and with what), and those it never needed, each
// with its size in tokens. A scripted loopback Anthropic provider: load_skill("cards"), then
// read_card, then the reply. Layout audit on the tools list, at 1440 and 390, light and dark.
import { mkdirSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { expectOneScroller, scrollPane } from "./support/scrollPane.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const start = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 }
  }
}
const sse = (res: ServerResponse, events: ReadonlyArray<{ type: string }>) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}
const toolUse = (id: string, name: string, input: unknown) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
]
const text = (value: string) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" }
]

let provider: { url: string; close: () => Promise<void> }
// The tools the run's first request sent in full (Anthropic sends deferred ones flagged
// defer_loading; the dispatcher leaves them out), so the inspector's count follows the registry.
let sentFromStart: ReadonlyArray<string> = []
type WireTool = { name?: string; defer_loading?: boolean; function?: { name?: string } }
const sentIn = (tools: ReadonlyArray<WireTool> | undefined) =>
  (tools ?? []).filter((t) => t.defer_loading !== true).map((t) => t.function?.name ?? t.name ?? "")
test.beforeAll(async () => {
  const http = createServer((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      if (req.url?.startsWith("/v1/chat/completions")) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          reasoning_effort?: string
          messages: Array<{ role: string; tool_call_id?: string }>
          tools?: ReadonlyArray<WireTool>
        }
        if (body.reasoning_effort && body.reasoning_effort !== "none") {
          res.writeHead(400, { "content-type": "application/json" })
          return res.end(
            JSON.stringify({
              error: {
                message: "Function tools with reasoning_effort are not supported; set reasoning_effort to 'none'.",
                type: "invalid_request_error"
              }
            })
          )
        }
        const answered = body.messages.filter((m) => m.role === "tool").at(-1)?.tool_call_id
        if (!answered) sentFromStart = sentIn(body.tools)
        const name = !answered ? "load_skill" : "call_tool"
        const args = !answered ? { name: "cards" } : { name: "read_card", arguments: { card: "Assistant" } }
        const delta =
          answered === "toolu_read"
            ? { content: "The Assistant card is practical and brief." }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: !answered ? "toolu_load" : "toolu_read",
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) }
                  }
                ]
              }
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const [d, finish] of [
          [delta, null],
          [{}, answered === "toolu_read" ? "stop" : "tool_calls"]
        ])
          res.write(
            `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`
          )
        return res.end("data: [DONE]\n\n")
      }
      if (!req.url?.startsWith("/v1/messages")) return res.writeHead(404).end()
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        messages?: Array<{ content: string | Array<{ type: string; tool_use_id?: string }> }>
        tools?: ReadonlyArray<WireTool>
      }
      const last = body.messages?.at(-1)?.content
      const answered = Array.isArray(last) ? last.find((b) => b.type === "tool_result")?.tool_use_id : undefined
      if (answered === undefined) sentFromStart = sentIn(body.tools)
      sse(
        res,
        answered === undefined
          ? toolUse("toolu_load", "load_skill", { name: "cards" })
          : answered === "toolu_load"
            ? toolUse("toolu_read", "read_card", { card: "Assistant" })
            : text("The Assistant card is practical and brief.")
      )
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

const settled = (chatId: ChatId, slotId: SlotId) =>
  admin((api) =>
    Effect.gen(function* () {
      for (let i = 0; i < 300; i++) {
        const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 })
        const entry = path.entries.find((e) => e.slotId === slotId)
        if (entry && entry.version.status !== "generating") return entry
        yield* Effect.sleep("100 millis")
      }
      return yield* Effect.die("the reply didn't finish")
    })
  )

for (const transport of ["native", "dispatcher"] as const)
  for (const width of [1340, 390])
    for (const theme of ["light", "dark"] as const)
      test(`per-request tools in the ${transport} run inspector, at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(120_000)
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const run = await admin((api) =>
          Effect.gen(function* () {
            const connection = yield* api.CreateConnection({
              kind: transport === "native" ? "anthropic" : "openai-chat",
              settings: {
                name: "Synthetic Claude",
                baseUrl: transport === "native" ? provider.url : `${provider.url}/v1`,
                compat: {},
                cacheTtlS: null,
                maxConcurrent: null,
                presetOverrideRefId: null,
                ...(transport === "dispatcher" ? { providerSettings: { toolLoading: "dispatcher" as const } } : {})
              },
              apiKey: "sk-ant-made-up-for-tests-0000"
            })
            const model = yield* api.AddUserModel({
              connectionId: connection.id,
              key: transport === "native" ? "claude-sonnet-4-5" : "mock",
              overrides: transport === "dispatcher" ? { settings: { samplers: { reasoning_effort: "low" } } } : {}
            })
            yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
            const chat = yield* api.CreateWorkshop({ title: `Tool loading ${width} ${theme}` })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: chat.activeLeafSlotId,
              branch: false,
              content: "Read the Assistant card."
            })
            if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
            const reply = yield* api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
            if (reply._tag !== "Posted") return yield* Effect.die("unexpected queue")
            return { chatId: chat.id, slotId: reply.entry.slotId }
          })
        )
        const entry = await settled(run.chatId, run.slotId)
        expect(entry.version.status).toBe("complete")
        // A new process must read the same per-request definitions and provenance.
        await server().restart()
        await page.goto(`${server().url}/chats/${run.chatId}/context/${entry.version.id}`)

        if (transport === "dispatcher") {
          await expect(
            page.getByText(
              "Reasoning effort “low” was changed to “none” for this request because this model refuses reasoning with tools. Your saved setting is unchanged."
            )
          ).toBeVisible({ timeout: 30_000 })
          await expectLayout(page, info, `reasoning-notice-${width}-${theme}`)
        }
        const tools = page.getByRole("region", { name: "Tools", exact: true }).first()
        const summary = tools.locator("summary").first()
        const messages = page.getByRole("region", { name: "Messages", exact: true })
        const total = page.getByText(/^[\d,]+ tokens: [\d,]+ messages, [\d,]+ tools$/)
        await expect(total).toBeVisible({ timeout: 30_000 })
        const usage = page.getByRole("region", { name: "Usage", exact: true }).locator("details")
        await expect(usage).toHaveJSProperty("open", false)
        await usage.locator("summary").click()
        await expect(usage).toContainText("Cache read")
        await usage.locator("summary").click()
        await scrollPane(tools, { to: "start" })
        await expect(summary).toHaveText(/^Tools[\d,]+ tokens$/)
        await expect(tools.locator("details").first()).toHaveJSProperty("open", false)
        const read = tools.getByRole("region", { name: "read_card", exact: true })
        await expect(read).toHaveCount(0)
        const counts = (await total.innerText()).match(/\d[\d,]*/g)!.map((value) => Number(value.replaceAll(",", "")))
        const [, messageTokens, toolTokens] = counts
        expect(counts[0]).toBe(messageTokens! + toolTokens!)
        expect(toolTokens).toBeGreaterThan(0)
        expect((await summary.innerText()).replaceAll(",", "")).toContain(`${toolTokens} tokens`)
        expect(await tools.evaluate((element) => element.nextElementSibling?.getAttribute("aria-label"))).toBe(
          "Messages"
        )
        await expect(page.getByRole("region", { name: "Tools offered" })).toHaveCount(0)
        const shot = async (state: string) => {
          if (!shots || transport !== "native") return
          mkdirSync(shots, { recursive: true })
          await page.screenshot({
            path: resolve(shots, `request-tools-${width}-${theme}-${state}.png`),
            animations: "disabled"
          })
        }
        await shot("overview")
        await scrollPane(tools, { at: -110 })
        await summary.scrollIntoViewIfNeeded()
        const beforeHover = await summary.boundingBox()
        await summary.hover()
        const explanation = page.getByText(
          "Show or hide the tool definitions included in this request. The token count is an estimate.",
          { exact: true }
        )
        await expect(explanation).toBeVisible()
        expect(await summary.boundingBox()).toEqual(beforeHover)
        await page.mouse.move(1, 1)
        await expect(explanation).toBeHidden()
        const toolsBox = (await tools.boundingBox())!
        const messagesBox = (await messages.boundingBox())!
        expect(Math.round(messagesBox.y - toolsBox.y - toolsBox.height)).toBe(16)
        await shot("collapsed")
        await summary.click()
        await expect(read).toContainText("Loaded by load_skill")
        await expect(tools.getByRole("region", { name: "start_chat", exact: true })).toHaveCount(0)
        await read.locator("summary").click()
        await expect(read.locator("pre")).toContainText('"properties"')
        await scrollPane(read, { at: -16 })
        await page.mouse.move(1, 1)
        await shot("expanded")
        await expectOneScroller(tools, "expanded tools and parameters")
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expectLayout(page, info, `tool-loading-${transport}-${width}-${theme}`, {
          scope: '[aria-label="Tools"]'
        })

        const steps = page.getByRole("region", { name: "Steps", exact: true })
        const requestTools = (number: number) =>
          steps
            .getByRole("heading", { name: `Request ${number}`, exact: true })
            .locator("xpath=ancestor::section[1]")
            .getByRole("region", { name: "Tools", exact: true })
        const first = requestTools(1)
        const second = requestTools(2)
        if (transport === "dispatcher") {
          const retry = steps.getByRole("heading", { name: "Attempt 1", exact: true })
          await expect(
            retry.locator("xpath=ancestor::section[1]").getByRole("region", { name: "Tools", exact: true })
          ).toBeVisible()
        }
        await expect(first.locator("details").first()).toHaveJSProperty("open", false)
        await first.locator("summary").click()
        expect(await first.getByRole("region").all()).toHaveLength(sentFromStart.length)
        expect(sentFromStart).toContain("list_library")
        for (const name of sentFromStart) await expect(first.getByRole("region", { name, exact: true })).toBeVisible()
        await expect(first.getByRole("region", { name: "read_card", exact: true })).toHaveCount(0)
        await second.locator("summary").click()
        await expect(second.getByRole("region", { name: "read_card", exact: true })).toContainText(
          "Loaded by load_skill"
        )
        await expect(second.getByRole("region", { name: "start_chat", exact: true })).toHaveCount(0)
      })
