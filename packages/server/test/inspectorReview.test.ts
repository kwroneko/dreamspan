import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import { Worker } from "node:worker_threads"
import { databaseFile } from "../src/db/connection.ts"
import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Effect, Layer } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig, posted } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
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
        [
          "id",
          "estimatedInput",
          "status",
          "startedAt",
          "firstTokenAt",
          "endedAt",
          "counts",
          "usageSource",
          "cost"
        ].sort()
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
      const direct = (yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })).warmth
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
  it.live("switching to a model with no TTL keeps the rewrite estimate", () => {
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
      const result = (yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })).warmth
      assert.isNull(result!.ttlS)
      assert.match(result!.changed!.reason, /model changed/)
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
    const after = (yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })).warmth
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

it.live("Responses inspection and warmth use the final SDK role after reasoning changes", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_req, res) =>
          sse(
            res,
            [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg_1", role: "assistant", content: [] }
              },
              { type: "response.output_text.delta", output_index: 0, delta: "Synthetic answer." },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "message",
                  id: "msg_1",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Synthetic answer." }]
                }
              },
              {
                type: "response.completed",
                response: {
                  id: "resp_1",
                  status: "completed",
                  model: "mock-model",
                  output: [],
                  usage: { input_tokens: 120, output_tokens: 6, input_tokens_details: { cached_tokens: 100 } }
                }
              }
            ],
            { done: false }
          )
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { chat, model, events } = yield* generateReply(api, {
      connection: { kind: "openai-responses", baseUrl: mock.url + "/v1", apiKey: "synthetic-key", cacheTtlS: 300 },
      model: { reasoning: false }
    })
    const me = yield* api.Whoami()
    const reader = yield* Reader
    const before = (yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })).warmth
    const reasoning = yield* api.EditModel({
      modelId: model.id,
      expectedRowVersion: model.rowVersion,
      overrides: { reasoning: true }
    })
    const after = (yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })).warmth
    const current = yield* api.GetChat({ chatId: chat.id })
    const { entry } = yield* posted(
      api.Generate({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
    )
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    const run = yield* api.GetRunContext({ versionId: entry.version.id })
    const bodies = mock
      .requests()
      .filter((r) => r.path.endsWith("/responses"))
      .map((r) => r.body)
    assert.isNull(before?.changed)
    assert.isTrue(run.messages.every((m) => m.sources.length > 0))
    assert.deepEqual(
      { shown: run.messages[0]!.role, changed: after?.changed !== null },
      { shown: (bodies.at(-1)!.input as Array<{ role: string }>)[0]!.role, changed: true }
    )
    const sent = bodies.at(-1)!.input as Array<{ role: string; content: string | Array<{ text: string }> }>
    assert.deepEqual(
      run.messages.map((m) => ({ role: m.role, content: m.content })),
      sent.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("\n")
      }))
    )
    const matched = (yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })).warmth
    assert.isNull(matched?.changed, "the next reasoning request matches the captured developer prefix")
    yield* api.EditModel({
      modelId: model.id,
      expectedRowVersion: reasoning.rowVersion,
      overrides: { reasoning: true, compat: { supportsDeveloperRole: false } }
    })
    assert.isNotNull((yield* reader.CacheWarmth({ userId: me.id, chatId: chat.id })).warmth!.changed)
    assert.equal(
      (yield* api.GetRunContext({ versionId: entry.version.id })).messages[0]!.role,
      "developer",
      "editing capabilities never changes the historical sent mapping"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("malformed legacy snapshot issues remain inspectable over RPC", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_req, res) =>
          sse(res, completionChunks(["Synthetic answer."], { prompt_tokens: 10, completion_tokens: 2 }))
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { version } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url + "/v1" },
      model: {}
    })
    // Exactly the post-0013 state for an otherwise valid pre-0013 snapshot with bad issues:
    // migration leaves context_snapshot_json untouched and backfills context_issues_json=null.
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(
            `
      const {DatabaseSync} = require('node:sqlite');
      const {workerData} = require('node:worker_threads');
      const db = new DatabaseSync(workerData);
      // The server's writer may be in a transaction: wait for it rather than fail.
      db.exec('PRAGMA busy_timeout = 5000');
      try {
        const row = db.prepare('SELECT rollout_id, context_snapshot_json FROM rollout_payloads LIMIT 1').get();
        const snapshot = JSON.parse(row.context_snapshot_json);
        snapshot.issues = 'not an array';
        db.prepare('DELETE FROM rollout_payloads WHERE rollout_id=?').run(row.rollout_id);
        db.prepare('INSERT INTO rollout_payloads(rollout_id,context_snapshot_json) VALUES(?,?)').run(row.rollout_id, JSON.stringify(snapshot));
        db.exec('UPDATE rollouts SET context_issues_json=NULL');
      } finally { db.close(); }
    `,
            { eval: true, workerData: databaseFile(config.dataDir) }
          )
          worker.once("error", reject)
          worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fixture worker exited ${code}`))))
        })
    )
    const result = yield* api.GetRunContext({ versionId: version.id }).pipe(Effect.exit)
    if (result._tag === "Success") {
      assert.deepEqual(result.value.issues, [])
      assert.equal(result.value.capture, "unavailable")
      assert.deepEqual(result.value.messages, [])
    }
    assert.equal(result._tag, "Success")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("inspection captures the final transformed payload and scrubs request secrets", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const provider = yield* mock()
    const registry = yield* ProviderRegistry
    const key = "sk-synthetic-payload-key"
    yield* registry.transforms.register({
      id: "synthetic-message-transform",
      appliesTo: (target) => target.api === "openai-completions",
      transform: (payload) => {
        const messages = payload.messages as Array<{ role: string; content: string }>
        messages[0] = { ...messages[0]!, role: "developer", content: messages[0]!.content + " " + key }
        return { ...payload, headers: { authorization: key }, private_field: key }
      }
    })
    const api = yield* client()
    const { version } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: provider.url + "/v1", apiKey: key },
      model: {}
    })
    assert.equal(version.status, "complete")
    const run = yield* api.GetRunContext({ versionId: version.id })
    const sent = provider.requests().find((r) => r.path.endsWith("/chat/completions"))!.body!.messages as Array<{
      role: string
      content: string
    }>
    assert.equal(run.messages[0]!.role, sent[0]!.role)
    assert.equal(run.messages[0]!.content, sent[0]!.content.replaceAll(key, "[redacted]"))
    assert.isAbove(run.messages[0]!.sources.length, 0)
    assert.notInclude(JSON.stringify(run), key)
    assert.notInclude(JSON.stringify(run), "private_field")
    assert.notInclude(JSON.stringify(run), "authorization")
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})
