import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { startMockProvider, completionChunks, sse, anthropicSse } from "./support/mockProvider.ts"
const mock = (echo = false) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((req, res) =>
        sse(
          res,
          completionChunks(
            ["synthetic answer"],
            { prompt_tokens: 120, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 100 } },
            echo
              ? {
                  provider: `${req.headers.authorization} ${"x".repeat(1000)}`,
                  model: `${req.headers.authorization} ${"x".repeat(1000)}`
                }
              : {}
          )
        )
      )
    ),
    (p) => Effect.promise(() => p.close())
  )
const estimates = (events: ReadonlyArray<ChatEvent>) => events.filter((e) => e._tag === "Cache")
const warm = (events: ReadonlyArray<ChatEvent>) =>
  estimates(events).findLast((e) => e.warmth !== null && e.warmth.changed === null)
describe("review reproductions", () => {
  it.live("provider echoes are scrubbed and capped in storage, and excluded from the inspector", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const provider = yield* mock(true)
      const api = yield* client()
      const key = "sk-synthetic-review-key-12345678"
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", apiKey: key },
        model: {}
      })
      const run = yield* api.GetRunContext({ versionId: version.id })
      assert.isFalse(JSON.stringify(run).includes(key), "GetRunContext must not serialize the key")
      assert.deepStrictEqual(
        Object.keys(run.requests[0]!).sort(),
        ["id", "status", "counts", "usageSource", "cost"].sort()
      )
      const ledger = (yield* api.ListLlmRequests({ limit: 10, before: null }))[0]!
      assert.isFalse(JSON.stringify(ledger).includes(key), "persisted provider metadata must be scrubbed")
      assert.include(ledger.upstream!, "[redacted]")
      assert.include(ledger.responseModel!, "[redacted]")
      assert.isAtMost(ledger.upstream!.length, 256)
      assert.isAtMost(ledger.responseModel!.length, 256)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("changing the connection origin invalidates its cached prefix", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const provider = yield* mock()
      const other = yield* mock()
      const api = yield* client()
      const { connection, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", cacheTtlS: 300 },
        model: {}
      })
      yield* eventually(() => !!warm(events))
      yield* Effect.sleep("1 second")
      const n = events.length
      yield* api.UpdateConnection({
        connectionId: connection.id,
        expectedRowVersion: connection.rowVersion,
        settings: {
          name: connection.name,
          baseUrl: other.url + "/v1",
          compat: connection.compat,
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* eventually(() => estimates(events.slice(n)).length > 0)
      const result = estimates(events.slice(n)).at(-1)!.warmth
      assert.isNotNull(result!.changed, "new server has no cache from the old server")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("deleting and restoring a connection refreshes its subscribed estimate", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const provider = yield* mock()
      const api = yield* client()
      const reader = yield* Reader
      const { chat, connection, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", cacheTtlS: 300 },
        model: {}
      })
      yield* eventually(() => !!warm(events))
      yield* Effect.sleep("1 second")
      const n = events.length
      const item = yield* api.DeleteConnection({ connectionId: connection.id })
      yield* Effect.sleep("1 second")
      const me = yield* api.Whoami()
      const direct = yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })
      assert.isNull(direct)
      assert.isTrue(
        estimates(events.slice(n)).some((e) => e.warmth === null),
        "deletion must invalidate the subscribed estimate"
      )
      const restoredAt = events.length
      yield* api.RestoreBinItem({ itemId: item.id })
      yield* eventually(() => estimates(events.slice(restoredAt)).some((e) => e.warmth !== null))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("switching to a model with no TTL must remove the estimate", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const provider = yield* mock()
      const api = yield* client()
      const reader = yield* Reader
      const { chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", cacheTtlS: 300 },
        model: {}
      })
      yield* eventually(() => !!warm(events))
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "No TTL",
          baseUrl: provider.url + "/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "mock-no-ttl", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const me = yield* api.Whoami()
      const result = yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })
      assert.isNull(result, "the next model has no TTL")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
