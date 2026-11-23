// A reply's generation figures with its reasoning apart (reasoningstats1): the provider's reasoning
// count, whether its text came with the reply or the provider kept it back, and the first
// reasoning and reply tokens timed apart when reasoning streamed. A synthetic Chat Completions
// server answers each model its own way.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const THOUGHT = "Mira weighs the ledger against the rain before she answers."
const REPLY = "Mira points to the north road and closes the book."

/** `shown`: streams reasoning, then the reply; `hidden`: only the reply, a reasoning count in usage; `plain`: neither. */
const startProvider = async () => {
  const http = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", () => {
      const mode = (JSON.parse(body) as { model: string }).model
      const chunk = (fields: object) =>
        res.write(
          `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: mode, ...fields })}\n\n`
        )
      const deltas = [
        ...(mode === "shown" ? THOUGHT.match(/\S+\s*/g)!.map((t) => ({ reasoning_content: t })) : []),
        ...REPLY.match(/\S+\s*/g)!.map((t) => ({ content: t }))
      ]
      const reasoning = mode === "plain" ? undefined : 40
      res.writeHead(200, { "content-type": "text/event-stream" })
      let i = 0
      const timer = setInterval(() => {
        if (i < deltas.length) {
          chunk({
            choices: [
              { index: 0, delta: i === 0 ? { role: "assistant", ...deltas[i] } : deltas[i], finish_reason: null }
            ]
          })
          i++
          return
        }
        clearInterval(timer)
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        chunk({
          choices: [],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 60,
            total_tokens: 110,
            ...(reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } })
          }
        })
        res.end("data: [DONE]\n\n")
      }, 40)
      res.on("close", () => clearInterval(timer))
    })
  })
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    stop: () =>
      new Promise<void>((done) => {
        http.closeAllConnections()
        http.close(() => done())
      })
  }
}

let provider: Awaited<ReturnType<typeof startProvider>>
test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

const setup = (key: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: `Synthetic ${key}`,
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key, overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const chat = yield* api.CreateChat({ title: `Reasoning ${key}` })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Which road?"
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      return chat
    })
  )

const cases = [
  {
    key: "shown",
    rows: [
      /Time to first reasoning token\d+\.\d s/,
      /Time to first reply token\d+\.\d s/,
      /Output tokens60 \(40 reasoning, 20 reply\)/,
      /Reasoning40 tokens, shown above the reply/
    ],
    absent: "Time to first token"
  },
  {
    key: "hidden",
    rows: [
      /Time to first token\d+\.\d s/,
      /Output tokens60 \(40 reasoning, 20 reply\)/,
      /Reasoning40 tokens, not returned by the provider/,
      /Speed\d+\.\d tokens\/s \(reply only\)/
    ],
    absent: "Time to first reasoning token"
  },
  {
    key: "plain",
    rows: [/Time to first token\d+\.\d s/, /Output tokens60Reasoningnone/],
    absent: "Time to first reasoning token"
  }
]

for (const { key, rows, absent } of cases)
  test(`the generation figures say how the reasoning came: ${key}`, async ({ page }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await setup(key)
    await page.goto(`${server().url}/chats/${chat.id}`)
    await page
      .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
      .last()
      .click()
    const reply = page.getByRole("article").last()
    await expect(reply.locator(".markdown").last()).toContainText("closes the book")
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
    const metrics = reply.getByRole("button", { name: /^Generation: \d+\.\d s · / })
    await metrics.click()
    const panel = page.getByRole("dialog", { name: "Generation" })
    for (const row of rows) await expect(panel).toContainText(row)
    await expect(panel).not.toContainText(absent)
  })
