// The routing actually sent, rather than the current settings, determines whether a frozen run
// can defer tools. Synthetic OpenRouter replies exercise the complete persistence/replay path.
import { assert, it } from "@effect/vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { VersionId } from "@dreamspan/shared/chat.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { LOADED_DEFINITIONS } from "../src/providers/toolLoading.ts"
import { Reader } from "../src/db/Database.ts"

type Body = {
  provider?: unknown
  tools?: Array<{ function: { name: string; defer_loading?: boolean }; cache_control?: unknown }>
  messages: Array<{ role: string; content: string; tool_call_id?: string }>
}
const call = (name: string, args: unknown, id: string) => [
  {
    id: "synthetic",
    object: "chat.completion.chunk",
    model: "anthropic/claude-sonnet-4.5",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "synthetic",
    object: "chat.completion.chunk",
    model: "anthropic/claude-sonnet-4.5",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

it.live("keeps its explicit route through mid-run edits and step Resume, then replans a fresh turn", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let release: (() => void) | undefined
    let hold = true
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          if (request.path.startsWith("/v1/messages"))
            return anthropicSse(res, [
              {
                type: "message_start",
                message: {
                  id: "direct",
                  type: "message",
                  role: "assistant",
                  model: "claude-sonnet-4-5",
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 10, output_tokens: 1 }
                }
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Direct reply." } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
              { type: "message_stop" }
            ])
          const body = request.body as unknown as Body
          if (!body?.tools?.length) return sse(res, completionChunks(["Hello."], {}))
          const last = body.messages.filter((m) => m.role === "tool").at(-1)
          const reply = () =>
            sse(
              res,
              !last
                ? call("tool_search", { query: "select:read_card" }, "load")
                : last.tool_call_id === "load"
                  ? call("read_card", { card: "Assistant" }, "read")
                  : completionChunks(["Done."], {})
            )
          if (hold) {
            hold = false
            release = reply
          } else reply()
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const pinned = { only: ["anthropic"], allow_fallbacks: false }
    const setup = yield* generateReply(api, {
      connection: { kind: "openrouter", baseUrl: mock.url, apiKey: "synthetic-key" },
      modelKey: "anthropic/claude-sonnet-4.5",
      model: { settings: { routing: pinned } }
    })
    const chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const send = (content: string) =>
      Effect.gen(function* () {
        const current = yield* api.GetChat({ chatId: chat.id })
        const sent = yield* posted(
          api.SendMessage({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false, content })
        )
        return yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      })
    const complete = (id: VersionId) =>
      Effect.gen(function* () {
        yield* eventually(() => finished(events, id) !== undefined)
        assert.strictEqual(finished(events, id)!.status, "complete", JSON.stringify(finished(events, id)!.error))
      })
    const from = mock.requests().length
    const generated = yield* send("Read the card.")
    yield* eventually(() => release !== undefined)
    const unpinned = yield* api.EditModel({
      modelId: setup.model.id,
      overrides: {},
      expectedRowVersion: setup.model.rowVersion
    })
    release!()
    yield* complete(generated.entry.version.id)
    const bodies = mock
      .requests()
      .slice(from)
      .map((r) => r.body as unknown as Body)
    assert.lengthOf(bodies, 3)
    const tools = JSON.stringify(bodies[0]!.tools)
    for (const body of bodies) {
      assert.deepStrictEqual(body.provider, pinned)
      assert.strictEqual(JSON.stringify(body.tools), tools)
    }
    assert.isTrue(bodies[0]!.tools!.find((t) => t.function.name === "read_card")!.function.defer_loading)
    assert.include(JSON.stringify(bodies[1]!.messages), LOADED_DEFINITIONS)
    assert.notInclude(JSON.stringify(bodies[2]!.messages), "isn't loaded yet")
    assert.deepStrictEqual(
      bodies[0]!.tools!.filter((t) => t.cache_control).map((t) => t.function.name),
      ["send_message"]
    )
    assert.strictEqual(
      JSON.stringify(bodies[2]!.messages.slice(0, bodies[0]!.messages.length)),
      JSON.stringify(bodies[0]!.messages)
    )

    // Resume deliberately uses the saved pin even though the model settings have changed.
    const me = yield* api.Whoami()
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: generated.entry.slotId })
    const editFrom = mock.requests().length
    const edited = yield* api.ResumeFromStep({
      versionId: generated.entry.version.id,
      step: 0,
      edit: { kind: "result", text: "Edited load." },
      expectedRowVersion: slot.entry.rowVersion
    })
    yield* complete(edited.version.id)
    const replay = mock.requests()[editFrom]!.body as unknown as Body
    assert.deepStrictEqual(replay.provider, pinned)
    assert.strictEqual(JSON.stringify(replay.tools), tools)
    assert.include(JSON.stringify(replay.messages), LOADED_DEFINITIONS)
    assert.include(JSON.stringify(replay.messages), "Edited load.")

    const nextFrom = mock.requests().length
    const next = yield* send("A fresh unpinned turn.")
    yield* complete(next.entry.version.id)
    const fresh = mock.requests()[nextFrom]!.body as unknown as Body
    assert.isUndefined(fresh.provider)
    assert.isTrue(fresh.tools!.some((t) => t.function.defer_loading))
    assert.isFalse(fresh.tools!.some((t) => t.function.name === "call_tool"))
    assert.notInclude(JSON.stringify(fresh.messages), LOADED_DEFINITIONS)

    const vertex = { only: ["google-vertex"], allow_fallbacks: false }
    yield* api.EditModel({
      modelId: setup.model.id,
      overrides: { settings: { routing: vertex } },
      expectedRowVersion: unpinned.rowVersion
    })
    const vertexFrom = mock.requests().length
    const switched = yield* send("A fresh Vertex turn.")
    yield* complete(switched.entry.version.id)
    const switchedBody = mock.requests()[vertexFrom]!.body as unknown as Body
    assert.deepStrictEqual(switchedBody.provider, vertex)
    assert.isTrue(switchedBody.tools!.some((t) => t.function.defer_loading))
    assert.notInclude(JSON.stringify(switchedBody.messages), "Edited load.")

    // Crossing APIs starts a new transcript and uses each API's own loading representation.
    yield* generateReply(api, {
      connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-synthetic-key" },
      modelKey: "claude-sonnet-4-5",
      model: {}
    })
    const directFrom = mock.requests().length
    const direct = yield* send("Use Anthropic directly.")
    yield* complete(direct.entry.version.id)
    const directBody = mock.requests()[directFrom]!.body as unknown as {
      tools: Array<{ name: string; defer_loading?: boolean }>
    }
    assert.isTrue(directBody.tools.find((t) => t.name === "read_card")!.defer_loading)
    assert.notInclude(JSON.stringify(directBody), LOADED_DEFINITIONS)
    yield* api.ChangeGenerationDefaults({
      change: { model: { connection: setup.connection.id, model: setup.model.id } }
    })
    const backFrom = mock.requests().length
    const back = yield* send("Use OpenRouter again.")
    yield* complete(back.entry.version.id)
    const backBody = mock.requests()[backFrom]!.body as unknown as Body
    assert.deepStrictEqual(backBody.provider, vertex)
    assert.isTrue(backBody.tools!.some((t) => t.function.defer_loading))
    assert.notInclude(JSON.stringify(backBody.messages), LOADED_DEFINITIONS)
    assert.notInclude(JSON.stringify(backBody.messages), "tool_reference")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
