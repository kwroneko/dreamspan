import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Reader } from "../src/db/Database.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import * as Builtins from "../src/providers/builtins.ts"
import { client, serverLayer, testConfig, posted } from "./support/config.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks } from "./support/mockProvider.ts"

const resource = (handler: Parameters<typeof startMockProvider>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

for (const scenario of ["empty", "raw", "after-output"] as const)
  it.live(`Google ${scenario} errors preserve retry boundaries and credential scrubbing`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let calls = 0
      const key = "synthetic-review-key"
      const mock = yield* resource((_req, res) => {
        calls++
        if (calls === 1) {
          res.writeHead(200, { "content-type": "text/event-stream" })
          if (scenario === "after-output")
            res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Started" }] } }] })}\n\n`)
          if (scenario !== "empty")
            res.write(
              `${scenario === "after-output" ? "data: " : ""}${JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: `Synthetic overloaded ${key}` } })}${scenario === "after-output" ? "\n\n" : ""}`
            )
          res.end()
          return
        }
        sse(res, [{ candidates: [{ content: { parts: [{ text: "Recovered" }] }, finishReason: "STOP" }] }], {
          done: false
        })
      })
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: { kind: "google", baseUrl: mock.url, apiKey: key },
        model: {}
      })
      assert.equal(calls, scenario === "after-output" ? 1 : 2)
      assert.equal(reply.version.status, scenario === "after-output" ? "failed" : "complete")
      assert.notInclude(JSON.stringify(reply.events), key)
      const ledger = yield* api.ListLlmRequests({ limit: 5, before: null })
      assert.notInclude(JSON.stringify(ledger), key)
      if (scenario === "after-output") assert.equal(reply.version.error?.class, "overloaded")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

for (const override of ["none", "model", "connection"] as const)
  it.live(`Azure unknown post-transform policy respects ${override} user overrides`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) =>
        sse(
          res,
          completionChunks(["Synthetic answer"], {
            prompt_tokens: 120,
            completion_tokens: 6,
            prompt_tokens_details: { cached_tokens: 100 }
          })
        )
      )
      const registry = yield* ProviderRegistry
      yield* registry.kinds.register({
        ...registry.kinds.get("openai-chat")!,
        id: "azure",
        piProvider: "azure",
        catalog: async () => ({})
      })
      yield* registry.transforms.register({
        id: "review-extended",
        appliesTo: () => true,
        transform: (p) => ({ ...p, prompt_cache_retention: "24h" })
      })
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: {
          kind: "azure",
          baseUrl: mock.url,
          apiKey: "synthetic-review-key",
          ...(override === "connection" ? { cacheTtlS: 777 } : {})
        },
        model: override === "model" ? { cacheTtlS: 888 } : {},
        modelKey: "gpt-5.4"
      })
      assert.equal(reply.version.status, "complete")
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
      assert.equal(mock.requests().at(-1)!.body!.prompt_cache_retention, "24h")
      if (override === "none") assert.isNull(warmth)
      else assert.equal(warmth?.ttlS, override === "model" ? 888 : 777)
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
  })

for (const edit of ["model", "connection", "policy"] as const)
  it.live(`A fixed cache keeps the write TTL across ${edit} edits and repeated hits`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let hit = false
      const mock = yield* resource((_req, res) =>
        sse(
          res,
          completionChunks(["Synthetic answer"], {
            prompt_tokens: 120,
            completion_tokens: 6,
            prompt_tokens_details: { cached_tokens: hit ? 100 : 0 }
          })
        )
      )
      const registry = yield* ProviderRegistry
      yield* registry.kinds.register({
        ...registry.kinds.get("openai-chat")!,
        id: "cerebras",
        piProvider: "cerebras",
        catalog: async () => ({})
      })
      if (edit === "policy")
        yield* registry.transforms.register({
          id: "changing-policy",
          appliesTo: () => true,
          transform: (p) => ({ ...p, ...(hit ? {} : { cache_control: { type: "ephemeral" } }) })
        })
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: {
          kind: edit === "policy" ? "openrouter" : "cerebras",
          baseUrl: mock.url,
          apiKey: "synthetic-review-key",
          ...(edit === "connection" ? { cacheTtlS: 120 } : {})
        },
        model: edit === "model" ? { cacheTtlS: 120 } : {},
        modelKey: edit === "policy" ? "google/gemini-2.5-pro" : "gpt-oss-120b"
      })
      assert.equal(reply.version.status, "complete")
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const first = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
      if (edit === "model")
        yield* api.EditModel({
          modelId: reply.model.id,
          expectedRowVersion: reply.model.rowVersion,
          overrides: { cacheTtlS: 900 }
        })
      if (edit === "connection")
        yield* api.UpdateConnection({
          connectionId: reply.connection.id,
          expectedRowVersion: reply.connection.rowVersion,
          settings: {
            name: reply.connection.name,
            baseUrl: reply.connection.baseUrl,
            compat: reply.connection.compat,
            cacheTtlS: 900,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
      const edited = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
      assert.equal(edited?.expiresAt, first?.expiresAt)
      hit = true
      for (let n = 0; n < 2; n++) {
        const current = yield* api.GetChat({ chatId: reply.chat.id })
        const { entry } = yield* posted(
          api.Generate({ chatId: reply.chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
        )
        yield* eventually(() => finished(reply.events, entry.version.id) !== undefined)
        assert.equal(finished(reply.events, entry.version.id)!.status, "complete")
        const afterHit = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
        assert.equal(afterHit!.expiresAt, first!.expiresAt)
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
  })

it.live("Fireworks preserves a reported header hit on tool-only completion", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* resource((_req, res) => {
      res.setHeader("fireworks-cached-prompt-tokens", "100")
      sse(res, [
        {
          id: "synthetic",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  { index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          id: "synthetic",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
        }
      ])
    })
    const registry = yield* ProviderRegistry
    yield* registry.transforms.register({
      id: "review-declare-lookup",
      appliesTo: () => true,
      transform: (p) => ({
        ...p,
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }]
      })
    })
    const api = yield* client()
    const reply = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url, cacheTtlS: 777 },
      model: {}
    })
    assert.equal(reply.version.status, "complete")
    const me = yield* api.Whoami()
    const reader = yield* Reader
    const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
    const ledger = (yield* api.ListLlmRequests({ limit: 1, before: null }))[0]!
    assert.equal(ledger.counts.cacheRead, 100)
    assert.equal(warmth?.verified, true)
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
})

it.live("Ordinary tool-schema cache_control properties do not select explicit caching", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* resource((_req, res) =>
      sse(
        res,
        completionChunks(["Synthetic answer"], {
          prompt_tokens: 120,
          completion_tokens: 6,
          prompt_tokens_details: { cached_tokens: 100 }
        })
      )
    )
    const registry = yield* ProviderRegistry
    yield* registry.transforms.register({
      id: "review-tool-schema",
      appliesTo: () => true,
      transform: (p) => ({
        ...p,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: { type: "object", properties: { cache_control: { type: "string" } } }
            }
          }
        ]
      })
    })
    const api = yield* client()
    const reply = yield* generateReply(api, {
      connection: { kind: "openrouter", baseUrl: mock.url, apiKey: "synthetic-review-key" },
      model: {},
      modelKey: "google/gemini-2.5-pro"
    })
    assert.equal(reply.version.status, "complete")
    const me = yield* api.Whoami()
    const reader = yield* Reader
    const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
    assert.equal(warmth?.ttlS, 180)
    assert.equal(warmth?.verified, true)
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
})
