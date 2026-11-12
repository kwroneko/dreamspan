// The provider layer end to end (spec/PROVIDERS.md §4, §7, §9): real pi-ai adapters
// against a scripted provider speaking the real wire formats, through the network
// module and the database workers.
import type { AssistantMessage, Context as PiContext } from "@earendil-works/pi-ai"
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import { resolveModel, type ConnectionSettings, type ModelId, type ProviderKind } from "@rp/shared/providers.ts"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import { classify, parseRetryAfter } from "../src/providers/errors.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeScrub, ProviderError } from "../src/providers/Providers.ts"
import { alignTranscript } from "../src/providers/breakpoints.ts"
import { priceCost } from "../src/providers/usage.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { anthropicSse, completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = (bindKeysToOrigins = true) =>
  Providers.layer({ retry: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 1_000 }, bindKeysToOrigins }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({
        dataDir: tempDir("stream"),
        readers: 1,
        allowNetworkFs: false,
        ...testWorkers
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
      yield* providers.setHeaders(userId, connection.id, { "X-Gateway-Tag": "rp" }, connection.rowVersion)

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

describe("a model pinned to one OpenRouter provider", () => {
  const ENDPOINTS = "/v1/models/vendor/pinnable/endpoints"
  const priced = {
    data: {
      endpoints: [
        { provider_name: "Together", tag: "together", pricing: { prompt: "0.0000005", completion: "0.000001" } },
        { provider_name: "Other", tag: "other", pricing: { prompt: "0.00001", completion: "0.00002" } }
      ]
    }
  }
  type Res = Parameters<Parameters<typeof mock>[0]>[1]

  /**
   * A pinned model on a mock OpenRouter whose endpoint list `endpoints` answers. With `gate`, each
   * reply waits until the list is stored, so the close sees it whatever the scheduling.
   */
  const pinned = (endpoints: (res: Res) => void, options: { readonly gate?: boolean } = {}) =>
    Effect.gen(function* () {
      let stored: () => Promise<boolean> = async () => true
      const server = yield* mock(async (request, res) => {
        if (request.path === ENDPOINTS) return endpoints(res)
        if (request.path.endsWith("/models"))
          return json(
            res,
            200,
            openAiList([{ id: "vendor/pinnable", pricing: { prompt: "0.000002", completion: "0.00001" } }])
          )
        if (options.gate) {
          while (!(await stored())) await new Promise((wake) => setTimeout(wake, 10))
          await new Promise((wake) => setTimeout(wake, 50))
        }
        sse(res, completionChunks(["Hi."], { prompt_tokens: 1000, completion_tokens: 100 }))
      })
      const { userId, connection, modelId, providers, reader, writer } = yield* connect(
        "openrouter",
        `${server.url}/v1`,
        "k",
        "vendor/pinnable"
      )
      stored = () =>
        Effect.runPromise(reader.GetModel({ userId, modelId })).then((m) => m.upstream.endpoints !== undefined)
      // The pin is saved straight to storage: nothing has opened the model page or fetched its prices.
      const saved = yield* reader.GetModel({ userId, modelId })
      yield* writer.EditModel({
        userId,
        modelId,
        overrides: { settings: { routing: { only: ["Together"] } } },
        expectedRowVersion: saved.rowVersion
      })
      assert.isUndefined((yield* reader.GetModel({ userId, modelId })).upstream.endpoints)
      const reply = Effect.gen(function* () {
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
        return done
      })
      /** The stored list, once the background fetch has stored one. */
      const settled = Effect.gen(function* () {
        for (let i = 0; i < 500; i++) {
          const endpoints = (yield* reader.GetModel({ userId, modelId })).upstream.endpoints
          if (endpoints) return endpoints
          yield* Effect.sleep("10 millis")
        }
        return assert.fail("the endpoint list was never stored")
      })
      const asked = () => server.requests().filter((r) => r.path === ENDPOINTS).length
      return { reply, settled, asked }
    })

  const pinnedLayer = () =>
    Providers.layer({
      retry: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 1_000 },
      endpointsTimeoutMs: 3_000
    }).pipe(
      Layer.provideMerge(Network.layer),
      Layer.provideMerge(ProviderBuiltins.layer),
      Layer.provideMerge(
        Database.layer({ dataDir: tempDir("stream-pinned"), readers: 1, allowNetworkFs: false, ...testWorkers })
      ),
      Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
    )

  it.live("is costed at the pinned provider's price from its first reply, its page never opened", () =>
    Effect.gen(function* () {
      const { reply, settled } = yield* pinned((res) => json(res, 200, priced), { gate: true })
      const done = yield* reply
      // 1000 × $0.5/M + 100 × $1/M, not the model's $2/M and $10/M (0.003).
      assert.strictEqual(done.cost?.formula, "builtin")
      assert.closeTo(done.cost!.amount, 0.0006, 1e-12)
      assert.strictEqual((yield* settled).list.length, 2)
    }).pipe(Effect.scoped, Effect.provide(pinnedLayer()))
  )

  it.live("keeps the model's general price when the provider list can't be had", () =>
    Effect.gen(function* () {
      const { reply, settled } = yield* pinned((res) => json(res, 404, { error: { message: "none" } }), {
        gate: true
      })
      const done = yield* reply
      assert.closeTo(done.cost!.amount, 0.003, 1e-12)
      assert.match((yield* settled).error ?? "", /not_found/)
    }).pipe(Effect.scoped, Effect.provide(pinnedLayer()))
  )

  it.live("a list that never answers delays no reply, is asked for once, and is stored as failed", () =>
    Effect.gen(function* () {
      const { reply, settled, asked } = yield* pinned(() => {})
      const started = Date.now()
      // Two replies at once (a backfill, say): neither waits for the list, and it's asked for once.
      const [a, b] = yield* Effect.all([reply, reply], { concurrency: 2 })
      assert.isBelow(Date.now() - started, 2_500)
      assert.closeTo(a.cost!.amount, 0.003, 1e-12)
      assert.closeTo(b.cost!.amount, 0.003, 1e-12)
      assert.strictEqual(asked(), 1)
      // The timeout is stored as a failure, so the next reply doesn't ask again.
      assert.match((yield* settled).error ?? "", /no answer/)
      yield* reply
      assert.strictEqual(asked(), 1)
    }).pipe(Effect.scoped, Effect.provide(pinnedLayer()))
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
      yield* providers.setHeaders(userId, connection.id, { "X-Token": "tok-secret-header" }, connection.rowVersion)
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

  it.live("reports a failed Google proxy without going direct", () =>
    Effect.gen(function* () {
      const network = yield* Network.Network
      yield* network.setInstance({ proxyUrl: "http://127.0.0.1:9", bypass: [], forceProxy: false })
      const writer = yield* Database.Writer
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "google",
        settings: settings("http://127.0.0.1:1"),
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
      assert.strictEqual(error.reason, "network")
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
        apiKey: null
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
      const set = yield* providers.setKey(userId, created.id, "  sk-padded-key  ", created.rowVersion)
      assert.strictEqual(set.keyHint, "-key")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("keys bound to hosts", () => {
  const listAndChat = (request: { path: string }, res: Parameters<typeof json>[0]) =>
    request.path.endsWith("/models")
      ? json(res, 200, openAiList([{ id: "m" }]))
      : sse(res, completionChunks(["Ok."], { prompt_tokens: 5, completion_tokens: 2 }))

  it.live("a key is never sent to a host it wasn't entered for, until it's typed again", () =>
    Effect.gen(function* () {
      const home = yield* mock(listAndChat)
      const elsewhere = yield* mock(listAndChat)
      const key = "sk-home-key-0123456789"
      const { userId, connection, modelId, providers, writer } = yield* connect(
        "openai-chat",
        `${home.url}/v1`,
        key,
        "m"
      )
      assert.strictEqual(connection.credentialName, "Test")

      // Something acting as the user points the connection elsewhere.
      yield* writer.UpdateConnection({
        userId,
        connectionId: connection.id,
        settings: settings(`${elsewhere.url}/v1`),
        expectedRowVersion: connection.rowVersion
      })
      const send = collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
      const refused = yield* send.pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(refused.reason, "unusable")
      assert.include(refused.message, "enter the key again")
      assert.isFalse(
        (yield* providers.testConnection(userId, connection.id).pipe(Effect.flip, Effect.map(asProviderError)))
          .afterTokens
      )
      assert.strictEqual(elsewhere.requests().length, 0, "the other host never saw a request")

      // A wrong key doesn't unlock it; the right one does.
      const wrong = yield* providers
        .allowCredentialOrigin({
          userId,
          credentialId: connection.credentialId!,
          apiKey: "sk-guess",
          url: elsewhere.url
        })
        .pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(wrong.reason, "auth")
      const allowed = yield* providers.allowCredentialOrigin({
        userId,
        credentialId: connection.credentialId!,
        apiKey: ` ${key} `,
        url: `${elsewhere.url}/v1`
      })
      assert.sameMembers([...allowed.origins], [home.url, elsewhere.url])
      assert.strictEqual((yield* send).at(-1)!.type, "done")
      assert.strictEqual(elsewhere.requests().at(-1)!.headers.authorization, `Bearer ${key}`)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("one credential serves several connections, and replacing its key updates them all", () =>
    Effect.gen(function* () {
      const server = yield* mock(listAndChat)
      const providers = yield* Providers.Providers
      const writer = yield* Database.Writer
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const credential = yield* providers.createCredential({
        userId,
        name: "Gateway",
        apiKey: "sk-first-key-1111",
        urls: [`${server.url}/v1`]
      })
      const a = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        credentialId: credential.id
      })
      const b = yield* providers.createConnection({
        userId,
        kind: "openrouter",
        settings: settings(`${server.url}/api/v1`),
        credentialId: credential.id
      })
      assert.strictEqual(a.keyHint, "1111")
      assert.strictEqual(b.keyHint, "1111")
      yield* providers.replaceCredentialKey(userId, credential.id, "sk-second-key-2222", credential.origins)
      for (const connection of [a, b]) {
        yield* providers.refreshModels(userId, connection.id)
      }
      const auths = server.requests().map((r) => r.headers.authorization)
      assert.deepStrictEqual(auths, ["Bearer sk-second-key-2222", "Bearer sk-second-key-2222"])
      // The path differs between the two connections; the origin is what's bound.
      assert.deepStrictEqual(
        [...(yield* (yield* Database.Reader).ListCredentials({ userId }))[0]!.origins],
        [server.url]
      )
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("can be switched off from outside the app", () =>
    Effect.gen(function* () {
      const home = yield* mock(listAndChat)
      const elsewhere = yield* mock(listAndChat)
      const { userId, connection, modelId, providers, writer } = yield* connect(
        "openai-chat",
        `${home.url}/v1`,
        "sk-home-key-0123456789",
        "m"
      )
      yield* writer.UpdateConnection({
        userId,
        connectionId: connection.id,
        settings: settings(`${elsewhere.url}/v1`),
        expectedRowVersion: connection.rowVersion
      })
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
    }).pipe(Effect.scoped, Effect.provide(layer(false)))
  )
})

describe("secrets stay where they were entered (audit regressions)", () => {
  const listing = (_request: unknown, res: Parameters<Parameters<typeof startMockProvider>[0]>[1]) =>
    json(res, 200, openAiList([{ id: "m" }]))
  const user = (handle: string) =>
    Effect.flatMap(Database.Writer, (writer) => writer.EnsureUser({ handle, displayName: handle })).pipe(
      Effect.map((u) => u.id as UserId)
    )
  const flipped = <A>(effect: Effect.Effect<A, ProviderError | { readonly _tag: string }>) =>
    effect.pipe(Effect.flip, Effect.map(asProviderError))

  it.live("a replaced key doesn't inherit hosts approved under the old one", () =>
    Effect.gen(function* () {
      const good = yield* mock(listing)
      const evil = yield* mock(listing)
      const providers = yield* Providers.Providers
      const userId = yield* user("ana")
      // A stolen session: swap in a junk key, approve evil with it, wait for the real key.
      const credential = yield* providers.createCredential({
        userId,
        name: "Gateway",
        apiKey: "sk-real-key-0001",
        urls: [`${good.url}/v1`]
      })
      yield* providers.replaceCredentialKey(userId, credential.id, "junk-key-for-evil", [`${good.url}/v1`])
      yield* providers.allowCredentialOrigin({
        userId,
        credentialId: credential.id,
        apiKey: "junk-key-for-evil",
        url: evil.url
      })
      const replaced = yield* providers.replaceCredentialKey(userId, credential.id, "sk-real-key-0001", [
        `${good.url}/v1`
      ])
      assert.deepStrictEqual([...replaced.origins], [good.url])
      const pointed = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${evil.url}/v1`),
        credentialId: credential.id
      })
      assert.strictEqual((yield* flipped(providers.testConnection(userId, pointed.id))).reason, "unusable")
      assert.lengthOf(evil.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("header values are bound to the host they were set for", () =>
    Effect.gen(function* () {
      const good = yield* mock(listing)
      const evil = yield* mock(listing)
      const providers = yield* Providers.Providers
      const writer = yield* Database.Writer
      const userId = yield* user("ana")
      const created = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${good.url}/v1`),
        apiKey: null
      })
      const headed = yield* providers.setHeaders(
        userId,
        created.id,
        { authorization: "Bearer sk-in-a-header" },
        created.rowVersion
      )
      assert.isTrue((yield* providers.testConnection(userId, created.id)).ok)
      const moved = yield* writer.UpdateConnection({
        userId,
        connectionId: created.id,
        settings: settings(`${evil.url}/v1`),
        expectedRowVersion: headed.rowVersion
      })
      assert.strictEqual((yield* flipped(providers.testConnection(userId, created.id))).reason, "unusable")
      assert.lengthOf(evil.requests(), 0)
      // Setting them again, for the host the user now sees, is the way to move them.
      yield* providers.setHeaders(userId, created.id, { authorization: "Bearer sk-in-a-header" }, moved.rowVersion)
      assert.isTrue((yield* providers.testConnection(userId, created.id)).ok)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("redirects are followed within the origin, never to another", () =>
    Effect.gen(function* () {
      const evil = yield* mock(listing)
      const redirecting = yield* mock((request, res) => {
        res.writeHead(307, { location: `${evil.url}${request.path}` })
        res.end()
      })
      const providers = yield* Providers.Providers
      const userId = yield* user("ana")
      // Anthropic sends its key as x-api-key, which undici would carry across origins.
      const connection = yield* providers.createConnection({
        userId,
        kind: "anthropic",
        settings: settings(redirecting.url),
        apiKey: "sk-ant-key-0001"
      })
      yield* flipped(providers.refreshModels(userId, connection.id))
      assert.lengthOf(evil.requests(), 0)

      const sameOrigin = yield* mock((request, res) => {
        if (request.path !== "/v1/models") return json(res, 200, openAiList([{ id: "m" }]))
        res.writeHead(308, { location: "/v1/models/" })
        res.end()
      })
      const followed = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${sameOrigin.url}/v1`),
        apiKey: "sk-same-origin-01"
      })
      assert.isTrue((yield* providers.testConnection(userId, followed.id)).ok)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("a connection's own proxy can't carry its key over http", () =>
    Effect.gen(function* () {
      const target = yield* mock(listing)
      const proxy = yield* mock(listing)
      const providers = yield* Providers.Providers
      const userId = yield* user("ana")
      const connection = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${target.url}/v1`),
        apiKey: "sk-lan-key-0001"
      })
      yield* providers.setProxy(userId, connection.id, "custom", proxy.url)
      assert.strictEqual((yield* flipped(providers.testConnection(userId, connection.id))).reason, "unusable")
      assert.lengthOf(proxy.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("typing a key replaces the connection's own old key, and needs the version the user saw", () =>
    Effect.gen(function* () {
      const providers = yield* Providers.Providers
      const reader = yield* Database.Reader
      const userId = yield* user("ana")
      const named = yield* providers.createCredential({
        userId,
        name: "Mine",
        apiKey: "sk-named-key-01",
        urls: ["http://127.0.0.1:1"]
      })
      const created = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings("http://127.0.0.1:1/v1"),
        apiKey: "sk-first-typed-1"
      })
      const second = yield* providers.setKey(userId, created.id, "sk-second-typed", created.rowVersion)
      const third = yield* providers.setKey(userId, created.id, "sk-third-typed-3", second.rowVersion)
      assert.deepStrictEqual((yield* reader.ListCredentials({ userId })).map((c) => c.name).sort(), ["Mine", "Test"])
      // A stale form (an older row version) is refused rather than binding to a changed URL,
      // as a StaleWrite the client can reload on.
      assert.strictEqual(
        (yield* Effect.flip(providers.setKey(userId, created.id, "sk-stale-form-1", created.rowVersion)))._tag,
        "StaleWrite"
      )
      assert.strictEqual(
        (yield* Effect.flip(providers.setHeaders(userId, created.id, { "X-Token": "value-1" }, created.rowVersion)))
          ._tag,
        "StaleWrite"
      )
      // A credential the user named and attached is never deleted by typing a new key.
      const attached = yield* (yield* Database.Writer).SetConnectionCredential({
        userId,
        connectionId: created.id,
        credentialId: named.id
      })
      yield* providers.setKey(userId, created.id, null, attached.rowVersion)
      assert.include(
        (yield* reader.ListCredentials({ userId })).map((c) => c.name),
        "Mine"
      )
      assert.strictEqual(third.keyHint, "ed-3")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("purging a connection deletes the key typed into it, unless something else uses it", () =>
    Effect.gen(function* () {
      const providers = yield* Providers.Providers
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const userId = yield* user("ana")
      const purgeConnection = (connectionId: Parameters<typeof writer.DeleteConnection>[0]["connectionId"]) =>
        Effect.flatMap(writer.DeleteConnection({ userId, connectionId }), (item) =>
          writer.PurgeBinItem({ userId, itemId: item.id })
        )
      const typed = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings("http://127.0.0.1:1/v1"),
        apiKey: "sk-typed-for-one-1"
      })
      // A connection-owned key shared with a second connection stays while that one uses it.
      const sharer = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings("http://127.0.0.1:1/v1"),
        credentialId: typed.credentialId!
      })
      yield* purgeConnection(typed.id)
      assert.lengthOf(yield* reader.ListCredentials({ userId }), 1)
      yield* purgeConnection(sharer.id)
      assert.lengthOf(yield* reader.ListCredentials({ userId }), 0)
      // A credential the user created stays after its connection is purged.
      const named = yield* providers.createCredential({
        userId,
        name: "Mine",
        apiKey: "sk-named-key-02",
        urls: ["http://127.0.0.1:1"]
      })
      const user_ = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings("http://127.0.0.1:1/v1"),
        credentialId: named.id
      })
      yield* purgeConnection(user_.id)
      assert.deepStrictEqual(
        (yield* reader.ListCredentials({ userId })).map((c) => c.name),
        ["Mine"]
      )
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("a failed create keeps no key, and short keys get no hint", () =>
    Effect.gen(function* () {
      const providers = yield* Providers.Providers
      const reader = yield* Database.Reader
      const userId = yield* user("ana")
      yield* flipped(
        providers.createConnection({
          userId,
          kind: "openai-chat",
          settings: { ...settings("http://127.0.0.1:1/v1"), presetOverrideRefId: "missing" as never },
          apiKey: "sk-orphan-key-01"
        })
      )
      assert.lengthOf(yield* reader.ListCredentials({ userId }), 0)
      const short = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings("http://127.0.0.1:1/v1"),
        apiKey: "abcd"
      })
      assert.strictEqual(short.keyHint, "")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("model ids named like Object.prototype members don't break a refresh", () =>
    Effect.gen(function* () {
      const server = yield* mock((_r, res) => json(res, 200, openAiList([{ id: "constructor" }, { id: "__proto__" }])))
      const providers = yield* Providers.Providers
      const userId = yield* user("ana")
      const connection = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        apiKey: null
      })
      const refreshed = yield* providers.refreshModels(userId, connection.id)
      assert.strictEqual(refreshed.added, 2)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("a kind overridden with another wire API makes its old connections unusable, not different", () =>
    Effect.gen(function* () {
      const server = yield* mock(listing)
      const registry = yield* ProviderRegistry
      const providers = yield* Providers.Providers
      const userId = yield* user("ana")
      const connection = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        apiKey: null
      })
      const builtin = registry.kinds.get("openai-chat")!
      // register replaces an entry with the same id for as long as its scope lives.
      yield* registry.kinds.register({ ...builtin, api: "openai-responses" })
      assert.strictEqual((yield* flipped(providers.testConnection(userId, connection.id))).reason, "unusable")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("a refused redirect during a stream is reported as such, and not retried", () =>
    Effect.gen(function* () {
      const evil = yield* mock(listing)
      const server = yield* mock((request, res) => {
        if (request.path.endsWith("/models")) return json(res, 200, openAiList([{ id: "m" }]))
        res.writeHead(307, { location: `${evil.url}/steal` })
        res.end()
      })
      const { userId, connection, modelId, providers } = yield* connect(
        "openai-chat",
        `${server.url}/v1`,
        "sk-stream-key-01",
        "m"
      )
      const error = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(error.reason, "unusable")
      assert.include(error.message, "refused a redirect")
      assert.lengthOf(
        server.requests().filter((r) => r.path.endsWith("/chat/completions")),
        1
      )
      assert.lengthOf(evil.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("requiring the proxy needs a proxy", () =>
    Effect.gen(function* () {
      const network = yield* Network.Network
      const refused = yield* network.setInstance({ proxyUrl: null, bypass: [], forceProxy: true }).pipe(Effect.flip)
      assert.strictEqual(refused._tag, "InvalidNetworkSettings")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("an admin can require the instance proxy for everyone else", () =>
    Effect.gen(function* () {
      const target = yield* mock(listing)
      const proxy = yield* mock(listing)
      const providers = yield* Providers.Providers
      const network = yield* Network.Network
      const admin = yield* user("ana")
      const bo = yield* user("bo")
      const own = yield* providers.createConnection({
        userId: bo,
        kind: "openai-chat",
        settings: settings(`${target.url}/v1`),
        apiKey: null
      })
      yield* providers.setProxy(bo, own.id, "direct", null)
      // The target is on loopback, which the default bypass list sends direct; clear it.
      yield* network.setInstance({ proxyUrl: proxy.url, bypass: [], forceProxy: true })
      const tested = yield* providers.testConnection(bo, own.id)
      assert.isTrue(tested.ok)
      assert.lengthOf(target.requests(), 0)
      assert.isAbove(proxy.requests().length, 0)
      assert.strictEqual((yield* flipped(providers.setProxy(bo, own.id, "direct", null))).reason, "bad_request")
      const admins = yield* providers.createConnection({
        userId: admin,
        kind: "openai-chat",
        settings: settings(`${target.url}/v1`),
        apiKey: null
      })
      yield* providers.setProxy(admin, admins.id, "direct", null)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("provider registry", () => {
  it.live("a plugin can add a provider kind and a request transform, and both go away with its scope", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, openAiList([{ id: "m" }]))
          : sse(res, completionChunks(["Hi."], { prompt_tokens: 5, completion_tokens: 2 }))
      )
      const registry = yield* ProviderRegistry
      const providers = yield* Providers.Providers
      const builtin = registry.kinds.get("openai-chat")!
      const plugin = yield* Scope.make()
      // A gateway kind that reuses Chat Completions with its own default URL, and a
      // transform that tags every request it sends.
      yield* Scope.provide(plugin)(
        Effect.all([
          registry.kinds.register({
            ...builtin,
            id: "my-gateway",
            label: "My gateway",
            defaultBaseUrl: `${server.url}/v1`
          }),
          registry.transforms.register({
            id: "tag-requests",
            appliesTo: (target) => target.kind === "my-gateway",
            transform: (payload) => ({ ...payload, user: "rp-harness" })
          })
        ])
      )
      assert.include(
        providers.kinds().map((k) => k.id),
        "my-gateway"
      )
      const { userId, connection, modelId } = yield* connect("my-gateway", `${server.url}/v1`, null, "m")
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
      const sent = server.requests().find((r) => r.path.endsWith("/chat/completions"))!
      assert.strictEqual(sent.body!.user, "rp-harness")

      // Closing the plugin's scope unregisters both; its connection becomes unusable.
      yield* Scope.close(plugin, Exit.void)
      assert.notInclude(
        providers.kinds().map((k) => k.id),
        "my-gateway"
      )
      const gone = yield* providers.testConnection(userId, connection.id).pipe(Effect.flip, Effect.map(asProviderError))
      assert.strictEqual(gone.reason, "unusable")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("cost formulas: a registered one goes first, and disabling one falls through to the next", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path === "/api/v1/models"
          ? json(res, 200, openAiList([{ id: "v/m", pricing: { prompt: "0.000001", completion: "0.000002" } }]))
          : sse(res, completionChunks(["Hi."], { prompt_tokens: 100, completion_tokens: 5, cost: 0.00042 }))
      )
      const registry = yield* ProviderRegistry
      const { userId, connection, modelId, providers } = yield* connect(
        "openrouter",
        `${server.url}/api/v1`,
        "sk-or-cost-0001",
        "v/m"
      )
      const costOfRun = collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.map((events) => (events.at(-1) as { cost: unknown }).cost))

      assert.deepStrictEqual(yield* costOfRun, { amount: 0.00042, currency: "USD", formula: "reported" })
      const flat = yield* Scope.make()
      yield* Scope.provide(flat)(
        registry.costs.register({
          id: "flat-fee",
          appliesTo: (target) => target.kind === "openrouter" && target.model === "v/m",
          cost: () => ({ amount: 1, currency: "EUR" })
        })
      )
      assert.deepStrictEqual(yield* costOfRun, { amount: 1, currency: "EUR", formula: "flat-fee" })
      yield* Scope.close(flat, Exit.void)
      // Without the provider's figure, the price table prices it: 100 in, 5 out.
      yield* registry.costs.disable("reported")
      assert.deepStrictEqual(yield* costOfRun, { amount: 0.00011, currency: "USD", formula: "builtin" })
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it("lists built-in kinds in picker order", () =>
    assert.deepStrictEqual(
      ProviderBuiltins.builtinKinds.map((k) => k.id),
      [
        "openai-chat",
        "anthropic",
        "openai-responses",
        "openrouter",
        "deepseek",
        "google",
        "anthropic-bedrock",
        "anthropic-vertex",
        "openai-responses-bedrock",
        "openai-chat-bedrock",
        "system-one"
      ]
    ))
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

  it("scrubs every nonempty secret, longest first", () => {
    const scrub = makeScrub(["sk-abcdef123456", "sk-abcdef", "pw", null])
    assert.strictEqual(scrub("key sk-abcdef123456 and sk-abcdef, pw"), "key [redacted] and [redacted], [redacted]")
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

it.live("Google's REST adapter preserves fragmented SSE, thinking, tools and cache usage", () =>
  Effect.gen(function* () {
    const server = yield* mock((_request, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      const chunks = [
        {
          responseId: "synthetic-response",
          candidates: [
            { content: { parts: [{ text: "Think", thought: true, thoughtSignature: "thinking-signature" }] } }
          ]
        },
        { candidates: [{ content: { parts: [{ text: "Synthetic ", thoughtSignature: "text-signature" }] } }] },
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "answer" },
                  { functionCall: { name: "lookup", args: { place: "harbor" } }, thoughtSignature: "tool-signature" }
                ]
              },
              finishReason: "STOP"
            }
          ],
          usageMetadata: {
            promptTokenCount: 120,
            cachedContentTokenCount: 100,
            candidatesTokenCount: 6,
            thoughtsTokenCount: 3,
            totalTokenCount: 129,
            syntheticExtraUsage: 7
          }
        }
      ]
      const wire = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("")
      // Split the JSON strings and CRLF delimiters, rather than relying on socket chunks.
      for (let i = 0; i < wire.length; i += 7) res.write(wire.slice(i, i + 7))
      res.end()
    })
    const registry = yield* ProviderRegistry
    const rawChunks: unknown[] = []
    yield* registry.observers.register({
      id: "synthetic-google-observer",
      appliesTo: () => true,
      observe: (data) => {
        rawChunks.push(data)
      }
    })
    const writer = yield* Database.Writer
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const connection = yield* providers.createConnection({
      userId,
      kind: "google",
      settings: settings(server.url),
      apiKey: "synthetic-google-key"
    })
    const model = yield* writer.AddUserModel({
      userId,
      connectionId: connection.id,
      key: "gemini-2.5-pro",
      overrides: { reasoning: true }
    })
    const events = yield* collect(
      providers.stream({
        userId,
        connectionId: connection.id,
        modelId: model.id,
        context,
        options: { reasoning: "low" },
        attribution: { purpose: "generation" }
      })
    )
    const done = events.find((e) => e.type === "done")!
    if (done.type !== "done") return assert.fail("no final message")
    assert.equal(done.message.responseId, "synthetic-response")
    assert.equal(done.message.stopReason, "toolUse")
    assert.deepEqual(
      done.message.content.map((b) => b.type),
      ["thinking", "text", "toolCall"]
    )
    assert.equal(done.counts.cacheRead, 100)
    assert.equal(done.counts.inputUncached, 20)
    assert.equal(done.counts.reasoning, 3)
    assert.equal(
      done.message.content[0]!.type === "thinking" && done.message.content[0]!.thinkingSignature,
      "thinking-signature"
    )
    const reader = yield* Database.Reader
    const ledger = (yield* reader.ListLlmRequests({ userId, limit: 1, before: null }))[0]!
    assert.equal(ledger.counts.cacheRead, 100)
    assert.include(JSON.stringify(rawChunks), '"syntheticExtraUsage":7')
    const body = server.requests()[0]!.body!
    assert.deepEqual(body.systemInstruction, { role: "user", parts: [{ text: "You are the narrator." }] })
    assert.deepEqual((body.generationConfig as Record<string, unknown>).thinkingConfig, {
      includeThoughts: true,
      thinkingBudget: 2048
    })
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

it.live("stopping Google aborts its HTTP stream and closes the ledger row", () =>
  Effect.gen(function* () {
    let closed = false
    const server = yield* mock((_request, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Synthetic" }] } }] })}\n\n`)
      res.on("close", () => {
        closed = true
      })
    })
    const writer = yield* Database.Writer
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const connection = yield* providers.createConnection({
      userId,
      kind: "google",
      settings: settings(server.url),
      apiKey: "synthetic-google-key"
    })
    const model = yield* writer.AddUserModel({ userId, connectionId: connection.id, key: "gemini-x", overrides: {} })
    yield* collect(
      providers
        .stream({
          userId,
          connectionId: connection.id,
          modelId: model.id,
          context,
          attribution: { purpose: "generation" }
        })
        .pipe(Stream.takeUntil((e) => e.type === "text"))
    )
    const reader = yield* Database.Reader
    const [row] = yield* reader.ListLlmRequests({ userId, limit: 1, before: null })
    assert.equal(row!.status, "aborted")
    yield* Effect.sleep(50)
    assert.isTrue(closed)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)
it.live("Google refuses cross-origin redirects without retrying or sending the key onward", () =>
  Effect.gen(function* () {
    const evil = yield* mock((_r, res) => json(res, 200, {}))
    const server = yield* mock((_r, res) => {
      res.writeHead(307, { location: evil.url + "/steal" })
      res.end()
    })
    const writer = yield* Database.Writer
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const connection = yield* providers.createConnection({
      userId,
      kind: "google",
      settings: settings(server.url),
      apiKey: "synthetic-google-key"
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
    assert.equal(error.reason, "unusable")
    assert.include(error.message, "refused a redirect")
    assert.lengthOf(server.requests(), 1)
    assert.lengthOf(evil.requests(), 0)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

it.live("Google applies a custom thinking-level map once and keeps tool call ids unique", () =>
  Effect.gen(function* () {
    const server = yield* mock((_r, res) =>
      sse(
        res,
        [
          {
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { id: "synthetic-call", name: "lookup", args: { place: "harbor" } } },
                    { functionCall: { id: "synthetic-call", name: "lookup", args: { place: "dock" } } }
                  ]
                },
                finishReason: "STOP"
              }
            ]
          }
        ],
        { done: false }
      )
    )
    const registry = yield* ProviderRegistry
    yield* registry.kinds.register({
      ...registry.kinds.get("google")!,
      catalog: async () => ({
        "gemini-3-flash": {
          id: "gemini-3-flash",
          name: "Synthetic",
          api: "google-generative-ai",
          provider: "google",
          baseUrl: server.url,
          reasoning: true,
          input: ["text"],
          contextWindow: 8192,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          headers: { "X-Shared": "synthetic-catalog-header" }
        }
      })
    })
    const writer = yield* Database.Writer
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const connection = yield* providers.createConnection({
      userId,
      kind: "google",
      settings: settings(server.url),
      apiKey: "synthetic-google-key"
    })
    yield* providers.setHeaders(
      userId,
      connection.id,
      { "x-shared": "synthetic-connection-header" },
      connection.rowVersion
    )
    const model = yield* writer.AddUserModel({
      userId,
      connectionId: connection.id,
      key: "gemini-3-flash",
      overrides: { reasoning: true, thinkingLevels: { low: "medium", medium: "high" } }
    })
    const events = yield* collect(
      providers.stream({
        userId,
        connectionId: connection.id,
        modelId: model.id,
        context,
        options: { reasoning: "low" },
        attribution: { purpose: "generation" }
      })
    )
    assert.equal(server.requests()[0]!.headers["x-shared"], "synthetic-connection-header")
    const body = server.requests()[0]!.body!
    assert.deepEqual((body.generationConfig as Record<string, unknown>).thinkingConfig, {
      includeThoughts: true,
      thinkingLevel: "MEDIUM"
    })
    const done = events.find((e) => e.type === "done")!
    if (done.type !== "done") return assert.fail("no final message")
    const calls = done.message.content.filter((b) => b.type === "toolCall")
    assert.lengthOf(calls, 2)
    assert.equal(calls[0]!.id, "synthetic-call")
    assert.notEqual(calls[0]!.id, calls[1]!.id)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

it.live("user pricing persists, snapshots in-flight requests and never reprices historical ledger rows", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let waiting = true
    const server = yield* mock(async (request, res) => {
      if (request.path.endsWith("/models"))
        return json(res, 200, openAiList([{ id: "m", pricing: { prompt: "0.000002", completion: "0.00001" } }]))
      if (waiting) {
        waiting = false
        started.resolve()
        await release.promise
      }
      sse(
        res,
        completionChunks(["Hi."], { prompt_tokens: 100, completion_tokens: 10, cost: 123 }, { provider: "Route" })
      )
    })
    const { userId, connection, modelId, providers, reader, writer } = yield* connect(
      "openrouter",
      `${server.url}/v1`,
      "key",
      "m"
    )
    const rule = {
      id: "private",
      name: "Contract",
      kind: null,
      connectionId: connection.id,
      model: "m",
      upstream: "Route",
      currency: "credits",
      rates: { input: 2, read: 0, write: 0, writeLong: 0, output: 3 },
      tiers: []
    }
    yield* writer.SetCostSettings({ userId, expectedRevision: 0, rules: [rule] })
    assert.deepStrictEqual((yield* reader.GetCostSettings({ userId })).rules, [rule])
    const stream = () =>
      collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
    const running = yield* stream().pipe(Effect.forkChild)
    yield* Effect.promise(() => started.promise)
    yield* writer.SetCostSettings({
      userId,
      expectedRevision: 1,
      rules: [{ ...rule, rates: { ...rule.rates, input: 20 } }]
    })
    release.resolve()
    yield* Fiber.join(running)
    const [first] = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
    assert.deepStrictEqual(first!.cost, { amount: 230 / 1e6, currency: "credits", formula: "user:private:1" })
    yield* stream()
    const rows = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
    assert.deepStrictEqual(rows.find((r) => r.id === first!.id)!.cost, first!.cost)
    assert.deepStrictEqual(rows.find((r) => r.id !== first!.id)!.cost, {
      amount: 2030 / 1e6,
      currency: "credits",
      formula: "user:private:2"
    })
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(writer.SetCostSettings({ userId, expectedRevision: 1, rules: [] })))
    )
    const estimate = yield* providers.estimateCost(userId, connection.id, modelId, {
      inputUncached: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWriteLong: 0,
      output: 10,
      reasoning: 0
    })
    // Unknown upstream cannot silently take a route-specific price as certain.
    assert.isNull(estimate)
    yield* writer.SetCostSettings({ userId, expectedRevision: 2, rules: [{ ...rule, upstream: null }] })
    const ownEstimate = yield* providers.estimateCost(userId, connection.id, modelId, {
      inputUncached: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWriteLong: 0,
      output: 10,
      reasoning: 0
    })
    assert.deepStrictEqual(ownEstimate, { amount: 230 / 1e6, currency: "credits", formula: "user:private:3" })
    yield* writer.SetCostSettings({ userId, expectedRevision: 3, rules: [] })
    yield* stream()
    const after = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
    assert.equal(after[0]!.cost!.formula, "reported")
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

it.live("Google lists pages with its key, merges catalog modalities and prices, and tests without generating", () =>
  Effect.gen(function* () {
    let refused = false
    const server = yield* mock((request, res) => {
      assert.equal(request.headers["x-goog-api-key"], "synthetic-google-key")
      assert.isUndefined(request.headers.authorization)
      const url = new URL(request.path, "http://example.invalid")
      assert.equal(url.pathname, "/v1beta/models")
      assert.equal(url.searchParams.get("pageSize"), "1000")
      if (refused) return json(res, 403, { error: { message: "Synthetic key denied" } })
      if (url.searchParams.get("pageToken")) {
        assert.equal(url.searchParams.get("pageToken"), "next +/page")
        return json(res, 200, {
          models: [{ name: "models/synthetic-new", inputTokenLimit: 32000, outputTokenLimit: 2000, thinking: false }]
        })
      }
      json(res, 200, {
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Listed Flash",
            inputTokenLimit: 900000,
            outputTokenLimit: 32000,
            thinking: true,
            supportedGenerationMethods: ["generateContent", "countTokens"]
          },
          { name: "models/text-embedding-synthetic", supportedGenerationMethods: ["embedContent"] }
        ],
        nextPageToken: "next +/page"
      })
    })
    const { userId, connection, providers, reader } = yield* connect(
      "google",
      `${server.url}/v1beta`,
      "synthetic-google-key",
      "gemini-2.5-flash"
    )
    assert.equal(connection.provider, "google")
    assert.equal(connection.api, "google-generative-ai")
    const tested = yield* providers.testConnection(userId, connection.id)
    assert.isTrue(tested.ok)
    assert.equal(tested.models, 2)
    assert.include(tested.route!, "direct")
    const models = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
    const known = models.find((m) => m.key === "gemini-2.5-flash")!
    const resolved = resolveModel(known.key, known.upstream, known.overrides)
    assert.equal(resolved.context.value, 900000)
    assert.equal(resolved.maxOutput.value, 32000)
    assert.isTrue(resolved.vision.value)
    assert.isTrue(resolved.reasoning.value)
    assert.isAbove(known.upstream.price!.input, 0)
    const unknown = models.find((m) => m.key === "synthetic-new")!
    assert.equal(resolveModel(unknown.key, unknown.upstream, unknown.overrides).vision.source, "unknown")
    assert.isUndefined(unknown.upstream.price)
    refused = true
    const bad = yield* providers.testConnection(userId, connection.id)
    assert.isFalse(bad.ok)
    assert.include(bad.detail, "auth")
    assert.notInclude(JSON.stringify(bad), "synthetic-google-key")
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

for (const [name, response] of [
  ["blocked prompt", { promptFeedback: { blockReason: "OTHER" } }],
  ["blocked candidate", { candidates: [{ finishReason: "IMAGE_SAFETY" }] }]
] as const)
  it.live(`Google ${name} is a refusal and sends one attempt`, () =>
    Effect.gen(function* () {
      const server = yield* mock((_req, res) => sse(res, [response], { done: false }))
      const writer = yield* Database.Writer
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "google",
        settings: settings(server.url),
        apiKey: "synthetic-key"
      })
      const model = yield* writer.AddUserModel({
        userId,
        connectionId: connection.id,
        key: "synthetic-model",
        overrides: {}
      })
      const error = yield* collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: model.id,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.flip, Effect.map(asProviderError))
      assert.equal(error.reason, "refused")
      assert.equal(server.requests().length, 1)
      const reader = yield* Database.Reader
      assert.equal((yield* reader.ListLlmRequests({ userId, limit: 5, before: null }))[0]!.status, "failed")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

for (const afterTokens of [false, true])
  it.live(`Google retries a transient stream error ${afterTokens ? "never after" : "before"} output`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const server = yield* mock((_req, res) => {
        attempts++
        sse(
          res,
          attempts === 1
            ? [
                ...(afterTokens ? [{ candidates: [{ content: { parts: [{ text: "Partial" }] } }] }] : []),
                { error: { code: 503, status: "UNAVAILABLE", message: "Synthetic overloaded model" } }
              ]
            : [{ candidates: [{ content: { parts: [{ text: "Recovered" }] }, finishReason: "STOP" }] }],
          { done: false }
        )
      })
      const writer = yield* Database.Writer
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "google",
        settings: settings(server.url),
        apiKey: "synthetic-key"
      })
      const model = yield* writer.AddUserModel({
        userId,
        connectionId: connection.id,
        key: "synthetic-model",
        overrides: {}
      })
      const send = collect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: model.id,
          context,
          attribution: { purpose: "generation" }
        })
      )
      if (afterTokens) {
        const error = yield* send.pipe(Effect.flip, Effect.map(asProviderError))
        assert.isTrue(error.afterTokens)
      } else {
        const events = yield* send
        assert.equal(events.at(-1)!.type, "done")
        assert.isTrue(events.some((e) => e.type === "retrying"))
      }
      assert.equal(attempts, afterTokens ? 1 : 2)
      const reader = yield* Database.Reader
      const rows = yield* reader.ListLlmRequests({ userId, limit: 5, before: null })
      assert.lengthOf(rows, attempts)
      assert.isTrue(rows.some((r) => r.status === "failed"))
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
