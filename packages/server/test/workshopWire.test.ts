// Synthetic wire replays, including opaque reasoning metadata: no provider is contacted.
import { assert, it } from "@effect/vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const reasoning = [
  { type: "reasoning.encrypted", id: "reason_1", data: "opaque-reasoning", format: "anthropic-claude-v1", index: 0 }
]
for (const kind of ["openrouter", "openai-responses", "google"] as const)
  it.live(`${kind}: preserves the whole carried wire prefix and signed tool reasoning`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let serial = 0
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const body = request.body!
            const key = kind === "openai-responses" ? "input" : kind === "google" ? "contents" : "messages"
            const messages = body[key] as Array<Record<string, unknown>>
            const tools = body.tools as Array<unknown> | undefined
            const last = messages.at(-1)!
            const answered =
              kind === "google"
                ? JSON.stringify(last).includes("functionResponse")
                : kind === "openai-responses"
                  ? last.type === "function_call_output"
                  : last.role === "tool"
            const useTool = (tools?.length ?? 0) > 0 && !answered
            const n = ++serial
            if (kind === "google")
              return sse(
                res,
                [
                  {
                    candidates: [
                      {
                        content: {
                          role: "model",
                          parts: useTool
                            ? [
                                { text: "Plan.", thought: true, thoughtSignature: "c2lnbmVkLXRob3VnaHQ=" },
                                {
                                  functionCall: { id: `g_${n}`, name: "read_card", args: { card: "Assistant" } },
                                  thoughtSignature: "c2lnbmVkLWNhbGw="
                                }
                              ]
                            : [{ text: "Done." }]
                        },
                        finishReason: "STOP"
                      }
                    ]
                  }
                ],
                { done: false }
              )
            if (kind === "openrouter")
              return sse(
                res,
                useTool
                  ? [
                      {
                        id: `c_${n}`,
                        object: "chat.completion.chunk",
                        model: "anthropic/claude-sonnet-4",
                        choices: [
                          {
                            index: 0,
                            delta: {
                              role: "assistant",
                              reasoning_details: reasoning,
                              tool_calls: [
                                {
                                  index: 0,
                                  id: `r_${n}`,
                                  type: "function",
                                  function: { name: "read_card", arguments: '{"card":"Assistant"}' }
                                }
                              ]
                            },
                            finish_reason: null
                          }
                        ]
                      },
                      {
                        id: `c_${n}`,
                        object: "chat.completion.chunk",
                        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
                      }
                    ]
                  : completionChunks(["Done."], {})
              )
            const item = useTool
              ? {
                  type: "function_call",
                  id: `fc_${n}`,
                  call_id: `call_${n}`,
                  name: "read_card",
                  arguments: '{"card":"Assistant"}'
                }
              : {
                  type: "message",
                  id: `msg_${n}`,
                  role: "assistant",
                  content: [{ type: "output_text", text: "Done.", annotations: [] }]
                }
            const thought = {
              type: "reasoning",
              id: `rs_${n}`,
              summary: [{ type: "summary_text", text: "Plan." }],
              encrypted_content: "opaque-responses"
            }
            const output = useTool ? [thought, item] : [item]
            const events: Array<unknown> = []
            for (const [i, part] of output.entries()) {
              events.push({
                type: "response.output_item.added",
                output_index: i,
                item: part.type === "message" ? { ...part, content: [] } : part
              })
              if (part.type === "message")
                events.push({ type: "response.output_text.delta", output_index: i, content_index: 0, delta: "Done." })
              events.push({ type: "response.output_item.done", output_index: i, item: part })
            }
            events.push({
              type: "response.completed",
              response: {
                id: `resp_${n}`,
                status: "completed",
                model: "mock-model",
                output,
                usage: { input_tokens: 20, output_tokens: 5 }
              }
            })
            sse(res, events)
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind, baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey:
          kind === "google" ? "gemini-2.5-pro" : kind === "openrouter" ? "anthropic/claude-sonnet-4" : "mock-model",
        model: { cacheBreakpoints: "explicit" },
        preset: { openai_max_context: 32768 }
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
          const user = yield* posted(
            api.SendMessage({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false, content })
          )
          const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: user.entry.slotId, branch: false }))
          yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
          assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
          return reply
        })
      yield* send("First request.")
      const previous = mock.requests().at(-1)!.body!
      const key = kind === "openai-responses" ? "input" : kind === "google" ? "contents" : "messages"
      assert.include(
        JSON.stringify(previous[key]),
        kind === "openrouter" ? "opaque-reasoning" : kind === "google" ? "c2lnbmVkLWNhbGw=" : "opaque-responses",
        "opaque provider replay metadata survives the first tool round trip"
      )
      const before = mock.requests().length
      const second = yield* send("New user request.")
      const next = mock.requests()[before]!.body!
      const prefix = previous[key] as Array<unknown>
      assert.strictEqual(
        JSON.stringify((next[key] as Array<unknown>).slice(0, prefix.length)),
        JSON.stringify(prefix),
        "provider cache prefix bytes"
      )
      assert.include(JSON.stringify(next[key]), "New user request.")
      const run = yield* api.GetRunContext({ versionId: second.entry.version.id })
      assert.isDefined(run.continuity?.parentVersionId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

it("does not replay a model's encrypted reasoning when regeneration switches models", async () => {
  const { rolloutRequest } = await import("../src/agent/wire.ts")
  const prefix = { context: { messages: [] }, payload: { messages: [] }, breakpoints: [] }
  const messages = [
    {
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "original-model",
      content: [
        { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
        { type: "toolCall", id: "call_1", name: "read_card", arguments: { card: "Assistant" } }
      ],
      timestamp: 1,
      stopReason: "toolUse"
    }
  ] as Array<import("@earendil-works/pi-ai").Message>
  const options = {
    replayReasoning: true,
    reasoningTarget: { api: "openai-completions", kind: "openrouter", key: "different-model" }
  }
  const switched = rolloutRequest(prefix, "openai-completions", messages, undefined, options)
  assert.notInclude(JSON.stringify(switched.payload), "opaque-reasoning")
  const original = rolloutRequest(prefix, "openai-completions", messages, undefined, {
    ...options,
    reasoningTarget: { ...options.reasoningTarget, key: "original-model" }
  })
  assert.include(JSON.stringify(original.payload), "opaque-reasoning")
})
