// Display rules never change what a model is sent (review-adapters2). One plugin changes all
// three display registries; the bytes of the provider request for a story reply and for a
// workshop reply are compared with it off and on, per tool-loading transport. The provider is
// a loopback recorder; all text is synthetic.
import { test, expect } from "@playwright/test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { withCookie, loginCookie } from "./support/rpc.ts"

const server = serverPerFile(withAdmin)
let cookie: Promise<string> | undefined
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)

let provider: { readonly url: string; readonly bodies: string[]; readonly close: () => Promise<void> }
test.beforeAll(async () => {
  const bodies: string[] = []
  const http = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"))
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (request.url?.startsWith("/v1/messages")) {
        for (const event of [
          {
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
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic reply." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
          { type: "message_stop" }
        ])
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        response.end()
        return
      }
      for (const [delta, finish] of [
        [{ content: "Synthetic reply." }, null],
        [{}, "stop"]
      ])
        response.write(
          `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      response.end("data: [DONE]\n\n")
    })
  })
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done))
  provider = {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    bodies,
    close: () => new Promise((done) => http.close(() => done()))
  }
})
test.afterAll(async () => {
  await provider?.close()
})

const files = {
  "rp-plugin.json": JSON.stringify({
    id: "display-everything",
    name: "Every display rule",
    api: 1,
    server: null,
    worker: null,
    client: "client.tsx",
    surfaces: ["client:displayTransforms", "client:displayScriptLists", "client:timelineTransforms"],
    overrides: [],
    replaces: [
      "displayTransforms:display.macros",
      "displayScriptLists:display-regex.global",
      "timelineTransforms:timeline.merges"
    ],
    network: false,
    base: null
  }),
  "client.tsx": `import type { Activate } from "@rp/plugin-api/client"
export const activate: Activate = host => {
  host.registries.displayTransforms!.register({ api: 1, id: "display.macros", order: 10,
    transform: input => ({ text: input.text + " [display only]", issues: [] }) })
  host.registries.displayScriptLists!.register({ api: 1, id: "display-regex.global", order: 10,
    scripts: () => [{ id: "synthetic", name: "Synthetic", find_regex: "/Synthetic/g", replace_string: "Rewritten", trim_strings: [], placement: [1, 2, 6], disabled: false, markdown_only: true, prompt_only: false, run_on_edit: true, substitute_regex: "none", min_depth: null, max_depth: null }] })
  host.registries.timelineTransforms!.register({ api: 1, id: "timeline.merges", order: 5,
    transform: input => [...input.rows].reverse() })
}`
}

for (const transport of ["every", "native", "dispatcher"] as const)
  test(`provider request bytes are the same with every display rule changed (${transport})`, async ({ page }) => {
    test.setTimeout(300_000)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const id = `display-everything-${transport}`
    const made = await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: transport === "native" ? "anthropic" : "openai-chat",
          settings: {
            name: `Synthetic ${transport}`,
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
          overrides: {}
        })
        yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
        const story = yield* api.CreateChat({ title: `Story ${transport}` })
        yield* api.ChangeCast({
          chatId: story.id,
          slotId: null,
          change: { _tag: "Model", connection: connection.id, model: model.id }
        })
        const sent = yield* api.SendMessage({
          chatId: story.id,
          parentSlotId: null,
          branch: false,
          content: "Synthetic **story** text with {{user}}."
        })
        if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        const workshop = yield* api.CreateWorkshop({ title: `Workshop ${transport}` })
        const asked = yield* api.SendMessage({
          chatId: workshop.id,
          parentSlotId: workshop.activeLeafSlotId,
          branch: false,
          content: "Synthetic workshop request."
        })
        if (asked._tag !== "Posted") return yield* Effect.die("unexpected queue")
        const commit = yield* api.CreatePlugin({
          scope: "user",
          id,
          files: { ...files, "rp-plugin.json": files["rp-plugin.json"].replace("display-everything", id) }
        })
        const report = yield* api.CheckPlugin({ scope: "user", id, commit })
        return { story, sent: sent.entry, workshop, asked: asked.entry, commit, report }
      })
    )
    expect(made.report).toMatchObject({ ok: true })
    const requestOf = async (chatId: ChatId, parentSlotId: SlotId) => {
      const before = provider.bodies.length
      await admin((api) => api.Generate({ chatId, parentSlotId, branch: true }))
      await expect.poll(() => provider.bodies.length, { timeout: 60_000 }).toBeGreaterThan(before)
      const body = provider.bodies[before]!
      // Let the reply finish so the next request starts from the same state.
      await page.waitForTimeout(1500)
      return body
    }
    const storyUrl = `${server().url}/chats/${made.story.id}`
    await page.goto(storyUrl)
    const body = page.locator(`article[data-slot="${made.sent.slotId}"] .markdown`).first()
    await expect(body.locator("strong")).toHaveText("story")
    const off = {
      story: await requestOf(made.story.id, made.sent.slotId),
      workshop: await requestOf(made.workshop.id, made.asked.slotId)
    }
    // Control: with nothing changed, a second request has the same bytes.
    expect(await requestOf(made.story.id, made.sent.slotId)).toBe(off.story)
    expect(await requestOf(made.workshop.id, made.asked.slotId)).toBe(off.workshop)
    expect(off.story).toContain("Synthetic **story** text")
    expect(off.workshop).toContain("Synthetic workshop request.")

    expect(
      await admin((api) => api.EnablePlugin({ scope: "user", id, commit: made.commit, consent: true }))
    ).toMatchObject({ ok: true })
    // The changed rules are running in this page while the requests are made.
    await page.goto(storyUrl)
    await expect(body).toContainText("[display only]")
    const on = {
      story: await requestOf(made.story.id, made.sent.slotId),
      workshop: await requestOf(made.workshop.id, made.asked.slotId)
    }
    expect(on.story).toBe(off.story)
    expect(on.workshop).toBe(off.workshop)
    expect(on.story).not.toContain("[display only]")
    expect(on.story).not.toContain("Rewritten")
    await admin((api) => api.DisablePlugin({ scope: "user", id }))
    expect(await requestOf(made.story.id, made.sent.slotId)).toBe(off.story)
    expect(await requestOf(made.workshop.id, made.asked.slotId)).toBe(off.workshop)
  })
