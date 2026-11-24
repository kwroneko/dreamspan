import { ProviderRegistry } from "../src/providers/registry.ts"
// The thinking request per Claude model family (providers/claudeThinking.ts), as the wire bytes
// show it: a model pi-ai's catalog doesn't list, marked as reasoning, gets adaptive thinking and
// `output_config.effort` where Anthropic refuses budgets, and budgets where those are all a model
// takes. Scripted provider only; nothing reaches Anthropic.
import { assert, describe, it } from "@effect/vitest"
import type { Context as PiContext, ThinkingLevel } from "@earendil-works/pi-ai"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ConnectionSettings, ModelOverrides } from "@dreamspan/shared/providers.ts"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { claudeBoundThinking, claudeThinkingDefaults, claudeThinkingForm } from "../src/providers/claudeThinking.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { anthropicSse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 100 } }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("claude-thinking"), readers: 1, allowNetworkFs: false, ...testWorkers })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
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

const reply = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 5, output_tokens: 1 }
    }
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Calm." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" }
]

type Body = { thinking?: Record<string, unknown>; output_config?: Record<string, unknown>; max_tokens?: number }

/** The body the app sends for `key`, marked as reasoning (or as `overrides` say), at `reasoning`. */
const bodyFor = (
  key: string,
  reasoning: ThinkingLevel | undefined,
  overrides: ModelOverrides = { reasoning: true },
  maxTokens?: number
) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider((_request, res) => anthropicSse(res, reply))),
      (s) => Effect.promise(() => s.close())
    )
    const writer = yield* Database.Writer
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const connection = yield* providers.createConnection({
      userId,
      kind: "anthropic",
      settings: settings(server.url),
      apiKey: "sk-ant-made-up-for-tests-0000"
    })
    const model = yield* writer.AddUserModel({ userId, connectionId: connection.id, key, overrides })
    const events = yield* Stream.runCollect(
      providers.stream({
        userId,
        connectionId: connection.id,
        modelId: model.id,
        context,
        options: { ...(reasoning ? { reasoning } : {}), ...(maxTokens === undefined ? {} : { maxTokens }) },
        attribution: { purpose: "generation" }
      })
    )
    assert.strictEqual(events.at(-1)?.type, "done")
    return server.requests().find((r) => r.path.startsWith("/v1/messages"))!.body as unknown as Body
  }).pipe(Effect.scoped)

