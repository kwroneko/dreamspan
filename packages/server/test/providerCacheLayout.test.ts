// Where cache markers go by default, per provider (liveapi F3, F4, F5, F8), and the documented
// minimum cacheable sizes the estimate respects (F6). Real requests through a mock provider.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { applyRouterCacheControl } from "../src/providers/breakpoints.ts"
import { documentedCacheMinimum, documentedCachePolicy } from "../src/providers/cachePolicy.ts"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { anthropicSse, completionChunks, sse, startMockProvider, type Handler } from "./support/mockProvider.ts"

const resource = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

const anthropicReply: Handler = (_req, res) =>
  anthropicSse(res, [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [],
        usage: { input_tokens: 10, output_tokens: 1 }
      }
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The tide is out." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" }
  ])

const completionReply: Handler = (_req, res) =>
  sse(res, completionChunks(["The tide is out."], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))

type WireMessage = { role: string; content: unknown }
const marked = (message: WireMessage | undefined) => JSON.stringify(message?.content ?? null).includes("cache_control")
const markedAt = (messages: ReadonlyArray<WireMessage>) => messages.flatMap((m, i) => (marked(m) ? [i] : []))
const text = (message: WireMessage | undefined) =>
  typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "")

describe("default cache markers", () => {
  it.live("Anthropic's automatic layout ends its markers before the end-of-request instruction", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(anthropicReply)
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "claude-haiku-4-5",
        model: {},
        content: "Read me the lantern entry."
      })
      const body = mock.requests().at(-1)!.body!
      const messages = body.messages as Array<WireMessage>
      const at = markedAt(messages)
      assert.isAbove(at.length, 0, "a marker on the messages")
      const last = at.at(-1)!
      // The marked message is the user's, and nothing after it carries a marker.
      assert.include(text(messages[last]), "Read me the lantern entry.")
      assert.isFalse(messages.slice(last + 1).some(marked))
      assert.isAtMost(JSON.stringify(body).split('"cache_control"').length - 1, 4)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const layout of ["auto", "explicit"] as const)
    it.live(`OpenRouter Claude gets cache_control markers (${layout} layout)`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* resource(completionReply)
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openrouter", baseUrl: mock.url, apiKey: "synthetic-key" },
          modelKey: "anthropic/claude-haiku-4.5",
          model: layout === "explicit" ? { cacheBreakpoints: "explicit" } : {},
          content: "Read me the lantern entry."
        })
        const messages = mock.requests().at(-1)!.body!.messages as Array<WireMessage>
        const at = markedAt(messages)
        assert.include(at, 0, "the system message")
        assert.include(text(messages[at.at(-1)!]), "Read me the lantern entry.")
        assert.isAtMost(at.length, 4)
        const marker = JSON.stringify(messages[0]!.content)
        assert.include(marker, '"cache_control":{"type":"ephemeral"}')
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it("OpenRouter Claude with a top-level cache_control gets no message markers", () => {
    const payload: Record<string, unknown> = {
      cache_control: { type: "ephemeral", ttl: "1h" },
      messages: [
        { role: "system", content: "You are Mira." },
        { role: "user", content: "Read me the lantern entry." }
      ]
    }
    applyRouterCacheControl(payload, "anthropic", { breakpoints: [], stable: { message: 1, end: 2 } })
    assert.deepEqual(markedAt(payload.messages as Array<WireMessage>), [])
    const unset: Record<string, unknown> = { ...payload, cache_control: undefined }
    delete unset.cache_control
    applyRouterCacheControl(unset, "anthropic", { breakpoints: [], stable: { message: 1, end: 2 } })
    assert.deepEqual(markedAt(unset.messages as Array<WireMessage>), [0, 1])
  })

  it.live("OpenRouter Gemini gets one cache_control marker, on the reusable endpoint", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // As OpenRouter reports Gemini's explicit cache: the prefix written and read in one request.
      const mock = yield* resource((_req, res) =>
        sse(
          res,
          completionChunks(["The tide is out."], {
            prompt_tokens: 4753,
            completion_tokens: 5,
            total_tokens: 4758,
            prompt_tokens_details: { cached_tokens: 4746, cache_write_tokens: 4746 }
          })
        )
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openrouter", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "google/gemini-3.5-flash-lite",
        model: {},
        content: "Read me the lantern entry."
      })
      const [row] = yield* api.ListLlmRequests({ limit: 1, before: null })
      assert.deepInclude(row!.counts, { inputUncached: 7, cacheRead: 4746, cacheWrite: 4746 })
      const body = mock.requests().at(-1)!.body!
      const at = markedAt(body.messages as Array<WireMessage>)
      assert.strictEqual(at.length, 1)
      assert.include(text((body.messages as Array<WireMessage>)[at[0]!]), "Read me the lantern entry.")
      assert.strictEqual(
        documentedCachePolicy(
          { provider: "openrouter", api: "openai-completions", model: "google/gemini-3.5-flash-lite" },
          body
        )?.ttlS,
        300
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("OpenAI behind a router gets the chat's prompt_cache_key", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(completionReply)
      const api = yield* client()
      const { chat } = yield* generateReply(api, {
        connection: { provider: "openai", kind: "openai-chat", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "gpt-5.4-nano",
        model: {}
      })
      assert.strictEqual(mock.requests().at(-1)!.body!.prompt_cache_key, chat.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a custom server gets no prompt_cache_key unless its connection turns it on", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(completionReply)
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "gpt-5.4-nano",
        model: {}
      })
      assert.notProperty(mock.requests().at(-1)!.body!, "prompt_cache_key")
      const { chat } = yield* generateReply(api, {
        connection: {
          provider: "openai-compatible",
          kind: "openai-chat",
          baseUrl: mock.url,
          providerSettings: { promptCacheKey: true }
        },
        modelKey: "gpt-5.4-nano",
        model: {}
      })
      assert.strictEqual(mock.requests().at(-1)!.body!.prompt_cache_key, chat.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a custom Responses server gets no SDK-generated cache key until opted in", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) =>
        sse(res, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "msg_1", role: "assistant", content: [] }
          },
          { type: "response.output_text.delta", output_index: 0, delta: "The tide is out." },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "The tide is out." }]
            }
          },
          {
            type: "response.completed",
            response: {
              id: "r1",
              status: "completed",
              model: "m",
              output: [],
              usage: { input_tokens: 2, output_tokens: 5 }
            }
          }
        ])
      )
      const api = yield* client()
      for (const promptCacheKey of [false, true]) {
        const { chat, version } = yield* generateReply(api, {
          connection: {
            provider: "openai-compatible",
            kind: "openai-responses",
            baseUrl: mock.url,
            providerSettings: { promptCacheKey }
          },
          modelKey: "synthetic",
          model: {}
        })
        assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
        if (promptCacheKey) assert.strictEqual(mock.requests().at(-1)!.body!.prompt_cache_key, chat.id)
        else assert.notProperty(mock.requests().at(-1)!.body!, "prompt_cache_key")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("OpenAI's best-effort cache: the estimate claims no more than the last request read", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) =>
        sse(
          res,
          completionChunks(["The tide is out."], {
            prompt_tokens: 60,
            completion_tokens: 5,
            total_tokens: 65,
            prompt_tokens_details: { cached_tokens: 5 }
          })
        )
      )
      const api = yield* client()
      const { chat } = yield* generateReply(api, {
        connection: { provider: "openai", kind: "openai-chat", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "gpt-5.4-nano",
        model: { cacheLayout: { minTokens: 1 } }
      })
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const estimate = yield* reader.CacheWarmth({
        userId: me.id as never,
        chatId: chat.id,
        leafSlotId: null,
        forkId: null
      })
      assert.strictEqual(estimate.warmth?.prefixTokens, 5)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("below the model's minimum cacheable size the estimate claims no warm cache", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(anthropicReply)
      const api = yield* client()
      const { chat } = yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "claude-haiku-4-5",
        model: {}
      })
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const estimate = yield* reader.CacheWarmth({
        userId: me.id as never,
        chatId: chat.id,
        leafSlotId: null,
        forkId: null
      })
      assert.isNull(estimate.warmth)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("documented cache rules", () => {
  it("minimum cacheable sizes", () => {
    const min = (provider: string, model: string) =>
      documentedCacheMinimum({ provider, api: "anthropic-messages", model })
    assert.strictEqual(min("anthropic", "claude-haiku-4-5-20251001"), 4096)
    assert.strictEqual(min("anthropic", "claude-haiku-5-5"), 512)
    assert.strictEqual(min("anthropic", "claude-sonnet-5"), 1024)
    assert.strictEqual(min("anthropic", "claude-sonnet-5-5"), 512)
    assert.strictEqual(min("anthropic", "claude-opus-4-7"), 2048)
    assert.strictEqual(min("openrouter", "anthropic/claude-haiku-4.5"), 4096)
    assert.strictEqual(min("openai-chat", "gpt-5.4-nano"), 1024)
    assert.strictEqual(min("openrouter", "google/gemini-3.5-flash-lite"), 1024)
    assert.strictEqual(min("openrouter", "google/gemini-3.5-pro"), 4096)
    assert.isNull(min("anthropic", "claude-3-5-haiku"))
    assert.isNull(min("deepseek", "deepseek-flash"))
  })

  it("OpenRouter Claude without markers has no cache lifetime", () => {
    const target = { provider: "openrouter", api: "openai-completions", model: "anthropic/claude-haiku-4.5" }
    assert.isNull(documentedCachePolicy(target, { messages: [{ role: "user", content: "Hello" }] }))
    assert.strictEqual(
      documentedCachePolicy(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] }]
      })?.ttlS,
      300
    )
  })
})
