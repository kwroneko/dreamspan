// Reasoning nobody reports is assumed on (owner, 2026-11-23): a chosen effort is sent, and no
// effort sends nothing, so the model's own default stands. The assumption keeps the system role.
import type { Context as PiContext } from "@earendil-works/pi-ai"
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { resolveModel, type ModelId, type ProviderKind } from "@dreamspan/shared/providers.ts"
import { samplersSent, takesVerbosity } from "@dreamspan/shared/samplerRules.ts"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 100 } }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("reasoning-default"), readers: 1, allowNetworkFs: false, ...testWorkers })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
  )

const context: PiContext = {
  systemPrompt: "You are the narrator.",
  messages: [{ role: "user", content: "The harbor at dusk.", timestamp: 1 }]
}

describe("the reasoning default", () => {
  it("is yes when no source reports it, and the user's or the provider's no wins", () => {
    const unknown = resolveModel("synthetic-model", {}, {})
    assert.isTrue(unknown.reasoning.value)
    assert.strictEqual(unknown.reasoning.source, "unknown")
    // Assumed: no effort sends no "off" value, and system messages keep their role.
    assert.strictEqual(unknown.thinkingLevels.value?.off, null)
    assert.strictEqual(unknown.compat.supportsDeveloperRole, false)
    const off = resolveModel("synthetic-model", {}, { reasoning: false })
    assert.isFalse(off.reasoning.value)
    assert.isUndefined(off.compat.supportsDeveloperRole)
    const listed = resolveModel("synthetic-model", { reasoning: false }, {})
    assert.isFalse(listed.reasoning.value)
    const reported = resolveModel("synthetic-model", { reasoning: true }, {})
    assert.isNull(reported.thinkingLevels.value)
    assert.isUndefined(reported.compat.supportsDeveloperRole)
  })

  for (const [kind, path, model, thinkingFormat] of [
    ["openai-chat", "/v1", "synthetic-model", undefined],
    ["openrouter", "/api/v1", "vendor/synthetic-model", undefined],
    ["openai-chat", "/v1", "synthetic-model", "qwen"]
  ] as const)
    it.live(`${thinkingFormat ?? kind}: sends a chosen effort and leaves Auto to the endpoint`, () =>
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              if (request.path.endsWith("/models")) return json(res, 200, { data: [{ id: model }] })
              return sse(res, completionChunks(["Waves."], {}))
            })
          ),
          (server) => Effect.promise(() => server.close())
        )
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const providers = yield* Providers.Providers
        const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
        const connection = yield* providers.createConnection({
          userId,
          kind: kind as ProviderKind,
          settings: {
            name: "Test",
            baseUrl: server.url + path,
            compat: thinkingFormat ? { thinkingFormat } : {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: kind === "openrouter" ? "sk-synthetic-key" : null
        })
        yield* providers.refreshModels(userId, connection.id)
        const listed = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
        const modelId = listed.find((m) => m.key === model)!.id as ModelId
        const send = (reasoning?: "high") =>
          Stream.runCollect(
            providers.stream({
              userId,
              connectionId: connection.id,
              modelId,
              context,
              options: reasoning ? { reasoning } : {},
              attribution: { purpose: "test" }
            })
          )
        yield* send("high")
        yield* send()
        const calls = server.requests().filter((r) => r.path.endsWith("/chat/completions"))
        assert.lengthOf(calls, 2)
        const [chosen, none] = [calls[0]!.body!, calls[1]!.body!]
        if (thinkingFormat === "qwen") {
          assert.propertyVal(chosen, "enable_thinking", true)
          assert.notProperty(none, "enable_thinking")
          assert.notProperty(none, "reasoning_effort")
        } else if (kind === "openrouter") {
          assert.deepStrictEqual(chosen.reasoning, { effort: "high" })
          assert.notProperty(none, "reasoning")
        } else {
          assert.strictEqual(chosen.reasoning_effort, "high")
          assert.notProperty(none, "reasoning_effort")
        }
        // The system prompt keeps the system role: a server that never said it reasons may not take "developer".
        for (const body of [chosen, none])
          assert.strictEqual((body.messages as ReadonlyArray<{ role: string }>)[0]!.role, "system")
      }).pipe(Effect.scoped, Effect.provide(layer()))
    )
})

describe("the samplers a model's page shows", () => {
  it("are the ones the request sends", () => {
    assert.deepStrictEqual(samplersSent({ kind: "openai-chat", api: "openai-completions", key: "local-model" }), [
      "temperature",
      "top_p",
      "frequency_penalty",
      "presence_penalty",
      "seed"
    ])
    assert.includeMembers(
      [...samplersSent({ kind: "openrouter", api: "openai-completions", key: "vendor/model" })],
      ["top_k", "min_p", "top_a", "repetition_penalty"]
    )
    assert.deepStrictEqual(samplersSent({ kind: "openai-chat", api: "openai-completions", key: "gpt-5" }), ["seed"])
    assert.deepStrictEqual(samplersSent({ kind: "anthropic", api: "anthropic-messages", key: "claude-sonnet-4-5" }), [
      "temperature",
      "top_p",
      "top_k"
    ])
    assert.deepStrictEqual(samplersSent({ kind: "anthropic", api: "anthropic-messages", key: "claude-opus-5" }), [])
    assert.isTrue(takesVerbosity({ api: "openai-responses", key: "gpt-5.4" }))
    assert.isTrue(takesVerbosity({ api: "openai-completions", key: "openai/gpt-5-mini" }))
    assert.isFalse(takesVerbosity({ api: "openai-completions", key: "local-model" }))
    assert.isFalse(takesVerbosity({ api: "anthropic-messages", key: "claude-opus-5" }))
  })
})
