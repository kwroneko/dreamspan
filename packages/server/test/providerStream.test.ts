// The provider layer end to end (spec/PROVIDERS.md §4, §7, §9): real pi-ai adapters
// against a scripted provider speaking the real wire formats, through the network
// module and the database workers.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage, Context as PiContext } from "@earendil-works/pi-ai"
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import type { ConnectionSettings, ModelId, ProviderKind } from "@rp/shared/providers.ts"
import { Effect, Exit, Layer, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import { classify, parseRetryAfter } from "../src/providers/errors.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeScrub, ProviderError } from "../src/providers/Providers.ts"
import { alignTranscript } from "../src/providers/breakpoints.ts"
import { priceCost } from "../src/providers/usage.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { anthropicSse, completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"

const layer = () =>
  Providers.layer({ maxRetries: 2, baseDelayMs: 5, maxDelayMs: 1_000 }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(
      Database.layer({
        dataDir: mkdtempSync(join(tmpdir(), "rp-stream-")),
        readers: 1,
        allowNetworkFs: false,
        workers: "source"
      })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
  )

const mock = (handler: Parameters<typeof startMockProvider>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (server) => Effect.promise(() => server.close())
  )

const settings = (baseUrl: string): ConnectionSettings => ({
  name: "Test",
  baseUrl,
  compat: {},
  cacheTtlS: null,
  maxConcurrent: null,
  presetOverrideRefId: null
})

const context: PiContext = {
  systemPrompt: "You are the narrator.",
  messages: [{ role: "user", content: "The harbor at dusk.", timestamp: 1 }]
}

/** A user with one connection whose models were refreshed from the mock. */
const connect = (kind: ProviderKind, baseUrl: string, apiKey: string | null, modelKey: string) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const connection = yield* providers.createConnection({ userId, kind, settings: settings(baseUrl), apiKey })
    yield* providers.refreshModels(userId, connection.id)
    const models = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
    const model = models.find((m) => m.key === modelKey)
    assert.isDefined(model, `model ${modelKey} listed`)
    return { userId, connection, modelId: model!.id as ModelId, providers, reader, writer }
  })

const collect = <A, E>(stream: Stream.Stream<A, E>) => Stream.runCollect(stream)

/** Narrows a flipped failure to the ProviderError the test expects. */
const asProviderError = (error: { readonly _tag: string }) => {
  if (!(error instanceof ProviderError)) throw new Error(`expected a ProviderError, got ${error._tag}`)
  return error
}

const openAiList = (models: ReadonlyArray<Record<string, unknown>>) => ({ data: models })

