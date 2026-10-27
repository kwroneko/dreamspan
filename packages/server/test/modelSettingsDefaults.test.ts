// A model with no generation settings of its own: its response length defaults within its
// reported limits, so neither the history budget nor a schema continuation is used up by it.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const provider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((request, res) => {
      const tool = (
        request.body as { tools?: Array<{ parameters: { properties: { text: { description: string } } } }> }
      ).tools?.[0]
      if (!request.path.endsWith("/responses") || !tool)
        return request.path.endsWith("/responses")
          ? sse(res, [
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
                  id: "r1",
                  status: "completed",
                  model: "m",
                  output: [],
                  usage: { input_tokens: 2, output_tokens: 2 }
                }
              }
            ])
          : sse(res, completionChunks(["The ledger says otherwise."], { prompt_tokens: 20, completion_tokens: 5 }))
      const args = JSON.stringify({ text: tool.parameters.properties.text.description + " More." })
      const call = { type: "function_call", id: "fc_1", call_id: "c1", name: "continue_reply", arguments: args }
      return sse(res, [
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: args },
        { type: "response.function_call_arguments.done", output_index: 0, arguments: args },
        { type: "response.output_item.done", output_index: 0, item: call },
        {
          type: "response.completed",
          response: {
            id: "r2",
            status: "completed",
            model: "m",
            output: [call],
            usage: { input_tokens: 2, output_tokens: 2 }
          }
        }
      ])
    })
  ),
  (mock) => Effect.promise(() => mock.close())
)

describe("model settings defaults", () => {
  it.live("a model whose output limit equals its context still leaves room for the history", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* provider
      const api = yield* client()
      const { chat, model, version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      yield* api.EditModel({
        modelId: model.id,
        expectedRowVersion: model.rowVersion,
        overrides: { context: 16000, maxOutput: 16000 }
      })
      const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const done = finished(events, entry.version.id)!
      assert.strictEqual(done.status, "complete", done.error?.message)
      const sent = mock.requests().at(-1)!.body as { max_tokens?: number; max_completion_tokens?: number }
      const maxTokens = sent.max_tokens ?? sent.max_completion_tokens!
      assert.isAtMost(maxTokens, 4096)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a context size set on the model bounds the default response length", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* provider
      const api = yield* client()
      const { chat, model, version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      // A small local model: no reported window, the user sets its context size and nothing else.
      yield* api.EditModel({
        modelId: model.id,
        expectedRowVersion: model.rowVersion,
        overrides: { settings: { samplers: { openai_max_context: 4096 } } }
      })
      const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const done = finished(events, entry.version.id)!
      assert.strictEqual(done.status, "complete", done.error?.message)
      const sent = mock.requests().at(-1)!.body as { max_tokens?: number; max_completion_tokens?: number }
      assert.isAtMost(sent.max_tokens ?? sent.max_completion_tokens!, 2048)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // 4096: the default response length alone fills the limit, so it gives way to the source prefix.
  for (const maxOutput of [32000, 4096])
    it.live(`a schema continuation fits a ${maxOutput}-token output limit with no response length set`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* provider
        const api = yield* client()
        const { chat, model, version, events } = yield* generateReply(api, {
          connection: { kind: "openai-responses", baseUrl: `${mock.url}/v1`, apiKey: "sk-synthetic" },
          model: { prefill: "tool_schema" }
        })
        yield* api.EditModel({
          modelId: model.id,
          expectedRowVersion: model.rowVersion,
          overrides: { prefill: "tool_schema", context: 128000, maxOutput }
        })
        const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
        const continued = yield* api.ContinueVersion({
          versionId: version.id,
          expectedRowVersion: path.entries.at(-1)!.rowVersion
        })
        yield* eventually(() => finished(events, continued.version.id) !== undefined)
        const done = finished(events, continued.version.id)!
        assert.strictEqual(done.status, "complete", done.error?.message)
        assert.strictEqual(done.content, version.content + " More.")
        const sent = mock.requests().at(-1)!.body as { max_output_tokens?: number }
        assert.isAtMost(sent.max_output_tokens!, maxOutput)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })
})
