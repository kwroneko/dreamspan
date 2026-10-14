// Durable acceptance regressions from the R4-C review. All data/providers are synthetic.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const mockProvider = (badPrefix = false) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider(async (request, res) => {
        if (!request.path.endsWith("/responses"))
          return sse(res, completionChunks(["The ledger says otherwise."], { prompt_tokens: 20, completion_tokens: 5 }))
        const body = request.body as {
          tools?: Array<{ name: string; parameters: { properties: { text: { description: string } } } }>
        }
        const tool = body.tools?.[0]
        if (tool) {
          const args = JSON.stringify({
            text:
              (badPrefix ? "Changed prefix." : tool.parameters.properties.text.description) +
              ' More "prose".\nA tide 🌊.'
          })
          const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "continue_reply", arguments: args }
          const events = [
            { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
            ...Array.from(args, (delta) => ({
              type: "response.function_call_arguments.delta",
              output_index: 0,
              delta
            })),
            { type: "response.function_call_arguments.done", output_index: 0, arguments: args },
            { type: "response.output_item.done", output_index: 0, item: call },
            {
              type: "response.completed",
              response: {
                id: "resp_2",
                status: "completed",
                model: "mock-model",
                output: [call],
                usage: { input_tokens: 20, output_tokens: 5 }
              }
            }
          ]
          res.writeHead(200, { "content-type": "text/event-stream" })
          for (const event of events) {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
            if (event.type === "response.function_call_arguments.delta")
              await new Promise<void>((resolve) => setTimeout(resolve, 12))
          }
          res.end("data: [DONE]\n\n")
          return
        }
        return sse(res, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "msg_1", role: "assistant", content: [] }
          },
          { type: "response.output_text.delta", output_index: 0, delta: "The ledger says otherwise." },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "The ledger says otherwise." }]
            }
          },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              model: "mock-model",
              output: [],
              usage: { input_tokens: 20, output_tokens: 5 }
            }
          }
        ])
      })
    ),
    (mock) => Effect.promise(() => mock.close())
  )

describe("R4-C review acceptance regressions", () => {
  it.live("keeps known prefill capability visible even when the next context exceeds its budget", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider()
      const api = yield* client()
      const { chat, model } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "assistant" }
      })
      yield* api.EditModel({
        modelId: model.id,
        expectedRowVersion: model.rowVersion,
        overrides: { prefill: "none", context: 1 }
      })
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.strictEqual(next.model?.prefill, "none", "Continue must explain the known lack of prefill support")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("marks DeepSeek's trailing assistant message as a prefix on Continue", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider()
      const api = yield* client()
      const { chat, version, events } = yield* generateReply(api, {
        connection: { kind: "deepseek", baseUrl: `${mock.url}/beta`, apiKey: "sk-synthetic-only" },
        model: { prefill: "assistant" }
      })
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const requests = mock.requests().filter((r) => r.path.endsWith("/chat/completions"))
      const body = requests.at(-1)!.body as { messages: Array<{ role: string; prefix?: boolean }> }
      assert.strictEqual(body.messages.at(-1)!.role, "assistant")
      assert.strictEqual(body.messages.at(-1)!.prefix, true, "DeepSeek requires prefix:true, even on /beta")
      assert.isTrue(body.messages.slice(0, -1).every((message) => message.prefix === undefined))
      const inspection = yield* api.GetRunContext({ versionId: continued.version.id })
      assert.strictEqual(inspection.messages.at(-1)!.prefill?.protocol, "deepseek_prefix")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("supports the task's OpenAI tool-schema prefill capability instead of rejecting it as unavailable", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider()
      const api = yield* client()
      const { chat, version, events } = yield* generateReply(api, {
        connection: { kind: "openai-responses", baseUrl: `${mock.url}/v1`, apiKey: "sk-synthetic-only" },
        model: { prefill: "tool_schema" }
      })
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.status, "complete")
      assert.strictEqual(done.content, version.content + ' More "prose".\nA tide 🌊.')
      const deltas = events.flatMap((event) =>
        event._tag === "Delta" && event.versionId === done.id ? [event.text] : []
      )
      assert.isAbove(deltas.length, 1, "schema text streams as suffix deltas")
      assert.strictEqual(deltas.join(""), ' More "prose".\nA tide 🌊.')
      const sent = mock.requests().at(-1)!.body as {
        input: unknown[]
        tools: Array<{ strict: boolean; parameters: { properties: { text: { pattern: string } } } }>
        tool_choice: unknown
        parallel_tool_calls: boolean
      }
      assert.deepStrictEqual(sent.tool_choice, { type: "function", name: "continue_reply" })
      assert.strictEqual(sent.parallel_tool_calls, false)
      assert.isAbove(
        Number((mock.requests().at(-1)!.body as { max_output_tokens: number }).max_output_tokens),
        Number((mock.requests()[0]!.body as { max_output_tokens: number }).max_output_tokens),
        "schema output must leave room for both the original prefix and new prose"
      )
      assert.strictEqual(sent.tools[0]!.strict, true)
      assert.strictEqual(sent.tools[0]!.parameters.properties.text.pattern, "^The ledger says otherwise\\.")
      const inspection = yield* api.GetRunContext({ versionId: done.id })
      assert.strictEqual(inspection.messages.at(-1)!.content, version.content)
      assert.strictEqual(inspection.messages.at(-1)!.prefill?.protocol, "tool_schema")
      assert.include(inspection.messages.at(-1)!.prefill?.schema ?? "", "pattern")
      const versions = yield* api.ListVersions({ slotId: done.slotId })
      assert.strictEqual(versions[0]!.content, version.content)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("explains DeepSeek's required beta endpoint before continuation", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider()
      const api = yield* client()
      const { chat, version, events } = yield* generateReply(api, {
        connection: { kind: "deepseek", baseUrl: `${mock.url}/v1`, apiKey: "sk-synthetic" },
        model: { prefill: "assistant" }
      })
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.include(next.model?.continueUnavailable ?? "", "/beta endpoint")
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      assert.strictEqual(finished(events, continued.version.id)!.error?.class, "no_prefill")
      assert.strictEqual(mock.requests().length, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("rejects a schema provider that changes the required prefix without corrupting the source", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider(true)
      const api = yield* client()
      const { chat, version, events } = yield* generateReply(api, {
        connection: { kind: "openai-responses", baseUrl: `${mock.url}/v1`, apiKey: "sk-synthetic" },
        model: { prefill: "tool_schema" }
      })
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.error?.class, "bad_prefill")
      assert.strictEqual(done.content, version.content)
      const versions = yield* api.ListVersions({ slotId: done.slotId })
      assert.strictEqual(versions[0]!.content, version.content)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("explains a schema continuation beyond the known output limit before dispatch", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider()
      const api = yield* client()
      const { chat, version, events } = yield* generateReply(api, {
        connection: { kind: "openai-responses", baseUrl: `${mock.url}/v1`, apiKey: "sk-synthetic" },
        model: { prefill: "tool_schema", maxOutput: 300 }
      })
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.error?.class, "budget")
      assert.include(done.error?.message ?? "", "output limit")
      assert.strictEqual(done.content, version.content)
      assert.strictEqual(mock.requests().length, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
