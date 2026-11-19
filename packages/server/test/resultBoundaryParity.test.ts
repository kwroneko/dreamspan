// Cross-revision capture catalogue. RESULT_PARITY_OUTPUT writes synthetic wire bodies only.
// This fixture also runs on master; no boundary helper is imported here.
import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { writeFileSync } from "node:fs"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const captures: Record<string, unknown> = {}
const call = (id: string, name: string, args: unknown) => [
  {
    id: "fixture",
    object: "chat.completion.chunk",
    model: "mock-model",
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
    id: "fixture",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]
const anthropic = (tool?: { id: string; name: string; input: unknown }) => [
  {
    type: "message_start",
    message: {
      id: "fixture",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: tool ? { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "" }
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) }
      : { type: "text_delta", text: "Ready." }
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" }
]

for (const scenario of [
  "story-plain",
  "story-tools",
  "workshop-every",
  "workshop-dispatcher",
  "workshop-native"
] as const)
  it.live(`captures unchanged prefix and story bytes: ${scenario}`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const native = scenario === "workshop-native"
      const workshop = scenario.startsWith("workshop")
      let active = !workshop
      const script = workshop
        ? [
            ...(scenario === "workshop-every" ? [] : [["tool_search", { query: "select:read_card" }] as const]),
            ["read_card", { card: "Assistant" }] as const
          ]
        : scenario === "story-tools"
          ? ([
              ["read_messages", { from: 1 }],
              ["search_chat", { query: "Mira" }],
              ["read_run", { message: 0 }]
            ] as const)
          : []
      let calls = 0
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => {
            const next = active ? script[calls++] : undefined
            let name: string | undefined = next?.[0],
              args: unknown = next?.[1]
            if (name === "read_card" && scenario === "workshop-dispatcher") {
              args = { name, arguments: JSON.stringify(args) }
              name = "call_tool"
            }
            if (native) anthropicSse(res, anthropic(name ? { id: `call_${calls}`, name, input: args } : undefined))
            else sse(res, name ? call(`call_${calls}`, name, args) : completionChunks(["Ready."], {}))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: {
          kind: native ? "anthropic" : "openai-chat",
          baseUrl: native ? mock.url : `${mock.url}/v1`,
          apiKey: "synthetic-key",
          providerSettings: {
            toolLoading:
              scenario === "workshop-dispatcher" ? "dispatcher" : scenario === "workshop-every" ? "every" : "auto"
          }
        },
        ...(native ? { modelKey: "claude-sonnet-4-5" } : {}),
        model: {},
        ...(scenario === "story-tools"
          ? {
              state: [
                { key: "agent.enabled", value: { on: true } },
                { key: "agent.tools", value: { tools: ["read_messages", "search_chat", "read_run"] } }
              ]
            }
          : {})
      })
      let bodies = mock.requests().map((r) => r.body)
      if (workshop) {
        active = true
        const start = mock.requests().length
        const chat = yield* api.CreateWorkshop({})
        const events: ChatEvent[] = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "Read the assistant card."
          })
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
        assert.strictEqual(finished(events, reply.entry.version.id)?.status, "complete")
        bodies = mock
          .requests()
          .slice(start)
          .map((r) => r.body)
      }
      assert.lengthOf(bodies, script.length + 1)
      const requests = workshop ? mock.requests().slice(-bodies.length, -1) : mock.requests()
      assert.isTrue(requests.every((request) => typeof request.raw === "string"))
      captures[scenario] = requests.map((request) => request.raw)
      if (process.env.RESULT_PARITY_OUTPUT)
        writeFileSync(process.env.RESULT_PARITY_OUTPUT, JSON.stringify(captures, null, 2))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
