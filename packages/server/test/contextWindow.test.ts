// A model's context window from every source, in order (owner report 2026-10-31: a model whose
// connection reports no window was silently budgeted at 8,192): the user's setting, a limit
// learned from the provider's error, the provider's list, a catalog matched by id, then an
// assumption shown as one. Synthetic lists and error bodies only.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { ASSUMED_CONTEXT } from "@dreamspan/shared/modelSettings.ts"
import { type ConnectionSettings, type ModelId, type ProviderKind, resolveModel } from "@dreamspan/shared/providers.ts"
import { Effect, Layer, Stream } from "effect"
import { budgetOrigins } from "../src/assembler/budget.ts"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import {
  baseModelId,
  familyCatalog,
  idCandidates,
  lookupCatalogs,
  type ModelCatalog,
  piModelCatalog
} from "../src/providers/contextCatalog.ts"
import {
  builtinContextLimitParsers,
  builtinOutputLimitParsers,
  statedContextLimit,
  statedOutputLimit
} from "../src/providers/contextLimits.ts"
import * as Providers from "../src/providers/Providers.ts"
import { ProviderError } from "../src/providers/Providers.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { json, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 1_000 } }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("context-window"), readers: 1, allowNetworkFs: false, ...testWorkers })
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

/** Refreshes a connection of this kind against a list and returns its models, effective. */
const refreshed = (kind: ProviderKind, path: string, base: (url: string) => string, list: unknown) =>
  Effect.gen(function* () {
    const server = yield* mock((request, res) =>
      request.path.startsWith(path) ? json(res, 200, list) : json(res, 404, { error: { message: "no" } })
    )
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const connection = yield* providers.createConnection({
      userId,
      kind,
      settings: settings(base(server.url)),
      apiKey: "sk-test"
    })
    yield* providers.refreshModels(userId, connection.id)
    const models = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
    return {
      userId,
      connection,
      models,
      providers,
      writer,
      effective: (key: string) => {
        const model = models.find((m) => m.key === key)
        assert.isDefined(model, `${key} listed`)
        return resolveModel(model!.key, model!.upstream, model!.overrides)
      }
    }
  })

describe("matching a model id in the catalogs", () => {
  it("compares ids without router prefixes, variant tags, regions, versions or dot spelling", () => {
    assert.strictEqual(baseModelId("anthropic/claude-sonnet-4.5"), "claude-sonnet-4-5")
    assert.strictEqual(baseModelId("~anthropic/claude-opus-latest"), "claude-opus-latest")
    assert.strictEqual(baseModelId("models/gemini-2.5-pro"), "gemini-2-5-pro")
    assert.strictEqual(baseModelId("us.anthropic.claude-sonnet-4-20250514-v1:0"), "claude-sonnet-4-20250514")
    assert.strictEqual(baseModelId("claude-sonnet-4@20250514"), "claude-sonnet-4")
    assert.strictEqual(baseModelId("deepseek/deepseek-r1:free"), "deepseek-r1")
    assert.deepStrictEqual(idCandidates("claude-sonnet-4-20250514").slice(0, 2), [
      "claude-sonnet-4-20250514",
      "claude-sonnet-4"
    ])
    assert.include(idCandidates("gpt-4o-2024-08-06"), "gpt-4o")
    assert.include(idCandidates("claude-opus-4-5-thinking"), "claude-opus-4-5")
  })

  it("finds dated, routed and proxied ids in pi-ai's catalogs", async () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["claude-sonnet-4-5-20250929", 1_000_000],
      ["claude-sonnet-4-5", 1_000_000],
      ["anthropic/claude-sonnet-4.5", 1_000_000],
      ["claude-sonnet-4-20250514", 200_000],
      ["gpt-5", 400_000],
      ["openai/gpt-5-2025-08-07", 400_000],
      ["gpt-5-chat-latest", 128_000],
      ["gpt-4o-2024-08-06", 128_000]
    ]
    for (const [key, context] of cases) {
      const facts = await piModelCatalog.lookup(key, "openai-chat")
      assert.isNotNull(facts, key)
      assert.strictEqual(facts!.context, context, key)
    }
    assert.isNotNull(await piModelCatalog.lookup("models/gemini-2.5-pro", "openai-chat"))
    assert.isNull(await piModelCatalog.lookup("my-local-finetune", "openai-chat"))
  })

  it("falls back to the family table for ids no catalog lists", async () => {
    assert.deepStrictEqual(await familyCatalog.lookup("claude-3-5-sonnet-20241022", "openai-chat"), {
      match: "claude",
      context: 200_000
    })
    assert.strictEqual((await familyCatalog.lookup("gemini-9-ultra-preview-12-2027", "x"))?.context, 1_048_576)
    assert.strictEqual((await familyCatalog.lookup("gpt-5.9-chat", "x"))?.context, 128_000)
    assert.strictEqual((await familyCatalog.lookup("deepseek-chat", "x"))?.context, 128_000)
    assert.isNull(await familyCatalog.lookup("my-local-finetune", "x"))
  })

  it("asks the newest registered catalog first, so a plugin's wins", async () => {
    const plugin: ModelCatalog = {
      id: "plugin:house",
      label: "the house catalog",
      lookup: async (key) => (key === "claude-sonnet-4-5" ? { match: "house-sonnet", context: 64_000 } : null)
    }
    const found = await lookupCatalogs([familyCatalog, piModelCatalog, plugin], "claude-sonnet-4-5", "x")
    assert.strictEqual(found?.catalog.id, "plugin:house")
    assert.strictEqual(found?.facts.context, 64_000)
    // Without an answer from the plugin, pi-ai's catalog comes before the family table.
    const other = await lookupCatalogs([familyCatalog, piModelCatalog, plugin], "claude-sonnet-4-20250514", "x")
    assert.strictEqual(other?.catalog.id, "pi-ai")
  })
})

