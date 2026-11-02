// Regex scripts while a reply streams (ARCHITECTURE §12, "Live rewrites"), with synthetic
// fixtures only: a provider streams its reasoning, then a reply a few characters at a time
// that opens with a `<thinking>` section and then a `<cot>` chain of thought. The preset
// strips the chain of thought (AI output) and hides a word in reasoning (placement 6). Every
// render of the body, the "Reasoning" panel and the "Thinking in the reply" panel is recorded
// in the page: the stripped and hidden text never shows, mid-stream or after, and the
// finished reply is what the stream ended on.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { RefId } from "@rp/shared/library.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const REPLY =
  "<thinking>Plan: take the PRIVATE road past the mill, then wait for the answer.</thinking>\n" +
  "<cot>secret chain of thought about the mill, the road and the weather tonight</cot>" +
  "Hello there, traveller. The road is long and the mill is closed tonight, so *Mira* points at the lantern. " +
  "She waits by the door while the rain keeps on, counting the carts that pass, and says nothing more until morning."

/** The provider's own reasoning, streamed before the reply. */
const REASONING = "Weighing the PRIVATE matter of the mill before answering the traveller."

let provider: Server
let baseUrl = ""

const chunk = (body: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "slow", object: "chat.completion.chunk", model: "fake-small", ...body })}\n\n`

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "fake-small", name: "Fake Small", context_length: 32768 }] }))
      return
    }
    if (request.url !== "/v1/chat/completions") return void response.writeHead(404).end()
    request.resume()
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      let at = 0
      let thought = 0
      const next = () => {
        if (response.destroyed) return
        if (thought < REASONING.length) {
          const reasoning_content = REASONING.slice(thought, thought + 3)
          response.write(chunk({ choices: [{ index: 0, delta: { reasoning_content }, finish_reason: null }] }))
          thought += 3
          setTimeout(next, 30)
          return
        }
        if (at < REPLY.length) {
          const content = REPLY.slice(at, at + 3)
          response.write(chunk({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }))
          at += 3
          setTimeout(next, 45)
          return
        }
        response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
        response.write(chunk({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 60 } }))
        response.end("data: [DONE]\n\n")
      }
      next()
    })
  })
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done))
  baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`
})
test.afterAll(async () => {
  await new Promise<void>((done) => provider.close(() => done()))
})

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const) {
    test(`stripped text never shows while the reply streams: ${width}, ${colorScheme}`, async ({ browser }) => {
      test.setTimeout(120_000)
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme })
      const page = await context.newPage()
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const imported = await page.request.post(
        `${server().url}/library/import?name=Live-${width}-${colorScheme}.json`,
        {
          headers: { origin: server().url, "content-type": "application/octet-stream" },
          data: JSON.stringify({
            openai_max_context: 8192,
            extensions: {
              regex_scripts: [
                {
                  id: "strip-cot",
                  scriptName: "Strip the chain of thought",
                  findRegex: "/<cot>[\\s\\S]*?(?:<\\/cot>\\s*|$)/g",
                  replaceString: "",
                  placement: [2]
                },
                {
                  id: "hide-word",
                  scriptName: "Hide a word in thinking",
                  findRegex: "/PRIVATE/g",
                  replaceString: "[hidden]",
                  placement: [6]
                }
              ]
            }
          })
        }
      )
      expect(imported.status()).toBe(200)
      const refId = ((await imported.json()) as { library: { ref: { id: RefId } } }).library.ref.id
      const { chat, human } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { reasoning: "expanded" } })
          const opened = yield* api.OpenEditor({ refId })
          yield* api.SetRegexApproval({ refId, approved: true, expectedRowVersion: opened.ref.rowVersion })
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Slow synthetic provider",
              baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: null
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
          const card = yield* api.CreateCard({ label: "Live regex Mira", name: "Mira" })
          const chat = yield* api.CreateChat({ title: "Live regex — synthetic fixture" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Preset", ref: refId } })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: null,
            change: { _tag: "Model", connection: connection.id, model: model.id }
          })
          const human = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Hello" })
          if (human._tag !== "Posted") throw new Error("queued")
          return { chat, human }
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      await expect(page.locator("article[data-slot]").last()).toContainText("Hello")
      // Every render of the reply's body and thinking panel, from before the first token.
      await page.evaluate(() => {
        const frames: Array<{ body: string; thinking: string; reasoning: string }> = []
        ;(window as unknown as { frames_: typeof frames }).frames_ = frames
        const before = [...document.querySelectorAll("article[data-slot]")].at(-1)
        const record = () => {
          const reply = [...document.querySelectorAll("article[data-slot]")].at(-1)
          if (!reply || reply === before) return
          const thinking = reply.querySelector('[role="region"][aria-label="Thinking in the reply"]')
          const reasoning = reply.querySelector('[role="region"][aria-label="Reasoning"]')
          const body = [...reply.querySelectorAll(".markdown")]
            .filter((node) => !thinking?.contains(node) && !reasoning?.contains(node))
            .at(-1)
          frames.push({
            body: body?.textContent ?? "",
            thinking: thinking?.textContent ?? "",
            reasoning: reasoning?.textContent ?? ""
          })
        }
        new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true })
      })
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.Generate({ chatId: chat.id, parentSlotId: human.entry.slotId, branch: false })
      )
      const reply = page.locator("article[data-slot]").last()
      const notes = reply.getByRole("button", { name: /^Thinking in the reply/ })
      const region = reply.getByRole("region", { name: "Thinking in the reply" })
      // The provider's reasoning streams first, its word hidden from the start.
      await expect(reply.getByRole("region", { name: "Reasoning" })).toContainText("[hidden] matter", {
        timeout: 20_000
      })
      const body = reply.locator(".markdown").last()
      // Mid-stream: the thinking open with its word hidden, the body going without the chain of thought.
      await expect(region).toContainText("[hidden]", { timeout: 20_000 })
      await expect(body).toContainText("Hello there", { timeout: 20_000 })
      // Read at once, while it's still streaming (the tail of the reply takes seconds more).
      const now = await page.evaluate(() => {
        const reply = [...document.querySelectorAll("article[data-slot]")].at(-1)!
        const thinking = reply.querySelector('[role="region"][aria-label="Thinking in the reply"]')
        return { all: reply.textContent ?? "", thinking: thinking?.textContent ?? null }
      })
      // The body has started, so the thinking is done ("Thinking…" only before it).
      expect(now.all).toContain("Thinking in the reply·")
      expect(now.all).not.toContain("Thinking…")
      expect(now.thinking).toContain("[hidden]")
      for (const word of ["secret", "PRIVATE", "<cot"]) expect(now.all).not.toContain(word)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: join(process.env.SCREENSHOT_DIR, `live-regex-streaming-${width}-${colorScheme}.png`)
        })
      await expect(notes).toHaveText(/^Thinking in the reply·/, { timeout: 30_000 })
      await expect(reply.getByText("scripts changed this")).toBeVisible()
      const finalText =
        "Hello there, traveller. The road is long and the mill is closed tonight, so Mira points at the lantern. " +
        "She waits by the door while the rain keeps on, counting the carts that pass, and says nothing more until morning."
      await expect(body).toHaveText(finalText)

      const frames = await page.evaluate(
        () => (window as unknown as { frames_: Array<{ body: string; thinking: string; reasoning: string }> }).frames_
      )
      const streamed = frames.filter((frame) => frame.body !== "" || frame.thinking !== "" || frame.reasoning !== "")
      expect(streamed.filter((frame) => frame.reasoning.includes("[hidden]")).length).toBeGreaterThan(3)
      expect(streamed.length).toBeGreaterThan(10)
      for (const frame of streamed) {
        for (const word of ["secret", "chain of thought", "weather", "<cot", "<thinking", "Plan:"])
          expect(frame.body, `body frame "${frame.body}"`).not.toContain(word)
        expect(frame.thinking, `thinking frame "${frame.thinking}"`).not.toContain("PRIVATE")
        expect(frame.reasoning, `reasoning frame "${frame.reasoning}"`).not.toContain("PRIVATE")
      }
      // Scripts get no tag hold-back (DESIGN §1.2 [D]): a partial `<co` can show before
      // `<cot>` completes and its script removes it. The thinking parser must pass it on.
      const bodies = streamed.map((frame) => frame.body).filter((text) => text !== "")
      for (const text of bodies) {
        const plain = text.replace(/\*/g, "").trimEnd()
        expect(finalText.startsWith(plain) || "<cot>".startsWith(plain) || text === finalText).toBe(true)
      }

      await notes.click()
      await expect(region).toContainText("Plan: take the [hidden] road")
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: join(process.env.SCREENSHOT_DIR, `live-regex-finished-${width}-${colorScheme}.png`)
        })
      await context.close()
    })
  }
