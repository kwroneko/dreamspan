import { assert, it } from "@effect/vitest"
import { Effect, Layer, Predicate } from "effect"
import { Reader } from "../src/db/Database.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import * as Builtins from "../src/providers/builtins.ts"
import { client, serverLayer, testConfig, posted } from "./support/config.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks, anthropicSse } from "./support/mockProvider.ts"

for (const [kind, key, ttl, field] of [
  ["openai-chat", "gpt-4.1", 300, "details"],
  ["openai-responses", "gpt-5.6", 1800, "details"],
  ["moonshotai", "kimi-k3", 300, "details"],
  ["groq", "openai/gpt-oss-120b", 7200, "details"],
  ["cerebras", "gpt-oss-120b", 300, "details"],
  ["openrouter", "anthropic/claude-sonnet-4.5", 300, "details"],
  ["openrouter", "google/gemini-2.5-pro", 180, "details"],
  ["deepseek", "deepseek-chat", null, "deepseek"],
  ["together", "synthetic", 777, "together"]
] as const) {
  it.live(`${kind}/${key} resolves warmth and the reported hit at the worker boundary`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_r, res) =>
            sse(
              res,
              completionChunks(["Synthetic answer"], {
                prompt_tokens: 120,
                completion_tokens: 6,
                ...(field === "details"
                  ? { prompt_tokens_details: { cached_tokens: kind === "cerebras" ? 0 : 100 } }
                  : field === "deepseek"
                    ? { prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 }
                    : { cached_tokens: 100 })
              })
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const registry = yield* ProviderRegistry
      yield* registry.kinds.register({
        ...registry.kinds.get("openai-chat")!,
        id: kind,
        piProvider: kind === "openai-responses" ? "openai" : kind,
        catalog: async () => ({})
      })
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: { kind, baseUrl: mock.url + "/v1", ...(field === "together" ? { cacheTtlS: 777 } : {}) },
        model: {},
        modelKey: key
      })
      assert.equal(reply.version.status, "complete")
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
      if (ttl === null) assert.isNull(warmth)
      else {
        assert.equal(warmth?.ttlS, ttl)
        assert.equal(warmth?.verified, kind !== "cerebras")
        const ledger = (yield* api.ListLlmRequests({ limit: 1, before: null }))[0]!
        assert.equal(ledger.counts.cacheRead, kind === "cerebras" ? 0 : 100)
        assert.equal(warmth?.expiresAt, ledger.startedAt + ttl * 1000)
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
  })
}

it.live("model TTL overrides connection TTL, and connection TTL overrides the built-in", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_r, res) =>
          sse(
            res,
            completionChunks(["Synthetic"], {
              prompt_tokens: 120,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 100 }
            })
          )
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const me = yield* api.Whoami()
    const reader = yield* Reader
    for (const override of [undefined, 900]) {
      const reply = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: mock.url, cacheTtlS: 700 },
        model: override === undefined ? {} : { cacheTtlS: override },
        modelKey: "gpt-5.6"
      })
      const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
      assert.equal(warmth!.ttlS, override ?? 700)
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

for (const kind of ["cerebras", "openrouter"] as const) {
  it.live(`${kind} fixed expiry stays anchored to the write across subsequent hits`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let hits = false
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_r, res) =>
            sse(
              res,
              completionChunks(["Synthetic answer"], {
                prompt_tokens: 120,
                completion_tokens: 6,
                prompt_tokens_details: { cached_tokens: hits ? 100 : 0 }
              })
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const registry = yield* ProviderRegistry
      yield* registry.kinds.register({
        ...registry.kinds.get("openai-chat")!,
        id: kind,
        piProvider: kind,
        catalog: async () => ({})
      })
      if (kind === "openrouter")
        yield* registry.transforms.register({
          id: "synthetic-explicit-cache",
          appliesTo: () => true,
          transform: (p) => ({ ...p, cache_control: { type: "ephemeral" } })
        })
      const api = yield* client()
      const first = yield* generateReply(api, {
        connection: { kind, baseUrl: mock.url },
        model: {},
        modelKey: kind === "cerebras" ? "gpt-oss-120b" : "google/gemini-2.5-pro"
      })
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const initial = yield* reader.CacheWarmth({ userId: me.id, chatId: first.chat.id })
      assert.equal(initial!.ttlS, 300)
      hits = true
      const current = yield* api.GetChat({ chatId: first.chat.id })
      const { entry } = yield* posted(
        api.Generate({ chatId: first.chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
      )
      yield* eventually(() => finished(first.events, entry.version.id) !== undefined)
      const warm = yield* reader.CacheWarmth({ userId: me.id, chatId: first.chat.id })
      assert.isNotNull(warm)
      assert.equal(warm!.verified, true)
      assert.equal(warm!.expiresAt, initial!.expiresAt)
      assert.isAbove(warm!.lastRequestAt, initial!.lastRequestAt)
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
  })
}

for (const [kind, key, payload, ttl] of [
  [
    "qwen",
    "qwen-plus",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "Synthetic", cache_control: { type: "ephemeral" } }] }]
    },
    300
  ],
  ["openrouter", "anthropic/claude", { cache_control: { type: "ephemeral", ttl: "1h" } }, 600],
  [
    "openrouter",
    "anthropic/claude",
    { cache_control: { type: "ephemeral", ttl: "1h" }, provider: { only: ["Anthropic"] } },
    3600
  ],
  ["openai-chat", "gpt-5.4", { prompt_cache_retention: "24h" }, 1800],
  ["moonshotai", "kimi-k3", { prompt_cache_options: { mode: "implicit", ttl: "1h" } }, 3600]
] as const) {
  it.live(`${kind} pins the requested cache policy after transforms`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_r, res) =>
            sse(
              res,
              completionChunks(["Synthetic"], {
                prompt_tokens: 120,
                completion_tokens: 2,
                prompt_tokens_details: { cached_tokens: 100 }
              })
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const registry = yield* ProviderRegistry
      yield* registry.kinds.register({
        ...registry.kinds.get("openai-chat")!,
        id: kind,
        piProvider: kind === "openai-chat" ? "openai" : kind,
        catalog: async () => ({})
      })
      yield* registry.transforms.register({
        id: "synthetic-retention",
        appliesTo: () => true,
        transform: (p) => ({ ...p, ...payload })
      })
      const api = yield* client()
      const reply = yield* generateReply(api, { connection: { kind, baseUrl: mock.url }, model: {}, modelKey: key })
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
      const ledger = (yield* api.ListLlmRequests({ limit: 1, before: null }))[0]!
      assert.equal(warmth!.expiresAt, ledger.startedAt + ttl * 1000)
      assert.equal(warmth!.verified, true)
      for (const [field, value] of Object.entries(payload))
        assert.deepEqual(mock.requests().at(-1)!.body![field], value)
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
  })
}

