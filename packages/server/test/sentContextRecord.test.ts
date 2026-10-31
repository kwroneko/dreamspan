// The record of what a reply sent (ARCHITECTURE §15, "The sent provider mapping"): its write is
// queued before the HTTP request but not waited for, so it isn't stopped with the request. A
// reply stopped once its request reached the provider, before any answer, keeps it.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

it.live("a reply stopped while its provider hasn't answered keeps the record of what it sent", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_request, res) =>
          sse(res, completionChunks(["Noted."], { prompt_tokens: 40, completion_tokens: 2 }))
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { chat, events, version } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {}
    })
    const completions = () => mock.requests().filter((r) => r.path === "/v1/chat/completions")
    // The next request reaches the provider, which never answers.
    mock.setHandler(() => new Promise<void>(() => {}))
    const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
    yield* eventually(() => completions().length === 2)
    yield* api.StopGeneration({ versionId: entry.version.id })
    yield* eventually(() => finished(events, entry.version.id)?.status === "stopped")
    const body = completions()[1]!.body!
    // Committed beside the request; read until it shows.
    let run = yield* api.GetRunContext({ versionId: entry.version.id })
    for (let i = 0; run.capture !== "captured" && i < 100; i++) {
      yield* Effect.sleep("50 millis")
      run = yield* api.GetRunContext({ versionId: entry.version.id })
    }
    assert.strictEqual(run.capture, "captured")
    assert.deepStrictEqual(
      run.messages.map((m) => ({ role: m.role, content: m.content })),
      body.messages
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
