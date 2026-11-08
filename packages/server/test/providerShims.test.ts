// Compatibility shims per provider, API type and model (liveapi F7, F9, F10, F11, F13), a reply with
// nothing after its prefill (F12), and catalog facts for models added by id or listed behind a
// router's id prefix (F1, F2).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { pinnedRoute, resolveModel, routedUpstream } from "@rp/shared/providers.ts"
import { prefillUnavailable } from "../src/assembler/prefill.ts"
import { applyShims, builtinShims, providerRules, shimmedUpstream } from "../src/providers/shims.ts"
import { detectModelIdPrefix, withoutModelIdPrefix } from "../src/providers/contextCatalog.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { anthropicSse, completionChunks, json, sse, startMockProvider, type Handler } from "./support/mockProvider.ts"

const resource = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

const shim = (provider: string, api: string, model: string, payload: Record<string, unknown>) =>
  applyShims(builtinShims, structuredClone(payload), { kind: provider, provider, api: api as never, model })

describe("payload shims", () => {
  it("Claude Haiku 5 drops top_p; Haiku 4.5 keeps it (F7)", () => {
    const sent = { model: "claude-haiku-5-5", top_p: 0.9, temperature: 0.7 }
    const five = shim("anthropic", "anthropic-messages", "claude-haiku-5-5", sent)
    assert.deepEqual(five.payload, { model: "claude-haiku-5-5", temperature: 0.7 })
    assert.deepEqual(five.applied, ["claude-haiku-5-no-top-p"])
    assert.strictEqual(shim("anthropic", "anthropic-messages", "claude-haiku-4-5", sent).payload.top_p, 0.9)
    assert.notProperty(shim("openrouter", "openai-completions", "anthropic/claude-haiku-5.5", sent).payload, "top_p")
    // Keyed by provider, not API type: Bedrock speaks the Messages API and gets it too.
    assert.notProperty(
      shim("anthropic-bedrock", "anthropic-messages", "us.anthropic.claude-haiku-5-5-v1:0", sent).payload,
      "top_p"
    )
  })

  it("an OpenAI rule applies to OpenAI and custom servers, not to OpenRouter's OpenAI models", () => {
    const sent = { top_p: 0.9, temperature: 0.7, reasoning: { effort: "low" } }
    assert.notProperty(shim("openai-compatible", "openai-responses", "gpt-5.4-nano", sent).payload, "top_p")
    assert.strictEqual(shim("openrouter", "openai-completions", "openai/gpt-5.4-nano", sent).payload.top_p, 0.9)
  })

  it("Responses GPT-5.1 to 5.4 with an effort drop the samplers and ask for the summary (F9)", () => {
    const sent = { top_p: 0.9, temperature: 0.7, reasoning: { effort: "low" } }
    const shimmed = shim("openai", "openai-responses", "gpt-5.4-nano", sent).payload
    assert.deepEqual(shimmed, { reasoning: { effort: "low", summary: "auto" } })
    // Behind a router prefix too; without an effort, or on 5.5, nothing changes.
    assert.notProperty(shim("openai", "openai-responses", "acme.gpt-5.1", sent).payload, "top_p")
    const none = { ...sent, reasoning: { effort: "none" } }
    assert.deepEqual(shim("openai", "openai-responses", "gpt-5.4-nano", none).payload, none)
    assert.deepEqual(shim("openai", "openai-responses", "gpt-5.5", sent).payload, sent)
  })

  it("Chat Completions GPT-5.4 with tools sends effort none (F10)", () => {
    const tools = [{ type: "function", function: { name: "look", parameters: {} } }]
    const sent = { tools, reasoning_effort: "low" }
    assert.strictEqual(shim("openai", "openai-completions", "gpt-5.4-nano", sent).payload.reasoning_effort, "none")
    assert.strictEqual(
      shim("openai", "openai-completions", "gpt-5.4-nano", { reasoning_effort: "low" }).payload.reasoning_effort,
      "low"
    )
    assert.strictEqual(shim("openai", "openai-responses", "gpt-5.4-nano", sent).payload.reasoning_effort, "low")
  })

  it("a shim is replaced or disabled by id: only the registered list applies", () => {
    const sent = { top_p: 0.9 }
    const without = builtinShims.filter((s) => s.id !== "claude-haiku-5-no-top-p")
    const out = applyShims(
      without,
      { ...sent },
      { kind: "anthropic", api: "anthropic-messages", model: "claude-haiku-5" }
    )
    assert.deepEqual(out.payload, sent)
  })

  it("Argon's mandatory reasoning survives explicit payload settings and thinking-level overrides", () => {
    const sent = { reasoning: { effort: "none", exclude: true }, reasoning_effort: "none" }
    const out = shim("openrouter", "openai-completions", "google/gemini-4-argon", sent)
    assert.deepEqual(out.payload, { reasoning: { exclude: true } })
    assert.deepEqual(shim("openrouter", "openai-completions", "google/gemini-3.5-pro", sent).payload, sent)
    assert.deepEqual(
      shim("openrouter", "openai-completions", "google/gemini-4-argon", { reasoning: { effort: "low" } }).payload,
      { reasoning: { effort: "low" } }
    )
  })
})