describe("streaming through OpenRouter's Chat Completions", () => {
  it.live("streams text and records the request with normalized usage, upstream and reported cost", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) => {
        if (request.path === "/api/v1/models") {
          return json(
            res,
            200,
            openAiList([
              {
                id: "vendor/storyteller",
                name: "Vendor: Storyteller",
                context_length: 32_000,
                pricing: { prompt: "0.000001", completion: "0.000002" },
                supported_parameters: ["tools", "temperature"]
              }
            ])
          )
        }
        sse(
          res,
          completionChunks(
            ["Lanterns ", "swing."],
            { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 }, cost: 0.00042 },
            { provider: "Fireworks" }
          )
        )
      })
      const { userId, connection, modelId, providers, reader } = yield* connect(
        "openrouter",
        `${server.url}/api/v1`,
        "sk-or-test-9876",
        "vendor/storyteller"
      )
      assert.strictEqual(connection.keyHint, "9876")
      yield* providers.setHeaders(userId, connection.id, { "X-Gateway-Tag": "rp" })

      const events = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          options: { maxTokens: 300, temperature: 0.8 },
          attribution: { purpose: "generation" }
        })
      )
      const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")
      assert.strictEqual(text, "Lanterns swing.")
      assert.deepInclude(events, { type: "route", description: "direct: no proxy configured" })
      const done = events.at(-1)!
      assert.strictEqual(done.type, "done")
      if (done.type !== "done") return
      assert.deepStrictEqual(done.counts, {
        inputUncached: 10,
        cacheRead: 90,
        cacheWrite: 0,
        cacheWriteLong: 0,
        output: 5,
        reasoning: 0
      })
      assert.deepStrictEqual(done.cost, { amount: 0.00042, currency: "USD", formula: "reported" })

      // What went over the wire: the key, our header, the sampler, OpenRouter's dialect.
      const sent = server.requests().find((r) => r.path === "/api/v1/chat/completions")!
      assert.strictEqual(sent.headers.authorization, "Bearer sk-or-test-9876")
      assert.strictEqual(sent.headers["x-gateway-tag"], "rp")
      assert.strictEqual(sent.body!.model, "vendor/storyteller")
      assert.strictEqual(sent.body!.temperature, 0.8)

      const [row] = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
      assert.strictEqual(row!.status, "complete")
      assert.strictEqual(row!.upstream, "Fireworks")
      assert.strictEqual(row!.usageSource, "reported")
      assert.strictEqual(row!.counts.cacheRead, 90)
      assert.isNotNull(row!.firstTokenAt)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("computes the built-in cost when the provider reports none", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, openAiList([{ id: "m", pricing: { prompt: "0.000002", completion: "0.00001" } }]))
          : sse(res, completionChunks(["Hi."], { prompt_tokens: 1000, completion_tokens: 100 }))
      )
      const { userId, connection, modelId, providers } = yield* connect("openrouter", `${server.url}/v1`, "k", "m")
      const events = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
      const done = events.at(-1)!
      if (done.type !== "done") return assert.fail("no done event")
      // 1000 × $2/M + 100 × $10/M
      assert.strictEqual(done.cost?.formula, "builtin")
      assert.closeTo(done.cost!.amount, 0.003, 1e-12)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("failures", () => {
  it.live("retries a rate limit before the first token, each attempt in the ledger", () =>
    Effect.gen(function* () {
      let chats = 0
      const server = yield* mock((request, res) => {
        if (request.path.endsWith("/models")) return json(res, 200, openAiList([{ id: "m" }]))
        chats++
        if (chats === 1) return json(res, 429, { error: { message: "slow down" } }, { "retry-after": "0" })
        sse(res, completionChunks(["Ok."], { prompt_tokens: 10, completion_tokens: 2 }))
      })
      const { userId, connection, modelId, providers, reader } = yield* connect(
        "openai-chat",
        `${server.url}/v1`,
        "k",
        "m"
      )
      const events = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
      const retrying = events.find((e) => e.type === "retrying")
      assert.isDefined(retrying)
      if (retrying?.type === "retrying") assert.strictEqual(retrying.error.reason, "rate_limited")
      assert.strictEqual(events.at(-1)!.type, "done")
      const rows = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
      assert.deepStrictEqual(rows.map((r) => r.status).sort(), ["complete", "failed"])
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("never retries after output: the stream fails, and the request is kept with estimated usage", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) => {
        if (request.path.endsWith("/models")) return json(res, 200, openAiList([{ id: "m" }]))
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify(completionChunks(["The tide "], {})[0])}\n\n`)
        setTimeout(() => res.destroy(), 20)
      })
      const { userId, connection, modelId, providers, reader } = yield* connect(
        "openai-chat",
        `${server.url}/v1`,
        "k",
        "m"
      )
      const seen: Array<string> = []
      const exit = yield* Stream.runForEach(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        }),
        (event) => Effect.sync(() => event.type === "text" && seen.push(event.delta))
      ).pipe(Effect.exit)
      assert.deepStrictEqual(seen, ["The tide "])
      assert.isTrue(Exit.isFailure(exit))
      const error = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ""
      assert.include(error, '"afterTokens":true')
      const chats = server.requests().filter((r) => r.path.endsWith("/chat/completions"))
      assert.strictEqual(chats.length, 1)
      const [row] = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
      assert.strictEqual(row!.status, "failed")
      assert.strictEqual(row!.usageSource, "estimated")
      assert.isAbove(row!.counts.output!, 0)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("does not retry an auth failure", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, openAiList([{ id: "m" }]))
          : json(res, 401, { error: { message: "invalid key" } })
      )
      const { userId, connection, modelId, providers } = yield* connect("openai-chat", `${server.url}/v1`, "bad", "m")
      const error = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(error.reason, "auth")
      assert.strictEqual(server.requests().filter((r) => r.path.endsWith("/chat/completions")).length, 1)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("never shows the key, even when the provider's error echoes it", () =>
    Effect.gen(function* () {
      const key = "sk-live-0123456789abcdef"
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, openAiList([{ id: "m" }]))
          : json(res, 400, { error: { message: `bad request for key ${key} with header tok-secret-header` } })
      )
      const { userId, connection, modelId, providers } = yield* connect("openai-chat", `${server.url}/v1`, key, "m")
      yield* providers.setHeaders(userId, connection.id, { "X-Token": "tok-secret-header" })
      const error = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(error.reason, "bad_request")
      assert.notInclude(error.message, key)
      assert.notInclude(error.message, "tok-secret-header")
      assert.include(error.message, "[redacted]")

      server.setHandler((_request, res) => json(res, 401, { error: `unknown key ${key}` }))
      const listError = yield* providers
        .refreshModels(userId, connection.id)
        .pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(listError.reason, "auth")
      assert.notInclude(listError.message, key)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("stopping a stream aborts the request and records it as aborted", () =>
    Effect.gen(function* () {
      let closed = false
      const server = yield* mock((request, res) => {
        if (request.path.endsWith("/models")) return json(res, 200, openAiList([{ id: "m" }]))
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify(completionChunks(["Once "], {})[0])}\n\n`)
        res.on("close", () => (closed = true))
      })
      const { userId, connection, modelId, providers, reader } = yield* connect(
        "openai-chat",
        `${server.url}/v1`,
        "k",
        "m"
      )
      yield* collect(
        providers
          .stream({ userId, connectionId: connection.id, modelId, context, attribution: { purpose: "generation" } })
          .pipe(Stream.takeUntil((e) => e.type === "text"))
      )
      const [row] = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
      assert.strictEqual(row!.status, "aborted")
      yield* Effect.sleep(50)
      assert.isTrue(closed, "the provider saw the request end")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("refuses a connection without the key its kind needs, without sending anything", () =>
    Effect.gen(function* () {
      const server = yield* mock((_request, res) => json(res, 200, { data: [] }))
      const writer = yield* Database.Writer
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "anthropic",
        settings: settings(server.url),
        apiKey: null
      })
      const model = yield* writer.AddUserModel({ userId, connectionId: connection.id, key: "claude-x", overrides: {} })
      const error = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: model.id,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(error.reason, "unusable")
      assert.strictEqual(server.requests().length, 0)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("refuses to send Google traffic around a proxy that applies to it", () =>
    Effect.gen(function* () {
      const network = yield* Network.Network
      yield* network.setInstance({ proxyUrl: "http://127.0.0.1:9", bypass: [] })
      const writer = yield* Database.Writer
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "google",
        settings: settings("https://generativelanguage.googleapis.com/v1beta"),
        apiKey: "g-key"
      })
      const model = yield* writer.AddUserModel({ userId, connectionId: connection.id, key: "gemini-x", overrides: {} })
      const error = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: model.id,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(error.reason, "unusable")
      assert.include(error.message, "proxy")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("provider quirks", () => {
  it.live("Anthropic: cache reads and long cache writes are counted apart and priced from the catalog", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) => {
        if (request.path.startsWith("/v1/models")) {
          return json(res, 200, {
            data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }],
            has_more: false
          })
        }
        anthropicSse(res, [
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-5-5",
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 90,
                cache_creation_input_tokens: 20,
                cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 },
                output_tokens: 1
              }
            }
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fog rolls in." } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 7 }
          },
          { type: "message_stop" }
        ])
      })
      const { userId, connection, modelId, providers } = yield* connect(
        "anthropic",
        server.url,
        "sk-ant-test",
        "claude-sonnet-5-5"
      )
      const events = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
      const done = events.at(-1)!
      if (done.type !== "done") return assert.fail("no done event")
      assert.deepStrictEqual(done.counts, {
        inputUncached: 10,
        cacheRead: 90,
        cacheWrite: 20,
        cacheWriteLong: 5,
        output: 7,
        reasoning: null
      })
      // Catalog price for claude-sonnet-5-5: $2 in, $10 out, $0.20 read, $2.50 write (5 min), long writes at 2× input.
      assert.strictEqual(done.cost?.formula, "builtin")
      assert.closeTo(done.cost!.amount, (10 * 2 + 90 * 0.2 + 15 * 2.5 + 5 * 4 + 7 * 10) / 1e6, 1e-12)
      const sent = server.requests().find((r) => r.path.startsWith("/v1/messages"))!
      assert.strictEqual(sent.headers["x-api-key"], "sk-ant-test")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("DeepSeek: the catalog's compat reaches the wire (max_tokens, reasoning replay)", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path === "/models"
          ? json(res, 200, openAiList([{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }]))
          : sse(
              res,
              completionChunks(["Aye."], { prompt_tokens: 50, completion_tokens: 3, prompt_cache_hit_tokens: 40 })
            )
      )
      const { userId, connection, modelId, providers } = yield* connect(
        "deepseek",
        server.url,
        "sk-ds",
        "deepseek-flash"
      )
      const withHistory: PiContext = {
        messages: [
          { role: "user", content: "Who goes there?", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "A guard would ask." },
              { type: "text", text: "A friend." }
            ],
            api: "openai-completions",
            provider: "deepseek",
            model: "deepseek-flash",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: "stop",
            timestamp: 2
          },
          { role: "user", content: "Pass, friend.", timestamp: 3 }
        ]
      }
      const events = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context: withHistory,
          options: { reasoning: "high", maxTokens: 500 },
          attribution: { purpose: "generation" }
        })
      )
      const done = events.at(-1)!
      if (done.type !== "done") return assert.fail("no done event")
      // DeepSeek reports cache hits in its own field; pi normalizes them.
      assert.strictEqual(done.counts.cacheRead, 40)
      assert.strictEqual(done.counts.inputUncached, 10)
      const body = server.requests().find((r) => r.path === "/chat/completions")!.body!
      assert.strictEqual(body.max_tokens, 500)
      assert.isUndefined(body.max_completion_tokens)
      const messages = body.messages as Array<Record<string, unknown>>
      const assistant = messages.find((m) => m.role === "assistant")!
      assert.property(assistant, "reasoning_content")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("a keyless local server works through the Chat Completions kind", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, openAiList([{ id: "local-model", max_model_len: 16_384 }]))
          : sse(res, completionChunks(["Local."], { prompt_tokens: 5, completion_tokens: 2 }))
      )
      const { userId, connection, modelId, providers, reader } = yield* connect(
        "openai-chat",
        `${server.url}/v1`,
        null,
        "local-model"
      )
      const model = yield* reader.GetModel({ userId, modelId })
      // vLLM reports the context it was started with.
      assert.strictEqual(model.upstream.context, 16_384)
      const result = yield* providers.testConnection(userId, connection.id)
      assert.deepStrictEqual(result, {
        ok: true,
        detail: "1 models listed",
        route: "direct: no proxy configured",
        models: 1
      })
      const events = yield* collect(
        providers.stream({ userId, connectionId: connection.id, modelId, context, attribution: { purpose: "test" } })
      )
      assert.strictEqual(events.at(-1)!.type, "done")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("explicit cache breakpoints", () => {
  const anthropicReply = (res: Parameters<typeof anthropicSse>[0]) =>
    anthropicSse(res, [
      {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 1 }
        }
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Yes." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" }
    ])

  const story: PiContext = {
    systemPrompt: "You are the narrator.",
    messages: [
      { role: "user", content: "<summary>Chapters one to nine.</summary>", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "The story so far is noted." }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: 2
      },
      // pi-ai drops an empty message, so wire positions shift after it.
      { role: "user", content: "   ", timestamp: 3 },
      { role: "user", content: "The harbor at dusk.", timestamp: 4 }
    ]
  }

  const markersIn = (body: Record<string, unknown>) => JSON.stringify(body).split('"cache_control"').length - 1

  it.live("lands on the wire messages the caller named, within Anthropic's limit, with pi's TTL", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.startsWith("/v1/models")
          ? json(res, 200, { data: [{ id: "claude-sonnet-5-5" }], has_more: false })
          : anthropicReply(res)
      )
      const { userId, connection, modelId, providers } = yield* connect(
        "anthropic",
        server.url,
        "k",
        "claude-sonnet-5-5"
      )
      const send = (breakpoints: ReadonlyArray<number>, cacheRetention?: "none" | "long") =>
        collect(
          providers.stream({
            userId,
            connectionId: connection.id,
            modelId,
            context: story,
            options: { breakpoints, ...(cacheRetention ? { cacheRetention } : {}) },
            attribution: { purpose: "generation" }
          })
        )
      const bodies = () =>
        server
          .requests()
          .filter((r) => r.path.startsWith("/v1/messages"))
          .map((r) => r.body!)

      yield* send([0, 1, 3], "long")
      const body = bodies().at(-1)!
      const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> | string }>
      // The whitespace-only message is gone; pi may append a mid-conversation system message.
      assert.deepStrictEqual(
        messages.filter((m) => m.role !== "system").map((m) => m.role),
        ["user", "assistant", "user"]
      )
      const markerOf = (i: number) => {
        const content = messages[i]!.content
        return Array.isArray(content) ? content.at(-1)!.cache_control : undefined
      }
      // The summary and the reply after it got ours; the last message has pi's.
      assert.deepStrictEqual(markerOf(0), markerOf(2))
      assert.deepStrictEqual(markerOf(1), markerOf(2))
      assert.include(JSON.stringify(markerOf(0)), "1h")
      assert.isAtMost(markersIn(body), 4)

      // With caching off pi places no markers, and neither do we.
      yield* send([0, 1], "none")
      assert.strictEqual(markersIn(bodies().at(-1)!), 0)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it("aligns merged tool results and dropped messages", () => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
    const transcript = [
      { role: "user", content: "Look around.", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "look", arguments: {} },
          { type: "toolCall", id: "b", name: "listen", arguments: {} }
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage,
        stopReason: "toolUse",
        timestamp: 2
      },
      {
        role: "toolResult",
        toolCallId: "a",
        toolName: "look",
        content: [{ type: "text", text: "Fog." }],
        isError: false,
        timestamp: 3
      },
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "listen",
        content: [{ type: "text", text: "Bells." }],
        isError: false,
        timestamp: 4
      },
      { role: "user", content: "", timestamp: 5 },
      { role: "user", content: "Go on.", timestamp: 6 }
    ] as const
    const wire = [
      { role: "user", content: "Look around." },
      { role: "assistant", content: [{ type: "tool_use" }, { type: "tool_use" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", content: [{ type: "text", text: "Fog." }] },
          { type: "tool_result", content: [{ type: "text", text: "Bells." }] }
        ]
      },
      { role: "user", content: "Go on." }
    ]
    assert.deepStrictEqual(alignTranscript(transcript as never, wire), [0, 1, 2, 2, null, 3])
  })
})

