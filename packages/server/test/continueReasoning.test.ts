// Continue and reasoning (DESIGN §7.4, §7.5) through real generation: a mock OpenAI-compatible
// provider streams reasoning beside its text, which is kept on the version and never sent
// back; Continue sends the reply as the start of the next one (a prefill) and keeps the old
// version as it was; a model that takes no prefill makes Continue fail saying so.
import { assert, describe, it } from "@effect/vitest"
import type { Version } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finish }]
})

const usage = {
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 10
  }
}

type Message = { readonly role: string; readonly content: string }
const messagesOf = (request: Recorded) => (request.body as { messages: ReadonlyArray<Message> }).messages

/** Reasoning first, then the reply; asked to continue (a trailing assistant message), more of both. */
const provider = (request: Recorded, res: Parameters<typeof sse>[0]) => {
  const continuing = messagesOf(request).at(-1)?.role === "assistant"
  sse(
    res,
    continuing
      ? [
          chunk({ role: "assistant", reasoning_content: "Finish the thought." }),
          chunk({ content: " and the tide" }),
          chunk({ content: " is late." }),
          chunk({}, "stop"),
          usage
        ]
      : [
          chunk({ role: "assistant", reasoning_content: "Mira is wary; " }),
          chunk({ reasoning_content: "keep it short." }),
          chunk({ content: "The ledger says" }),
          chunk({ content: " otherwise," }),
          chunk({}, "stop"),
          usage
        ]
  )
}

describe("continue and reasoning", () => {
  it.live("keeps streamed reasoning on the version and continues a reply through a prefill", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(provider)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "assistant" }
      })
      assert.strictEqual(version.status, "complete")
      assert.strictEqual(version.content, "The ledger says otherwise,")
      assert.strictEqual(version.reasoning, "Mira is wary; keep it short.")
      // Streamed live, apart from the text.
      const streamed = events.flatMap((e) => (e._tag === "Reasoning" && e.versionId === version.id ? [e.text] : []))
      assert.strictEqual(streamed.join(""), "Mira is wary; keep it short.")

      // The next request offers Continue: the model takes a prefill.
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.strictEqual(next.model?.prefill, "assistant")

      const window = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const reply = window.entries.at(-1)!
      assert.strictEqual(reply.version.reasoning, "Mira is wary; keep it short.")
      const continued = yield* api.ContinueVersion({ versionId: version.id, expectedRowVersion: reply.rowVersion })
      assert.strictEqual(continued.version.status, "generating")
      assert.strictEqual(continued.version.sourceVersionId, version.id)
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done: Version = finished(events, continued.version.id)!
      assert.strictEqual(done.status, "complete")
      assert.strictEqual(done.content, "The ledger says otherwise, and the tide is late.")
      assert.strictEqual(done.reasoning, "Mira is wary; keep it short.\n\nFinish the thought.")
      // The deltas went on from the end of the text continued.
      const delta = events.find((e) => e._tag === "Delta" && e.versionId === continued.version.id)
      assert.strictEqual(delta?._tag === "Delta" ? delta.offset : -1, "The ledger says otherwise,".length)

      // The request: the reply as the start of the next one, after the user's message. No
      // reasoning goes back to the model.
      const sent = mock.requests().filter((r) => r.path === "/v1/chat/completions")
      assert.strictEqual(sent.length, 2)
      const messages = messagesOf(sent[1]!)
      assert.deepStrictEqual(messages.slice(-2), [
        { role: "user", content: "The road flooded." },
        { role: "assistant", content: "The ledger says otherwise," }
      ])
      for (const request of sent) assert.notInclude(JSON.stringify(request.body), "wary")

      // Both versions stay: the one continued as it was.
      const versions = yield* api.ListVersions({ slotId: reply.slotId })
      assert.deepStrictEqual(
        versions.map((v) => v.content),
        ["The ledger says otherwise,", "The ledger says otherwise, and the tide is late."]
      )

      // The inspector shows the prefill as the message continued.
      const run = yield* api.GetRunContext({ versionId: continued.version.id })
      assert.strictEqual(run.type, "continue")
      const last = run.messages.at(-1)!
      assert.strictEqual(last.role, "assistant")
      assert.strictEqual(last.content, "The ledger says otherwise,")
      assert.match(last.sources[0]!.label, /^Message 3 as it was, continued from its end$/)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("continues through Anthropic's trailing assistant message and preserves whitespace in storage", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            anthropicSse(res, [
              {
                type: "message_start",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "mock-model",
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 10, output_tokens: 1 }
                }
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The tide.  " } },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 3 }
              },
              { type: "message_stop" }
            ])
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-synthetic-only" },
        model: { prefill: "assistant" }
      })
      assert.strictEqual(version.content, "The tide.  ")
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      assert.strictEqual(continued.version.content, version.content)
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      assert.strictEqual(finished(events, continued.version.id)!.content, "The tide.  The tide.  ")
      const sent = mock.requests().filter((r) => r.path.startsWith("/v1/messages"))
      const last = (
        sent[1]!.body as { messages: Array<{ role: string; content: Array<{ text: string }> }> }
      ).messages.at(-1)!
      assert.strictEqual(last.role, "assistant")
      assert.strictEqual(last.content.at(-1)!.text, "The tide.")
      const captured = yield* api.GetRunContext({ versionId: continued.version.id })
      assert.strictEqual(captured.messages.at(-1)!.content, "The tide.")
      // Concurrent clicks use the slot row version and cannot replace another selection.
      const stale = yield* Effect.flip(
        api.ContinueVersion({ versionId: version.id, expectedRowVersion: path.entries.at(-1)!.rowVersion })
      )
      assert.strictEqual(stale._tag, "StaleWrite")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("fails a continuation with a model that takes no prefill, and says so", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(provider)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.strictEqual(next.model?.prefill, "none")
      const window = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const reply = window.entries.at(-1)!
      const continued = yield* api.ContinueVersion({ versionId: version.id, expectedRowVersion: reply.rowVersion })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.status, "failed")
      assert.strictEqual(done.error?.class, "no_prefill")
      assert.include(done.error?.message ?? "", "Continue isn't available with mock-model")
      // Only the first reply reached the provider.
      assert.strictEqual(mock.requests().filter((r) => r.path === "/v1/chat/completions").length, 1)

      // Only a finished model-written version with text can be continued.
      const user = window.entries.at(-2)!
      const refused = yield* Effect.flip(
        api.ContinueVersion({ versionId: user.version.id, expectedRowVersion: user.rowVersion })
      )
      assert.strictEqual(refused._tag, "NotContinuable")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