describe("the thinking request per Claude family", () => {
  it("requires a matching prefix unless a Claude family is known to allow arbitrary history", () => {
    assert.isTrue(claudeBoundThinking("application-inference-profile"))
    assert.isTrue(claudeBoundThinking("application-inference-profile", "us.anthropic.claude-opus-5-5-v1:0"))
    assert.isFalse(claudeBoundThinking("application-inference-profile", "claude-sonnet-4-6"))
    assert.isTrue(claudeBoundThinking("claude-opus-5-6", "claude-opus-5"))
    assert.isFalse(claudeBoundThinking("claude-3-5-sonnet-20241022"))
    assert.isTrue(claudeBoundThinking("claude-future-6"))
  })

  it("reads the family and version from direct, Bedrock and Vertex ids", () => {
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof claudeThinkingForm>]> = [
      ["claude-fable-5-2", "adaptive-only"],
      ["claude-mythos-5-1", "adaptive-only"],
      ["claude-opus-5-5", "adaptive-only"],
      ["claude-opus-4-8", "adaptive-only"],
      ["claude-opus-4-7", "adaptive-only"],
      ["claude-opus-4-6", "adaptive"],
      ["claude-opus-4-5-20251101", null],
      ["claude-opus-4-20250514", null],
      ["claude-sonnet-5-5", "adaptive-only"],
      ["claude-sonnet-5", "adaptive-only"],
      ["claude-sonnet-4-6", "adaptive"],
      ["claude-sonnet-4-5-20250929", null],
      ["claude-haiku-5-5", "adaptive-only"],
      ["claude-haiku-4-5-20251001", null],
      ["claude-3-5-sonnet-20241022", null],
      ["us.anthropic.claude-opus-5-5-v1:0", "adaptive-only"],
      ["anthropic.claude-haiku-4-5-20251001-v1:0", null],
      ["claude-fable-5-2@20261001", "adaptive-only"],
      ["gpt-5.4", null],
      ["claude-future-6", "adaptive-only"],
      ["claude-sonnet-4-7", "adaptive-only"],
      ["claude-opus-4-20250514", null],
      ["claude-mythos-preview", "adaptive"]
    ]
    for (const [key, form] of cases) assert.strictEqual(claudeThinkingForm(key), form, key)
    assert.isNull(claudeThinkingDefaults("openai-completions", "anthropic/claude-fable-5.2"))
    // Sampling parameters are refused on the adaptive-only models: pi-ai then leaves temperature out.
    assert.strictEqual(
      claudeThinkingDefaults("anthropic-messages", "claude-fable-5-2")?.compat.supportsTemperature,
      false
    )
    assert.isUndefined(claudeThinkingDefaults("anthropic-messages", "claude-opus-4-6")?.compat.supportsTemperature)
  })

  for (const [key, level, effort] of [
    ["claude-fable-5-2", "medium", "medium"],
    ["claude-haiku-5-5", "xhigh", "xhigh"],
    ["claude-sonnet-5-5", "minimal", "low"],
    ["us.anthropic.claude-opus-5-5-v1:0", "max", "max"]
  ] as const)
    it.live(`${key} at ${level}: adaptive thinking, effort ${effort}, no budget`, () =>
      Effect.gen(function* () {
        const body = yield* bodyFor(key, level)
        assert.deepStrictEqual(body.thinking, { type: "adaptive", display: "summarized" })
        assert.deepStrictEqual(body.output_config, { effort })
      }).pipe(Effect.provide(layer()))
    )

  it.live("an adaptive-only model with no effort chosen gets no thinking field, never a refused `disabled`", () =>
    Effect.gen(function* () {
      const body = yield* bodyFor("claude-fable-5-2", undefined)
      assert.isUndefined(body.thinking)
      assert.isUndefined(body.output_config)
    }).pipe(Effect.provide(layer()))
  )

  it.live("Opus 4.6 takes adaptive thinking, and xhigh becomes high", () =>
    Effect.gen(function* () {
      const body = yield* bodyFor("claude-opus-4-6-custom", "xhigh")
      assert.deepStrictEqual(body.thinking, { type: "adaptive", display: "summarized" })
      assert.deepStrictEqual(body.output_config, { effort: "high" })
    }).pipe(Effect.provide(layer()))
  )

  it.live("an older model keeps its budget form", () =>
    Effect.gen(function* () {
      const body = yield* bodyFor("claude-haiku-4-5-20251001", "medium")
      assert.strictEqual(body.thinking?.type, "enabled")
      assert.isNumber(body.thinking?.budget_tokens)
      assert.isUndefined(body.output_config)
    }).pipe(Effect.provide(layer()))
  )

  it.live("the model's own effort mapping wins over the family's", () =>
    Effect.gen(function* () {
      const body = yield* bodyFor("claude-fable-5-2", "low", { reasoning: true, thinkingLevels: { low: "medium" } })
      assert.deepStrictEqual(body.output_config, { effort: "medium" })
    }).pipe(Effect.provide(layer()))
  )
})

for (const key of ["claude-opus-4-7-custom", "claude-opus-4-8-custom", "claude-sonnet-5-custom"]) {
  it.live(`review: ${key} keeps thinking off when no effort is chosen`, () =>
    Effect.gen(function* () {
      const body = yield* bodyFor(key, undefined)
      assert.deepStrictEqual(body.thinking, { type: "disabled" })
      assert.isUndefined(body.output_config)
    }).pipe(Effect.provide(layer()))
  )
}
for (const key of [
  "claude-future-6",
  "claude-mythos-preview",
  "claude-sonnet-4-6-custom",
  "claude-fable-5-2@20261001"
]) {
  it.live(`review: ${key} uses adaptive thinking within the output cap`, () =>
    Effect.gen(function* () {
      const body = yield* bodyFor(key, "max", { reasoning: true }, 128)
      assert.deepStrictEqual(body.thinking, { type: "adaptive", display: "summarized" })
      assert.deepStrictEqual(body.output_config, { effort: "max" })
      assert.strictEqual(body.max_tokens, 128)
    }).pipe(Effect.provide(layer()))
  )
}

it.live("review: a plugin can replace the family's model defaults", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry
    const binding = registry.thinkingBindings.get("anthropic-messages")!
    yield* registry.thinkingBindings.register({ ...binding, modelDefaults: () => null })
    const body = yield* bodyFor("claude-future-6", "low")
    assert.strictEqual(body.thinking?.type, "enabled")
  }).pipe(Effect.provide(layer()))
)