describe("a model's window, by provider kind", () => {
  it.live("an OpenAI-compatible proxy listing ids only: the catalog by id, else assumed", () =>
    Effect.gen(function* () {
      const { effective } = yield* refreshed("openai-chat", "/v1/models", (url) => `${url}/v1`, {
        data: [
          { id: "claude-sonnet-4-20250514" },
          { id: "anthropic/claude-opus-4.5" },
          { id: "gemini-2.5-pro" },
          { id: "claude-3-5-haiku-20241022" },
          { id: "my-local-finetune" }
        ]
      })
      const sonnet = effective("claude-sonnet-4-20250514")
      assert.strictEqual(sonnet.context.source, "catalog")
      assert.strictEqual(sonnet.context.value, 200_000)
      assert.strictEqual(sonnet.catalog?.catalog, "pi-ai")
      assert.strictEqual(effective("anthropic/claude-opus-4.5").context.source, "catalog")
      assert.strictEqual(effective("gemini-2.5-pro").context.source, "catalog")
      const haiku = effective("claude-3-5-haiku-20241022")
      assert.strictEqual(haiku.context.source, "catalog")
      assert.strictEqual(haiku.catalog?.catalog, "families")
      const local = effective("my-local-finetune")
      assert.strictEqual(local.context.source, "unknown")
      assert.strictEqual(local.context.value, ASSUMED_CONTEXT)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live(
    "OpenRouter's context_length is the provider's figure, while missing maxOutput still fills from the catalog",
    () =>
      Effect.gen(function* () {
        const { effective } = yield* refreshed("openrouter", "/api/v1/models", (url) => `${url}/api/v1`, {
          data: [{ id: "anthropic/claude-sonnet-4.5", context_length: 180_000 }]
        })
        const model = effective("anthropic/claude-sonnet-4.5")
        assert.strictEqual(model.context.source, "upstream")
        assert.strictEqual(model.context.value, 180_000)
        assert.strictEqual(model.maxOutput.source, "catalog")
        assert.strictEqual(model.maxOutput.value, 64_000)
        assert.include(model.catalog?.fields ?? [], "maxOutput")
        assert.notInclude(model.catalog?.fields ?? [], "context")

        // On an OpenAI-compatible proxy that reports context_length without max_output_tokens,
        // fillFromCatalogs still fills maxOutput from pi-ai's catalog without overwriting context.
        const proxy = yield* refreshed("openai-chat", "/v1/models", (url) => `${url}/v1`, {
          data: [{ id: "claude-sonnet-4-20250514", context_length: 180_000 }]
        })
        const proxied = proxy.effective("claude-sonnet-4-20250514")
        assert.strictEqual(proxied.context.source, "upstream")
        assert.strictEqual(proxied.context.value, 180_000)
        assert.strictEqual(proxied.maxOutput.source, "catalog")
        assert.strictEqual(proxied.maxOutput.value, 64_000)
        assert.deepStrictEqual(proxied.catalog?.fields, ["maxOutput"])
      }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("Anthropic's max_input_tokens is the provider's figure", () =>
    Effect.gen(function* () {
      const { effective } = yield* refreshed("anthropic", "/v1/models", (url) => url, {
        data: [{ id: "claude-sonnet-4-5", max_input_tokens: 300_000, max_tokens: 64_000 }],
        has_more: false
      })
      assert.deepStrictEqual(effective("claude-sonnet-4-5").context, { value: 300_000, source: "upstream" })
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("Gemini's inputTokenLimit is the provider's figure", () =>
    Effect.gen(function* () {
      const { effective } = yield* refreshed("google", "/v1beta/models", (url) => `${url}/v1beta`, {
        models: [{ name: "models/gemini-2.5-pro", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }]
      })
      assert.deepStrictEqual(effective("gemini-2.5-pro").context, { value: 1_048_576, source: "upstream" })
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("DeepSeek's list has no window: its catalog or the family table gives it", () =>
    Effect.gen(function* () {
      const { effective } = yield* refreshed("deepseek", "/models", (url) => url, {
        data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-chat" }]
      })
      assert.strictEqual(effective("deepseek-v4-pro").context.source, "catalog")
      assert.deepStrictEqual(effective("deepseek-chat").context, { value: 128_000, source: "catalog" })
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("the user's window beats a learned limit, which beats the list; a model added by id gets the catalog", () =>
    Effect.gen(function* () {
      const { userId, connection, models, writer } = yield* refreshed(
        "openrouter",
        "/api/v1/models",
        (url) => `${url}/api/v1`,
        { data: [{ id: "vendor/storyteller", context_length: 32_000 }] }
      )
      const model = models[0]!
      const learned = yield* writer.SetLearnedContext({
        userId,
        modelId: model.id as ModelId,
        context: 30_000,
        at: 1
      })
      const after = resolveModel(learned.key, learned.upstream, learned.overrides)
      assert.deepStrictEqual(after.context, { value: 30_000, source: "learned" })
      const edited = yield* writer.EditModel({
        userId,
        modelId: model.id as ModelId,
        overrides: { ...learned.overrides, context: 16_000 },
        expectedRowVersion: learned.rowVersion
      })
      assert.deepStrictEqual(resolveModel(edited.key, edited.upstream, edited.overrides).context, {
        value: 16_000,
        source: "user"
      })
      const forgotten = yield* writer.SetLearnedContext({ userId, modelId: model.id as ModelId, context: null, at: 2 })
      assert.isUndefined(forgotten.overrides.learned)
      assert.strictEqual(forgotten.overrides.context, 16_000)

      // Learned output limit: beats upstream/unknown, yields to user's own maxOutput, and clamps a higher reply length.
      yield* writer.EditModel({
        userId,
        modelId: model.id as ModelId,
        overrides: { ...forgotten.overrides, settings: { samplers: { openai_max_tokens: 32_000 } } },
        expectedRowVersion: forgotten.rowVersion
      })
      const learnedOutput = yield* writer.SetLearnedOutput({
        userId,
        modelId: model.id as ModelId,
        maxOutput: 8_192,
        at: 3
      })
      assert.deepStrictEqual(
        resolveModel(learnedOutput.key, learnedOutput.upstream, learnedOutput.overrides).maxOutput,
        {
          value: 8_192,
          source: "learned"
        }
      )
      assert.strictEqual(learnedOutput.overrides.settings?.samplers?.openai_max_tokens, 8_192)
      const withOwnOutput = yield* writer.EditModel({
        userId,
        modelId: model.id as ModelId,
        overrides: { ...learnedOutput.overrides, maxOutput: 12_000 },
        expectedRowVersion: learnedOutput.rowVersion
      })
      assert.deepStrictEqual(
        resolveModel(withOwnOutput.key, withOwnOutput.upstream, withOwnOutput.overrides).maxOutput,
        {
          value: 12_000,
          source: "user"
        }
      )
      const forgottenOutput = yield* writer.SetLearnedOutput({
        userId,
        modelId: model.id as ModelId,
        maxOutput: null,
        at: 4
      })
      assert.isUndefined(forgottenOutput.overrides.learnedOutput)
      assert.strictEqual(forgottenOutput.overrides.maxOutput, 12_000)

      const providers = yield* Providers.Providers
      const upstream = yield* providers.catalogUpstream(userId, connection.id, "claude-opus-4-5-20251101")
      assert.strictEqual(upstream.catalog?.catalog, "pi-ai")
      const added = yield* writer.AddUserModel({
        userId,
        connectionId: connection.id,
        key: "claude-opus-4-5-20251101",
        overrides: {},
        upstream
      })
      assert.strictEqual(resolveModel(added.key, added.upstream, added.overrides).context.source, "catalog")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it.live("a plugin's catalog is consulted on refresh", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderRegistry
      yield* registry.catalogs.register({
        id: "plugin:local",
        label: "the local models table",
        lookup: async (key) => (key === "my-local-finetune" ? { match: "finetune", context: 32_768 } : null)
      })
      const { effective } = yield* refreshed("openai-chat", "/v1/models", (url) => `${url}/v1`, {
        data: [{ id: "my-local-finetune" }]
      })
      const model = effective("my-local-finetune")
      assert.deepStrictEqual(model.context, { value: 32_768, source: "catalog" })
      assert.strictEqual(model.catalog?.label, "the local models table")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("where the budget's numbers come from", () => {
  const input = (patch: Partial<Parameters<typeof budgetOrigins>[0] & object>) =>
    ({
      connectionId: "c",
      modelId: "m",
      kind: "openai-chat",
      api: "openai-completions",
      key: "k",
      prefill: "none",
      cacheBreakpoints: "auto",
      context: null,
      presetOverride: null,
      ...patch
    }) as NonNullable<Parameters<typeof budgetOrigins>[0]>

  it("names the window's source, the model's own settings, or an assumption", () => {
    assert.strictEqual(budgetOrigins(null).context, "assumed")
    assert.strictEqual(budgetOrigins(input({ contextSource: "unknown" })).context, "assumed")
    assert.deepInclude(budgetOrigins(input({ context: 200_000, contextSource: "catalog", contextCatalog: "pi" })), {
      context: "catalog",
      catalog: "pi",
      reserve: "default",
      target: "default"
    })
    assert.strictEqual(budgetOrigins(input({ context: 200_000, contextSource: "learned" })).context, "learned")
    const own = budgetOrigins(
      input({
        context: 200_000,
        contextSource: "upstream",
        settings: { samplers: { openai_max_context: 50_000, openai_max_tokens: 800 }, context_target: 40_000 }
      })
    )
    assert.deepInclude(own, { context: "setting", reserve: "setting", target: "setting" })
    // A setting above the window is capped by it: the window's source is the one in effect.
    const capped = budgetOrigins(
      input({ context: 32_000, contextSource: "upstream", settings: { samplers: { openai_max_context: 50_000 } } })
    )
    assert.strictEqual(capped.context, "upstream")
    assert.deepStrictEqual(own.model, { connectionId: "c", modelId: "m" })
  })
})

describe("the limit a context-length error states", () => {
  const read = (text: string) => statedContextLimit(builtinContextLimitParsers, text)
  it("reads each provider's wording", () => {
    // OpenAI and vLLM
    assert.strictEqual(
      read(
        "400 This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens. Please reduce the length of the messages."
      ),
      128_000
    )
    assert.strictEqual(read("Input tokens exceed the configured limit of 272000 tokens."), 272_000)
    // Anthropic, both wordings
    assert.strictEqual(read("prompt is too long: 208310 tokens > 200000 maximum"), 200_000)
    assert.strictEqual(
      read("input length and `max_tokens` exceed context limit: 197000 + 8192 > 200000, decrease input length"),
      200_000
    )
    // Gemini
    assert.strictEqual(
      read("The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)."),
      1_048_575
    )
    // OpenRouter
    assert.strictEqual(
      read(
        `This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens (139000 of text input, 1000 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.`
      ),
      131_072
    )
    // DeepSeek
    assert.strictEqual(
      read(
        "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens (139000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion."
      ),
      131_072
    )
    assert.strictEqual(read("request (40000 tokens) exceeds the available context size (32768 tokens)"), 32_768)
    assert.strictEqual(read("litellm: exceeds maximum context length of 200,000 tokens"), 200_000)
    assert.isNull(read("Your input exceeds the context window of this model. Please adjust your input."))
    assert.isNull(read("rate limited"))
  })

  it.live("a provider's context-length error carries the limit it states", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, { data: [{ id: "claude-sonnet-4-5" }] })
          : json(res, 400, {
              error: {
                message:
                  "This model's maximum context length is 100000 tokens. However, your messages resulted in 120000 tokens.",
                type: "invalid_request_error"
              }
            })
      )
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        apiKey: "sk-test"
      })
      yield* providers.refreshModels(userId, connection.id)
      const [model] = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
      const error = yield* Stream.runCollect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: model!.id as ModelId,
          context: { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.flip)
      assert.instanceOf(error, ProviderError)
      if (!(error instanceof ProviderError)) return
      assert.strictEqual(error.reason, "context_overflow")
      assert.strictEqual(error.contextLimit, 100_000)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("each provider kind's context-length error, through the request", () => {
  const cases: ReadonlyArray<{
    readonly kind: ProviderKind
    readonly base: (url: string) => string
    readonly list: unknown
    readonly key: string
    readonly body: unknown
    readonly limit: number
  }> = [
    {
      kind: "anthropic",
      base: (url) => url,
      list: { data: [{ id: "claude-sonnet-4-5" }], has_more: false },
      key: "claude-sonnet-4-5",
      body: {
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 208310 tokens > 200000 maximum" }
      },
      limit: 200_000
    },
    {
      kind: "google",
      base: (url) => url,
      list: { models: [{ name: "models/gemini-2.5-pro" }] },
      key: "gemini-2.5-pro",
      body: {
        error: {
          code: 400,
          message: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048576).",
          status: "INVALID_ARGUMENT"
        }
      },
      limit: 1_048_576
    },
    {
      kind: "openrouter",
      base: (url) => `${url}/api/v1`,
      list: { data: [{ id: "vendor/storyteller" }] },
      key: "vendor/storyteller",
      body: {
        error: {
          code: 400,
          message:
            "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens (139000 of text input, 1000 in the output). Please reduce the length of either one."
        }
      },
      limit: 131_072
    },
    {
      kind: "deepseek",
      base: (url) => url,
      list: { data: [{ id: "deepseek-chat" }] },
      key: "deepseek-chat",
      body: {
        error: {
          message:
            "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens (69000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.",
          type: "invalid_request_error"
        }
      },
      limit: 65_536
    }
  ]
  for (const each of cases)
    it.live(`${each.kind}: the error becomes context_overflow carrying the stated limit`, () =>
      Effect.gen(function* () {
        const server = yield* mock((request, res) =>
          request.method === "GET" ? json(res, 200, each.list) : json(res, 400, each.body)
        )
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const providers = yield* Providers.Providers
        const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
        const connection = yield* providers.createConnection({
          userId,
          kind: each.kind,
          settings: settings(each.base(server.url)),
          apiKey: "sk-test"
        })
        yield* providers.refreshModels(userId, connection.id)
        const models = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
        const model = models.find((m) => m.key === each.key)
        assert.isDefined(model, `${each.key} listed`)
        const error = yield* Stream.runCollect(
          providers.stream({
            userId,
            connectionId: connection.id,
            modelId: model!.id as ModelId,
            context: { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
            attribution: { purpose: "generation" }
          })
        ).pipe(Effect.flip)
        assert.instanceOf(error, ProviderError)
        if (!(error instanceof ProviderError)) return
        assert.strictEqual(error.reason, "context_overflow")
        assert.strictEqual(error.contextLimit, each.limit)
      }).pipe(Effect.scoped, Effect.provide(layer()))
    )
})

describe("output-limit errors", () => {
  it("parses stated output limits from provider errors without misreading context-length errors", () => {
    const outputCases: ReadonlyArray<readonly [string, number]> = [
      ["max_tokens: 65536 > 16384, which is the maximum allowed number of output tokens for claude-3-5-sonnet", 16_384],
      [
        "max_tokens is too large: 65536. This model supports at most 4096 completion tokens, whereas you provided 65536.",
        4_096
      ],
      [
        "Invalid 'max_output_tokens': integer above maximum value. Expected a value <= 16384, but got 65536 instead.",
        16_384
      ],
      ["Invalid value at 'generation_config.max_output_tokens' (TYPE_INT32), 65536 exceeds the maximum (8192)", 8_192],
      ["Invalid max_tokens value, the valid range of max_tokens is [1, 8192]", 8_192],
      ["max_tokens must be between 1 and 16384", 16_384],
      ["Request exceeds the model's maximum output tokens of 32,768", 32_768]
    ]
    for (const [text, expected] of outputCases) {
      assert.isNull(statedContextLimit(builtinContextLimitParsers, text), `not context: ${text}`)
      assert.strictEqual(statedOutputLimit(builtinOutputLimitParsers, text), expected, text)
    }
    const contextOnly = [
      "input length and `max_tokens` exceed context limit: 197000 + 8192 > 200000",
      "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (120000 in the messages, 10000 in the completion).",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048576)."
    ]
    for (const text of contextOnly) {
      assert.isNotNull(statedContextLimit(builtinContextLimitParsers, text), `context: ${text}`)
      assert.isNull(statedOutputLimit(builtinOutputLimitParsers, text), `not output: ${text}`)
    }
  })

  const streamCases: ReadonlyArray<{
    readonly kind: ProviderKind
    readonly base: (url: string) => string
    readonly list: unknown
    readonly key: string
    readonly body: unknown
    readonly limit: number
  }> = [
    {
      kind: "anthropic",
      base: (url) => url,
      list: { data: [{ id: "claude-sonnet-4-5" }], has_more: false },
      key: "claude-sonnet-4-5",
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "max_tokens: 65536 > 16384, which is the maximum allowed number of output tokens for claude-sonnet-4-5"
        }
      },
      limit: 16_384
    },
    {
      kind: "openai-chat",
      base: (url) => `${url}/v1`,
      list: { data: [{ id: "custom-model" }] },
      key: "custom-model",
      body: {
        error: {
          message: "max_tokens is too large: 65536. This model supports at most 8192 completion tokens.",
          type: "invalid_request_error"
        }
      },
      limit: 8_192
    },
    {
      kind: "google",
      base: (url) => url,
      list: { models: [{ name: "models/gemini-2.5-pro" }] },
      key: "gemini-2.5-pro",
      body: {
        error: {
          code: 400,
          message:
            "Invalid value at 'generation_config.max_output_tokens' (TYPE_INT32), 65536 exceeds the maximum (8192)",
          status: "INVALID_ARGUMENT"
        }
      },
      limit: 8_192
    },
    {
      kind: "deepseek",
      base: (url) => url,
      list: { data: [{ id: "deepseek-chat" }] },
      key: "deepseek-chat",
      body: {
        error: {
          message: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]",
          type: "invalid_request_error"
        }
      },
      limit: 8_192
    }
  ]

  for (const each of streamCases)
    it.live(`${each.kind}: a max-tokens error carries the stated outputLimit`, () =>
      Effect.gen(function* () {
        const server = yield* mock((request, res) =>
          request.method === "GET" ? json(res, 200, each.list) : json(res, 400, each.body)
        )
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const providers = yield* Providers.Providers
        const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
        const connection = yield* providers.createConnection({
          userId,
          kind: each.kind,
          settings: settings(each.base(server.url)),
          apiKey: "sk-test"
        })
        yield* providers.refreshModels(userId, connection.id)
        const models = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
        const model = models.find((m) => m.key === each.key)
        assert.isDefined(model, `${each.key} listed`)
        const error = yield* Stream.runCollect(
          providers.stream({
            userId,
            connectionId: connection.id,
            modelId: model!.id as ModelId,
            context: { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
            attribution: { purpose: "generation" }
          })
        ).pipe(Effect.flip)
        assert.instanceOf(error, ProviderError)
        if (!(error instanceof ProviderError)) return
        assert.strictEqual(error.reason, "bad_request")
        assert.isUndefined(error.contextLimit)
        assert.strictEqual(error.outputLimit, each.limit)
      }).pipe(Effect.scoped, Effect.provide(layer()))
    )
})