describe("review regressions", () => {
  it.live("a long prompt on a model with unknown context completes instead of failing as overflow", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, openAiList([{ id: "local" }]))
          : sse(res, completionChunks(["Fine."], { prompt_tokens: 20_000, completion_tokens: 2 }))
      )
      const { userId, connection, modelId, providers } = yield* connect(
        "openai-chat",
        `${server.url}/v1`,
        null,
        "local"
      )
      const events = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
      assert.strictEqual(events.at(-1)!.type, "done")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("honors Retry-After on an error response, and refuses a pause longer than the policy allows", () =>
    Effect.gen(function* () {
      let chats = 0
      let retryAfter = "1"
      const server = yield* mock((request, res) => {
        if (request.path.endsWith("/models")) return json(res, 200, openAiList([{ id: "m" }]))
        chats++
        if (chats === 1 || retryAfter === "5") {
          return json(res, 429, { error: { message: "slow down" } }, { "retry-after": retryAfter })
        }
        sse(res, completionChunks(["Ok."], { prompt_tokens: 10, completion_tokens: 2 }))
      })
      const { userId, connection, modelId, providers } = yield* connect("openai-chat", `${server.url}/v1`, "k", "m")
      const send = collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
      const events = yield* send
      const retrying = events.find((e) => e.type === "retrying")
      if (retrying?.type !== "retrying") return assert.fail("no retry")
      assert.strictEqual(retrying.delayMs, 1000)
      assert.isDefined(events.find((e) => e.type === "paused"))
      assert.strictEqual(events.at(-1)!.type, "done")

      // Retry-After: 5 s is beyond this test policy's 1 s: no retry, and the next request
      // on the connection fails fast instead of stalling silently.
      retryAfter = "5"
      const first = yield* send.pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(first.reason, "rate_limited")
      const before = server.requests().length
      const second = yield* send.pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(second.reason, "rate_limited")
      assert.strictEqual(server.requests().length, before, "nothing was sent during the pause")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("an invalid base URL is a typed error, never a hung stream", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "google",
        settings: settings(""),
        apiKey: "g-key-123456"
      })
      const model = yield* writer.AddUserModel({ userId, connectionId: connection.id, key: "gemini-x", overrides: {} })
      const tested = yield* providers
        .testConnection(userId, connection.id)
        .pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(tested.reason, "unusable")
      const streamed = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: model.id,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.timeout("5 seconds"), Effect.flip)
      assert.strictEqual(streamed._tag, "ProviderError")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("a stopped Anthropic request records the output that arrived, not message_start's placeholder", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) => {
        if (request.path.startsWith("/v1/models")) {
          return json(res, 200, { data: [{ id: "claude-sonnet-5-5" }], has_more: false })
        }
        res.writeHead(200, { "content-type": "text/event-stream" })
        const send = (event: Record<string, unknown>) =>
          res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
        send({
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 100, output_tokens: 1 }
          }
        })
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        for (let i = 0; i < 40; i++) {
          send({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "The tide keeps rising. " }
          })
        }
      })
      const { userId, connection, modelId, providers, reader } = yield* connect(
        "anthropic",
        server.url,
        "sk-ant-test",
        "claude-sonnet-5-5"
      )
      let texts = 0
      yield* collect(
        providers
          .stream({ userId, connectionId: connection.id, modelId, context, attribution: { purpose: "generation" } })
          .pipe(Stream.takeUntil((e) => e.type === "text" && ++texts === 40))
      )
      const [row] = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
      assert.strictEqual(row!.status, "aborted")
      assert.strictEqual(row!.usageSource, "estimated")
      assert.isAbove(row!.counts.output!, 100)
      assert.strictEqual(row!.counts.inputUncached, 100)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("scrubs a key from an error body before shortening it", () =>
    Effect.gen(function* () {
      const key = "sk-live-0123456789abcdef"
      const server = yield* mock((_request, res) => {
        res.writeHead(401, { "content-type": "text/plain" })
        res.end(`${"x".repeat(290)}${key} is not valid`)
      })
      const providers = yield* Providers.Providers
      const writer = yield* Database.Writer
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        apiKey: key
      })
      const result = yield* providers.testConnection(userId, connection.id)
      assert.isFalse(result.ok)
      assert.notInclude(result.detail, "sk-live")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("treats a whitespace-only key as no key", () =>
    Effect.gen(function* () {
      const providers = yield* Providers.Providers
      const writer = yield* Database.Writer
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const created = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings("http://127.0.0.1:1/v1"),
        apiKey: "   "
      })
      assert.isFalse(created.hasKey)
      const set = yield* providers.setKey(userId, created.id, "  sk-padded-key  ")
      assert.strictEqual(set.keyHint, "-key")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("pure pieces", () => {
  it("prices with tiers on total input and long writes at twice the input rate", () => {
    const price = {
      input: 1,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1.25,
      tiers: [{ inputTokensAbove: 200_000, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }]
    }
    const counts = {
      inputUncached: 1000,
      cacheRead: 0,
      cacheWrite: 100,
      cacheWriteLong: 40,
      output: 10,
      reasoning: null
    }
    assert.closeTo(priceCost(counts, price)!, (1000 * 1 + 60 * 1.25 + 40 * 2 + 10 * 4) / 1e6, 1e-15)
    const long = { ...counts, cacheRead: 250_000 }
    assert.closeTo(priceCost(long, price)!, (1000 * 2 + 250_000 * 0.2 + 60 * 2.5 + 40 * 4 + 10 * 8) / 1e6, 1e-12)
    assert.isNull(priceCost({ ...counts, output: null }, price))
  })

  it("scrubs every secret, longest first, and leaves short values alone", () => {
    const scrub = makeScrub(["sk-abcdef123456", "sk-abcdef", "pw", null])
    assert.strictEqual(scrub("key sk-abcdef123456 and sk-abcdef, pw"), "key [redacted] and [redacted], pw")
  })

  it("reads Retry-After as seconds or a date", () => {
    assert.strictEqual(parseRetryAfter("2"), 2000)
    assert.strictEqual(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000)
    assert.isNull(parseRetryAfter(undefined))
  })

  it("classifies by status when the SDK only left it in the message", () => {
    const failed = (errorMessage: string): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "openai",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "error",
      errorMessage,
      timestamp: 0
    })
    const seen = { status: null, retryAfterMs: null, category: null }
    assert.strictEqual(classify(failed("429 Too many requests"), seen, 8000, false)?.reason, "rate_limited")
    assert.strictEqual(classify(failed("400 bad"), seen, 8000, false)?.reason, "bad_request")
    assert.strictEqual(classify(failed("fetch failed: ECONNREFUSED"), seen, 8000, false)?.reason, "network")
    assert.strictEqual(
      classify(failed("prompt is too long: 9000 tokens > 8000 maximum"), seen, 8000, false)?.reason,
      "context_overflow"
    )
  })
})
