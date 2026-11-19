// Continue and reasoning (DESIGN §7.4, §7.5) through real generation: a mock OpenAI-compatible
// provider streams reasoning beside its text, which is kept on the version and never sent
// back; Continue sends the reply as the start of the next one (a prefill) and keeps the old
// version as it was; to a model that takes no prefill, it sends the reply as the model's own
// message and the continue nudge after it (owner, 2026-10-31).
import { assert, describe, it } from "@effect/vitest"
import type { Version } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
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
  for (const stream of [true, false]) {
    it.live(
      `retains length-cutoff text as a failure, excludes it from context and continues it (stream=${stream})`,
      () => {
        const config = testConfig()
        return Effect.gen(function* () {
          let first = true
          const mock = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startMockProvider((request, res) => {
                if (!first) return provider(request, res)
                first = false
                return sse(res, [
                  chunk({ role: "assistant", content: "Unfinished cutoff text" }),
                  chunk({}, "length"),
                  usage
                ])
              })
            ),
            (m) => Effect.promise(() => m.close())
          )
          const api = yield* client()
          const { version, chat, events } = yield* generateReply(api, {
            connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
            model: { prefill: "assistant", settings: { stream } }
          })
          assert.strictEqual(version.status, "failed")
          assert.strictEqual(version.error?.class, "length_cutoff")
          assert.include(version.error?.message ?? "", "output length limit")
          assert.strictEqual(version.content, "Unfinished cutoff text")
          // A normal next turn excludes the failed text even while it is selected.
          const generated = yield* posted(
            api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false })
          )
          yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
          assert.notInclude(JSON.stringify(mock.requests()[1]!.body), version.content)
          // Continue makes another version of the original slot and keeps the failure.
          const path = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: version.slotId,
            range: { _tag: "Bottom" },
            limit: 10
          })
          const continued = yield* api.ContinueVersion({
            versionId: version.id,
            expectedRowVersion: path.entries.at(-1)!.rowVersion
          })
          yield* eventually(() => finished(events, continued.version.id) !== undefined)
          assert.strictEqual(finished(events, continued.version.id)!.status, "complete")
          assert.strictEqual(
            finished(events, continued.version.id)!.content,
            "Unfinished cutoff text and the tide is late."
          )
          assert.strictEqual(messagesOf(mock.requests()[2]!).at(-1)!.content, version.content)
          const versions = yield* api.ListVersions({ slotId: version.slotId })
          assert.strictEqual(versions[0]!.status, "failed")
          assert.strictEqual(versions[0]!.content, version.content)
        }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
      }
    )
  }

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
      assert.deepStrictEqual(messages.slice(-3), [
        { role: "user", content: "The road flooded." },
        // ST's default group nudge ends the request right before the partial reply: Continue
        // writes as a character too.
        { role: "user", content: "[Write the next reply only as Mira.]" },
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

  it.live("continues an edited reply (a version the user wrote) into a new generated version", () => {
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
      const reply = (yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })).entries.at(-1)!
      const edited = yield* api.EditVersion({
        slotId: reply.slotId,
        sourceVersionId: version.id,
        content: "The ledger agrees,",
        expectedRowVersion: reply.rowVersion
      })
      assert.strictEqual(edited.version.writer, "human")
      const continued = yield* api.ContinueVersion({
        versionId: edited.version.id,
        expectedRowVersion: edited.rowVersion
      })
      assert.strictEqual(continued.version.writer, "model")
      assert.strictEqual(continued.version.sourceVersionId, edited.version.id)
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.status, "complete")
      assert.strictEqual(done.content, "The ledger agrees, and the tide is late.")
      // The edit went as the start of the reply.
      const sent = mock.requests().filter((r) => r.path === "/v1/chat/completions")
      assert.deepStrictEqual(messagesOf(sent.at(-1)!).at(-1), { role: "assistant", content: "The ledger agrees," })
      // The generated original and the edit stay as they were.
      const versions = yield* api.ListVersions({ slotId: reply.slotId })
      assert.deepStrictEqual(
        versions.map((v) => [v.writer, v.content]),
        [
          ["model", "The ledger says otherwise,"],
          ["human", "The ledger agrees,"],
          ["model", "The ledger agrees, and the tide is late."]
        ]
      )
      // Metrics: the continuation counts the reply it was continued from (through the edit),
      // the edit has none of its own, the original only its request.
      const metrics = yield* api.GetVersionMetrics({ versionIds: versions.map((v) => v.id) })
      const of = (id: string) => metrics.find((m) => m.versionId === id)
      assert.strictEqual(metrics.length, 2)
      assert.strictEqual(of(edited.version.id), undefined)
      assert.strictEqual(of(version.id)!.requests, 1)
      assert.strictEqual(of(version.id)!.output, 10)
      const total = of(continued.version.id)!
      assert.strictEqual(total.requests, 2)
      assert.strictEqual(total.output, 20)
      assert.strictEqual(total.outputUnknown, 0)
      assert.isFalse(total.running)
      assert.isFalse(total.estimated)
      assert.strictEqual(total.last.output, 10)
      assert.isNotNull(total.last.firstTokenAt)
      assert.isAtLeast(total.elapsedMs!, total.last.endedAt! - total.last.startedAt)
      // The inspector's usage carries the request's times.
      const run = yield* api.GetRunContext({ versionId: continued.version.id })
      assert.strictEqual(run.requests[0]!.startedAt, total.last.startedAt)
      assert.strictEqual(run.requests[0]!.endedAt, total.last.endedAt)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("retains the original generation metrics through more than 64 edits", () => {
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
      let entry = (yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })).entries.at(-1)!
      for (let n = 0; n < 65; n++) {
        entry = yield* api.EditVersion({
          slotId: entry.slotId,
          sourceVersionId: entry.version.id,
          content: `Edit ${n},`,
          expectedRowVersion: entry.rowVersion
        })
      }
      const continued = yield* api.ContinueVersion({
        versionId: entry.version.id,
        expectedRowVersion: entry.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const metrics = yield* api.GetVersionMetrics({ versionIds: [version.id, entry.version.id, continued.version.id] })
      assert.isUndefined(metrics.find((m) => m.versionId === entry.version.id))
      assert.strictEqual(metrics.find((m) => m.versionId === continued.version.id)!.requests, 2)
      assert.strictEqual(metrics.find((m) => m.versionId === continued.version.id)!.output, 20)
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

  it.live("continues with a model that takes no prefill: the reply as its own message, the nudge after it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // Asked to continue without a prefill, the model writes only what follows, with no space of its own.
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) =>
            messagesOf(request).at(-1)?.content.startsWith("[Continue your last message")
              ? sse(res, [
                  chunk({ role: "assistant", reasoning_content: "Finish the thought." }),
                  chunk({ content: "and the tide" }),
                  chunk({ content: " is late." }),
                  chunk({}, "stop"),
                  usage
                ])
              : provider(request, res)
          )
        ),
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
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: reply.rowVersion,
        direction: "Mira hesitates."
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.status, "complete")
      // Appended to the reply, a space between (the preset's continue_postfix, ST's default).
      assert.strictEqual(done.content, "The ledger says otherwise, and the tide is late.")
      assert.strictEqual(done.reasoning, "Mira is wary; keep it short.\n\nFinish the thought.")
      const delta = events.find((e) => e._tag === "Delta" && e.versionId === continued.version.id)
      assert.strictEqual(delta?._tag === "Delta" ? delta.offset : -1, "The ledger says otherwise,".length)

      // The request: the reply so far as the model's own last message, then the end-of-request
      // instruction, the continue nudge with the direction, last (owner, 2026-10-31).
      const sent = mock.requests().filter((r) => r.path === "/v1/chat/completions")
      assert.strictEqual(sent.length, 2)
      assert.deepStrictEqual(messagesOf(sent[1]!).slice(-3), [
        { role: "user", content: "The road flooded." },
        { role: "assistant", content: "The ledger says otherwise," },
        {
          role: "user",
          content:
            "[Continue your last message without repeating its original content.]\n[What happens next: Mira hesitates.]"
        }
      ])
      assert.notInclude(JSON.stringify(sent[1]!.body), "Write the next reply only as Mira")
      for (const request of sent) assert.notInclude(JSON.stringify(request.body), "wary")

      // The inspector shows both: the message continued and the nudge, by the editor's label.
      const run = yield* api.GetRunContext({ versionId: continued.version.id })
      assert.strictEqual(run.type, "continue")
      const [partial, last] = run.messages.slice(-2)
      assert.strictEqual(partial!.role, "assistant")
      assert.strictEqual(partial!.sources[0]!.label, "Message 3")
      assert.strictEqual(last!.role, "user")
      assert.deepStrictEqual(
        last!.sources.map((s) => s.label),
        ["End of request: when you continue a reply", "End of request: when you give guidance"]
      )
      assert.isNull(partial!.prefill ?? null)
      assert.isFalse(run.issues.some((issue) => issue.kind === "prefill_dropped"))

      // The model is unchanged, and both versions stay.
      assert.strictEqual((yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })).model?.prefill, "none")
      const versions = yield* api.ListVersions({ slotId: reply.slotId })
      assert.deepStrictEqual(
        versions.map((v) => v.content),
        ["The ledger says otherwise,", "The ledger says otherwise, and the tide is late."]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("refuses to continue a version with no text", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(provider)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      // Only a finished version with text can be continued.
      const now = (yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })).entries.at(-1)!
      const blank = yield* api.EditVersion({
        slotId: now.slotId,
        sourceVersionId: now.version.id,
        content: "  ",
        expectedRowVersion: now.rowVersion
      })
      const refused = yield* Effect.flip(
        api.ContinueVersion({ versionId: blank.version.id, expectedRowVersion: blank.rowVersion })
      )
      assert.strictEqual(refused._tag, "NotContinuable")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