it.live("Anthropic inspector roles and sources match the provider mapping", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const provider = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((req, res) =>
          anthropicSse(res, [
            {
              type: "message_start",
              message: {
                id: "msg_review",
                type: "message",
                role: "assistant",
                model: "mock-model",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 1 }
              }
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic reply" } },
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
      (p) => Effect.promise(() => p.close())
    )
    const api = yield* client()
    const { version } = yield* generateReply(api, {
      connection: { kind: "anthropic", baseUrl: provider.url, apiKey: "sk-ant-synthetic-review-key" },
      model: { cacheBreakpoints: "explicit" },
      preset: { use_sysprompt: false }
    })
    assert.strictEqual(version.status, "complete")
    const run = yield* api.GetRunContext({ versionId: version.id })
    const body = provider.requests().find((r) => r.path.startsWith("/v1/messages"))!.body!
    const messages = body.messages as ReadonlyArray<{
      role: string
      content: ReadonlyArray<{ type: string; text: string }>
    }>
    assert.deepStrictEqual(
      run.messages.map((m) => ({ role: m.role, content: m.content })),
      messages.map((m) => ({ role: m.role, content: m.content.map((b) => b.text).join("\n") }))
    )
    assert.isTrue(run.messages.every((m) => m.sources.length > 0))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("note deletion, restoration, purge and empty-bin refresh subscribed estimates", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const provider = yield* mock()
    const api = yield* client()
    const { events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", cacheTtlS: 300 },
      model: {}
    })
    yield* eventually(() => !!warm(events))
    const card = (yield* api.ListLibrary({ kind: "card" })).find((c) => c.label === "Mira")!
    const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Synthetic note" })
    // Let every earlier change settle before testing a dependency without a chat event.
    yield* Effect.sleep("1 second")
    let from = events.length
    const deleted = yield* api.DeleteNote({ noteRefId: note.id })
    yield* eventually(() => estimates(events.slice(from)).length > 0)
    from = events.length
    yield* api.RestoreBinItem({ itemId: deleted.id })
    yield* eventually(() => estimates(events.slice(from)).length > 0)
    const removed = yield* api.DeleteNote({ noteRefId: note.id })
    yield* Effect.sleep("1 second")
    from = events.length
    yield* api.PurgeBinItem({ itemId: removed.id })
    yield* eventually(() => estimates(events.slice(from)).length > 0)
    const another = yield* api.CreateCardNote({ cardRefId: card.id, title: "Another synthetic note" })
    const binned = yield* api.DeleteNote({ noteRefId: another.id })
    yield* Effect.sleep("1 second")
    from = events.length
    yield* api.EmptyBin({ itemIds: [binned.id] })
    yield* eventually(() => estimates(events.slice(from)).length > 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("next-model TTL eligibility does not change the historical expiry", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const provider = yield* mock()
    const api = yield* client()
    const reader = yield* Reader
    const { chat, model, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", cacheTtlS: 300 },
      model: {}
    })
    yield* eventually(() => !!warm(events))
    const before = warm(events)!.warmth!
    yield* api.EditModel({ modelId: model.id, expectedRowVersion: model.rowVersion, overrides: { cacheTtlS: 900 } })
    const me = yield* api.Whoami()
    const after = yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })
    assert.strictEqual(after!.ttlS, 900)
    assert.strictEqual(after!.expiresAt, before.lastRequestAt + 300_000)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("graph deletions refresh other open chats because bin eviction can remove their dependencies", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const provider = yield* mock()
    const api = yield* client()
    const { events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", cacheTtlS: 300 },
      model: {}
    })
    yield* eventually(() => !!warm(events))
    const other = yield* api.CreateChat({ title: "Other synthetic chat" })
    const message = yield* api.SendMessage({
      chatId: other.id,
      parentSlotId: null,
      branch: false,
      content: "Synthetic message"
    })
    assert.strictEqual(message._tag, "Posted")
    if (message._tag !== "Posted") return yield* Effect.die("Unexpected queued message")
    yield* Effect.sleep("1 second")
    let from = events.length
    yield* api.DeleteMessage({ slotId: message.entry.slotId })
    yield* eventually(() => estimates(events.slice(from)).length > 0)
    from = events.length
    yield* api.DeleteChat({ chatId: other.id })
    yield* eventually(() => estimates(events.slice(from)).length > 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