describe("capability shims", () => {
  it.live("Argon stays usable when model settings override the off thinking level", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((req, res) => {
        const reasoning = req.body?.reasoning as Record<string, unknown> | undefined
        if (reasoning?.effort === "none" || req.body?.reasoning_effort === "none")
          return json(res, 400, {
            error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled." }
          })
        sse(res, completionChunks(["The tide is out."], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }))
      })
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openrouter", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "google/gemini-4-argon",
        model: {
          reasoning: true,
          thinkingLevels: { off: "none" },
          settings: { samplers: { reasoning_effort: "none" } }
        }
      })
      assert.strictEqual(version.status, "complete")
      assert.strictEqual(mock.requests().length, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it("Gemini 4 Argon on OpenRouter has no 'off' level, so no effort none is sent (F11)", () => {
    const upstream = shimmedUpstream(builtinShims, "openrouter", "google/gemini-4-argon", {
      thinkingLevels: { low: "low" }
    })
    assert.deepEqual(upstream.thinkingLevels, { low: "low", off: null })
    assert.deepInclude(
      upstream.shims!.map((s) => s.id),
      "openrouter-gemini-4-argon-reasoning-on"
    )
  })

  it("Gemini on OpenRouter takes no prefill, whatever the user set (F13)", () => {
    const upstream = shimmedUpstream(builtinShims, "openrouter", "google/gemini-3.5-flash-lite", {})
    assert.strictEqual(upstream.prefill, "none")
    assert.deepEqual(upstream.fixed, ["prefill"])
    const effective = resolveModel("google/gemini-3.5-flash-lite", upstream, { prefill: "assistant" })
    assert.strictEqual(effective.prefill.value, "none")
    // Another kind, or another model there, keeps the user's choice.
    assert.isUndefined(shimmedUpstream(builtinShims, "google", "gemini-3.5-flash-lite", {}).fixed)
    assert.isUndefined(shimmedUpstream(builtinShims, "openrouter", "anthropic/claude-haiku-4.5", {}).shims)
  })

  it("a shim no longer registered leaves no name or fixed field behind", () => {
    const before = shimmedUpstream(builtinShims, "openrouter", "google/gemini-3.5-flash-lite", {})
    const after = shimmedUpstream([], "openrouter", "google/gemini-3.5-flash-lite", before)
    assert.isUndefined(after.shims)
    assert.isUndefined(after.fixed)
  })
})

