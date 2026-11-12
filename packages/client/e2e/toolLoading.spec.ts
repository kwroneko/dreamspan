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
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
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
test.beforeAll(async () => {
  const http = createServer((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages")) return res.writeHead(404).end()
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        messages?: Array<{ content: string | Array<{ type: string; tool_use_id?: string }> }>
      }
      const last = body.messages?.at(-1)?.content
      const answered = Array.isArray(last) ? last.find((b) => b.type === "tool_result")?.tool_use_id : undefined
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

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`tools sent, loaded and never loaded, in the run inspector, at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const run = await admin((api) =>
        Effect.gen(function* () {
          const connection = yield* api.CreateConnection({
            kind: "anthropic",
            settings: {
              name: "Synthetic Claude",
              baseUrl: provider.url,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: "sk-ant-made-up-for-tests-0000"
          })
          const model = yield* api.AddUserModel({
            connectionId: connection.id,
            key: "claude-sonnet-4-5",
            overrides: {}
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
      await page.goto(`${server().url}/chats/${run.chatId}/context/${entry.version.id}#run-steps`)

      const tools = page.getByRole("region", { name: "Tools offered" })
      const sentFirst = tools.getByRole("region", { name: "Sent from the start" })
      const loaded = tools.getByRole("region", { name: "Loaded during the run" })
      const never = tools.getByRole("region", { name: "Never loaded" })
      await expect(sentFirst).toBeVisible({ timeout: 30_000 })
      await expect(sentFirst.getByRole("heading")).toHaveText(/^Sent from the start · 4 tools, [\d,]+ tokens$/)
      await expect(sentFirst.getByRole("region", { name: "list_library" })).toBeVisible()
      await expect(sentFirst.getByRole("region", { name: "load_skill" })).toBeVisible()
      await expect(loaded.getByRole("heading")).toHaveText(/^Loaded during the run · 5 tools, [\d,]+ tokens$/)
      await expect(loaded.getByRole("region", { name: "read_card" })).toContainText(
        /[\d,]+ tokens · loaded by load_skill/
      )
      await expect(never.getByRole("region", { name: "start_chat" })).toBeVisible()
      await expect(never.getByRole("region", { name: "read_card" })).toHaveCount(0)

      await sentFirst.scrollIntoViewIfNeeded()
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: resolve(shots, `tool-loading-${width}-${theme}.png`), animations: "disabled" })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expectLayout(page, info, `tool-loading-${width}-${theme}`, { scope: '[aria-label="Tools offered"]' })
    })