it.live("Google's cachedContentTokenCount verifies warmth with a user TTL", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_r, res) =>
          sse(
            res,
            [
              {
                candidates: [
                  { content: { role: "model", parts: [{ text: "Synthetic answer" }] }, finishReason: "STOP" }
                ],
                usageMetadata: {
                  promptTokenCount: 120,
                  cachedContentTokenCount: 100,
                  candidatesTokenCount: 6,
                  totalTokenCount: 126
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
    const me = yield* api.Whoami()
    const reader = yield* Reader
    const reply = yield* generateReply(api, {
      connection: { kind: "google", baseUrl: mock.url, apiKey: "synthetic-google-key", cacheTtlS: 777 },
      model: {}
    })
    assert.equal(reply.version.status, "complete")
    const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
    assert.equal(warmth!.ttlS, 777)
    assert.equal(warmth!.verified, true)
    const ledger = (yield* api.ListLlmRequests({ limit: 1, before: null }))[0]!
    assert.equal(ledger.counts.cacheRead, 100)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

for (const [kind, ttl] of [
  ["anthropic", 3600],
  ["amazon-bedrock", 3600],
  ["google-vertex", 3600],
  ["minimax", 300]
] as const) {
  it.live(`${kind} Messages verifies the actual explicit ${ttl}s cache policy`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_r, res) =>
            anthropicSse(res, [
              {
                type: "message_start",
                message: {
                  id: "synthetic",
                  type: "message",
                  role: "assistant",
                  model: "claude-x",
                  content: [],
                  stop_reason: null,
                  usage: {
                    input_tokens: 20,
                    output_tokens: 1,
                    cache_read_input_tokens: 100,
                    cache_creation_input_tokens: 0
                  }
                }
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic answer" } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
              { type: "message_stop" }
            ])
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const registry = yield* ProviderRegistry
      yield* registry.kinds.register({
        ...registry.kinds.get("anthropic")!,
        id: kind,
        piProvider: kind,
        catalog: async () => ({})
      })
      const setMarkers = (p: unknown): void => {
        if (Array.isArray(p)) {
          p.forEach(setMarkers)
          return
        }
        if (!Predicate.isObject(p)) return
        const o = p as Record<string, unknown>
        if (Predicate.isObject(o.cache_control)) o.cache_control.ttl = ttl === 3600 ? "1h" : "5m"
        for (const value of Object.values(o)) setMarkers(value)
      }
      yield* registry.transforms.register({
        id: "synthetic-requested-ttl",
        appliesTo: () => true,
        transform: (p) => {
          setMarkers(p)
          return p
        }
      })
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: { kind, baseUrl: mock.url, apiKey: "synthetic-key" },
        model: {},
        modelKey: kind === "minimax" ? "MiniMax-M2" : "claude-x"
      })
      assert.equal(reply.version.status, "complete")
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
      assert.equal(warmth!.ttlS, ttl)
      assert.equal(warmth!.verified, true)
      const ledger = (yield* api.ListLlmRequests({ limit: 1, before: null }))[0]!
      assert.equal(ledger.counts.cacheRead, 100)
      assert.equal(warmth!.expiresAt, ledger.startedAt + ttl * 1000)
      assert.include(JSON.stringify(mock.requests().at(-1)!.body), `"ttl":"${ttl === 3600 ? "1h" : "5m"}"`)
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), Builtins.layer)))
  })
}

it.live("Fireworks' dedicated hit header verifies warmth without streamed usage", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_r, res) => {
          res.setHeader("fireworks-cached-prompt-tokens", "100")
          sse(res, completionChunks(["Synthetic answer"], {}).slice(0, -1))
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const reply = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url, cacheTtlS: 777 },
      model: {}
    })
    assert.equal(reply.version.status, "complete", JSON.stringify(reply.version.error))
    const me = yield* api.Whoami()
    const reader = yield* Reader
    const warmth = yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })
    assert.equal(warmth!.verified, true)
    assert.equal((yield* api.ListLlmRequests({ limit: 1, before: null }))[0]!.counts.cacheRead, 100)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