describe("router model id prefixes (F2)", () => {
  it("detects the prefix most listed ids share", () => {
    assert.strictEqual(detectModelIdPrefix(["acme.gpt-5.4-nano", "acme.gpt-5.5", "text-embedding-3"]), "acme.")
    assert.isNull(detectModelIdPrefix(["gpt-5.4-nano", "gpt-4.1", "o3"]))
    assert.isNull(detectModelIdPrefix(["anthropic/claude-haiku-4.5", "google/gemini-3.5-pro"]))
    assert.isNull(detectModelIdPrefix(["acme.deepseek-flash", "a", "b", "c"]))
    assert.strictEqual(withoutModelIdPrefix("acme.gpt-5.4-nano", "acme."), "gpt-5.4-nano")
    assert.strictEqual(withoutModelIdPrefix("gpt-5.4-nano", "acme."), "gpt-5.4-nano")
  })

  it.live("a refresh reads the list's own fields, matches the catalog without the prefix, and keeps it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((req, res) =>
        req.path.endsWith("/models")
          ? json(res, 200, {
              data: [
                { id: "acme.gpt-5.4-nano", architecture: { output_modalities: ["text"] } },
                {
                  id: "acme.synthetic-model",
                  context_window: 64000,
                  max_output_tokens: 8000,
                  input_modalities: ["text", "image"],
                  effort: { supported_levels: ["low", "high"] }
                }
              ]
            })
          : json(res, 404, {})
      )
      const api = yield* client()
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Gateway",
          baseUrl: `${mock.url}/v1`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-synthetic"
      })
      assert.isNull(connection.modelIdPrefix)
      yield* api.RefreshModels({ connectionId: connection.id })
      const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: true })
      const nano = models.find((m) => m.key === "acme.gpt-5.4-nano")!.upstream
      assert.isDefined(nano.price)
      assert.isTrue(nano.reasoning)
      assert.isTrue(nano.vision)
      assert.strictEqual(nano.catalog?.match, "gpt-5.4-nano")
      const listed = models.find((m) => m.key === "acme.synthetic-model")!.upstream
      assert.deepInclude(listed, { context: 64000, maxOutput: 8000, vision: true, reasoning: true })
      const [saved] = (yield* api.ListConnections()).filter((c) => c.id === connection.id)
      assert.strictEqual(saved!.modelIdPrefix, "acme.")
      // The user's choice stands: cleared, a refresh doesn't set it again.
      yield* api.UpdateConnection({
        connectionId: connection.id,
        expectedRowVersion: saved!.rowVersion,
        settings: {
          name: "Gateway",
          baseUrl: `${mock.url}/v1`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null,
          modelIdPrefix: ""
        }
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const [cleared] = (yield* api.ListConnections()).filter((c) => c.id === connection.id)
      assert.strictEqual(cleared!.modelIdPrefix, "")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("models added by id (F1)", () => {
  it.live("take price, reasoning and vision from the kind's catalog entry", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const connection = yield* api.CreateConnection({
        kind: "anthropic",
        settings: {
          name: "Anthropic",
          baseUrl: "http://127.0.0.1:1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "claude-haiku-4-5", overrides: {} })
      assert.deepInclude(model.upstream.price ?? {}, { input: 1, output: 5 })
      assert.isTrue(model.upstream.reasoning)
      assert.isTrue(model.upstream.vision)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("a reply with no text after its prefill (F12)", () => {
  it.live("fails, so the error shows and the reply can be retried", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) =>
        anthropicSse(res, [
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "mock-model",
              content: [],
              usage: { input_tokens: 10, output_tokens: 1 }
            }
          },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" }
        ])
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
        model: { prefill: "assistant" },
        preset: { assistant_prefill: "*{{char}} sighs.*" }
      })
      assert.strictEqual(version.status, "failed")
      assert.include(version.error?.message ?? "", "no text after the reply's prefill")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("route rules: shims for one OpenRouter upstream (liveapi2)", () => {
  const deepseek = "deepseek/deepseek-v4.1-flash"
  const mimo = "xiaomi/mimo-v2.6-pro"
  const listed = (key: string) => shimmedUpstream(builtinShims, "openrouter", key, { prefill: "assistant" })
  const routed = (key: string, routing?: Record<string, unknown>) =>
    resolveModel(key, listed(key), routing ? { settings: { routing } } : {})

  it("pins a route with one `only` entry, or one `order` entry with fallbacks off", () => {
    assert.strictEqual(pinnedRoute({ only: ["together"] }), "together")
    assert.strictEqual(pinnedRoute({ only: ["Together"], allow_fallbacks: false }), "together")
    assert.strictEqual(pinnedRoute({ only: ["deepinfra/fp8"] }), "deepinfra")
    assert.strictEqual(pinnedRoute({ order: ["together"], allow_fallbacks: false }), "together")
    assert.strictEqual(
      pinnedRoute({ only: ["together", "fireworks"], order: ["together"], allow_fallbacks: false }),
      "together"
    )
    assert.strictEqual(pinnedRoute({ only: ["together", "fireworks"], ignore: ["fireworks"] }), "together")
    // The router may still choose: fallbacks on, several entries, or no routing.
    assert.isNull(pinnedRoute({ order: ["together"] }))
    assert.isNull(pinnedRoute({ only: ["together", "fireworks"] }))
    assert.isNull(pinnedRoute({ order: ["together", "fireworks"], allow_fallbacks: false }))
    assert.isNull(pinnedRoute(undefined))
  })

  it("stores the route rules with the model, not as its own shims", () => {
    const upstream = listed(deepseek)
    assert.deepEqual(
      upstream.routes?.map((r) => r.id),
      ["openrouter-deepseek-together-no-prefill"]
    )
    assert.isUndefined(upstream.shims)
    assert.isUndefined(upstream.fixed)
    assert.strictEqual(upstream.prefill, "assistant")
    // Another model, or a direct DeepSeek connection, gets none.
    assert.isUndefined(listed("anthropic/claude-haiku-4.5").routes)
    assert.isUndefined(shimmedUpstream(builtinShims, "deepseek", "deepseek-flash", {}).routes)
    // A rule no longer registered leaves nothing behind.
    assert.isUndefined(shimmedUpstream([], "openrouter", deepseek, upstream).routes)
  })

  it("pinned to Together, DeepSeek's prefill is locked off and Continue uses the nudge", () => {
    const pinned = resolveModel(deepseek, listed(deepseek), {
      prefill: "assistant",
      settings: { routing: { only: ["together"], allow_fallbacks: false } }
    })
    assert.deepEqual(pinned.prefill, { value: "none", source: "upstream" })
    assert.strictEqual(pinned.route.route, "together")
    const message = prefillUnavailable(
      { kind: "openrouter", api: "openai-completions", key: deepseek, prefill: pinned.prefill.value },
      null,
      { route: pinned.route }
    )
    assert.match(message ?? "", /^Prefill fails on Together for deepseek\/deepseek-v4\.1-flash, so its prefill is off/)
    const page = routedUpstream(listed(deepseek), { only: ["together"] })
    assert.deepEqual(page.upstream.fixed, ["prefill"])
    assert.deepEqual(
      page.upstream.shims?.map((s) => s.id),
      ["openrouter-deepseek-together-no-prefill"]
    )
    // Elsewhere the user's choice stands.
    const deepinfra = resolveModel(deepseek, listed(deepseek), {
      prefill: "assistant",
      settings: { routing: { only: ["deepinfra"] } }
    })
    assert.strictEqual(deepinfra.prefill.value, "assistant")
    assert.deepEqual(deepinfra.route.applied, [])
  })

  it("unpinned, no route rule applies, and the notes name the upstreams that break it", () => {
    const open = routed(deepseek)
    assert.strictEqual(open.prefill.value, "assistant")
    assert.deepEqual(open.route.unpinned, ["Prefill fails on Together; pin a provider to be sure."])
    assert.deepEqual(routed(mimo).route.unpinned, [
      "Prefill fails on StreamLake; pin a provider to be sure.",
      "Prefill is unreliable on Xiaomi; pin a provider to be sure."
    ])
    // Only the upstreams the routing still allows are named.
    assert.deepEqual(routed(mimo, { only: ["deepinfra", "streamlake"] }).route.unpinned, [
      "Prefill fails on StreamLake; pin a provider to be sure."
    ])
    assert.deepEqual(routed(mimo, { ignore: ["streamlake", "xiaomi"] }).route.unpinned, [])
    assert.strictEqual(routed(mimo, { only: ["xiaomi"] }).prefill.value, "none")
    assert.strictEqual(routed(mimo, { only: ["streamlake"] }).prefill.value, "none")
    assert.strictEqual(routed(mimo, { only: ["deepinfra"] }).prefill.value, "assistant")
  })

  it("lists route rules in the provider's advanced section by upstream", () => {
    assert.include(
      providerRules(builtinShims, "openrouter"),
      "DeepSeek through Together: No prefill through Together: the reply comes back empty. Continue asks the model to go on instead."
    )
  })

  it("a route rule's payload rewrite applies only when the request pins its upstream", () => {
    const rule = {
      id: "test-route-payload",
      label: "Test",
      models: "Test",
      providers: ["openrouter"],
      model: /^vendor\//,
      upstreams: [{ slug: "together", name: "Together" }],
      fails: "Test fails",
      payload: (payload: Record<string, unknown>) => ({ ...payload, marked: true })
    }
    const target = { kind: "openrouter", provider: "openrouter", api: "openai-completions" as never, model: "vendor/m" }
    assert.deepEqual(applyShims([rule], { provider: { only: ["together"] } }, target).applied, ["test-route-payload"])
    assert.deepEqual(applyShims([rule], { provider: { only: ["fireworks"] } }, target).applied, [])
    assert.deepEqual(applyShims([rule], {}, target).applied, [])
  })

  it.live("a pinned Together route drops the preset's prefill; another upstream keeps it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) =>
        sse(res, completionChunks(["The tide is out."], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }))
      )
      const api = yield* client()
      const send = (only: string) =>
        generateReply(api, {
          connection: { kind: "openrouter", baseUrl: mock.url, apiKey: "synthetic-key" },
          modelKey: deepseek,
          model: { prefill: "assistant", settings: { routing: { only: [only], allow_fallbacks: false } } },
          preset: { assistant_prefill: "*Mira sets down her pen.*" }
        })
      const chats = mock.requests
      const lastOf = (i: number) =>
        (
          chats().filter((r) => r.path.endsWith("/chat/completions"))[i]!.body!.messages as Array<{
            role: string
            content: unknown
          }>
        ).at(-1)
      const together = yield* send("together")
      assert.strictEqual(together.version.status, "complete")
      assert.notStrictEqual(lastOf(0)?.role, "assistant")
      const fireworks = yield* send("fireworks")
      assert.strictEqual(fireworks.version.status, "complete")
      assert.strictEqual(lastOf(1)?.role, "assistant")
      assert.include(JSON.stringify(lastOf(1)?.content), "Mira sets down her pen.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
