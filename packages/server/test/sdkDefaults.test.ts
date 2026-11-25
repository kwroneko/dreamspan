// SDK cache and transcript controls must reach compatible deployments with opaque IDs.
import { Type, type Context as PiContext } from "@earendil-works/pi-ai"
import { assert, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"
import { sdkCapabilityDefaults } from "../src/providers/sdkDefaults.ts"

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 1_000 } }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("sdk-defaults"), readers: 1, allowNetworkFs: false, ...testWorkers })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("synthetic sdk-default secret")))
  )

const tool = { name: "late_tool", description: "A later tool", parameters: Type.Object({}) }
const context: PiContext = {
  messages: [
    { role: "system", content: "Initial directive.", timestamp: 1 },
    { role: "user", content: "First question.", timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "text", text: "First answer." }],
      api: "openai-responses",
      provider: "openai",
      model: "museum-gpt",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 3
    },
    { role: "system", content: "Late directive.", toolsAdded: [tool], timestamp: 4 },
    { role: "user", content: "Second question.", timestamp: 5 }
  ]
}

for (const [kind, provider, key] of [
  ["openai-responses", "openai-compatible", "ft:gpt-5.6-sol:synthetic::deployment"],
  ["openai-responses", "openai-compatible", "museum-gpt"]
] as const)
  it.live(`${kind} ${provider} ${key} uses SDK cache and transcript controls by default`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => {
            sse(res, completionChunks(["Blue."], {}))
          })
        ),
        (server) => Effect.promise(() => server.close())
      )
      const writer = yield* Database.Writer
      const userId = (yield* writer.EnsureUser({ handle: "strict", displayName: "Synthetic" })).id as UserId
      const providers = yield* Providers.Providers
      const connection = yield* providers.createConnection({
        userId,
        provider,
        kind,
        settings: {
          name: "Synthetic strict",
          baseUrl: `${server.url}/v1`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "synthetic-strict-key"
      })
      const model = yield* writer.AddUserModel({ userId, connectionId: connection.id, key, overrides: {} })
      // A Responses stream need not be parsed to prove serialization: inspect the final request.
      const result = yield* providers
        .stream({
          userId,
          connectionId: connection.id,
          modelId: model.id,
          context,
          options: { cacheRetention: "long", sessionId: "synthetic-sdk-cache" },
          attribution: { purpose: "generation" }
        })
        .pipe(Stream.runCollect, Effect.result)
      const requests = server.requests().filter((request) => !request.path.endsWith("/models"))
      assert.lengthOf(requests, 1, `the SDK must dispatch the request: ${JSON.stringify(result)}`)
      const body = requests[0]!.body!
      assert.deepStrictEqual(body.prompt_cache_options, { ttl: "30m" })
      const input = body.input as Array<Record<string, unknown>>
      assert.isTrue(
        input.some(
          (item, index) =>
            index > 1 &&
            ["system", "developer"].includes(String(item.role)) &&
            JSON.stringify(item.content ?? "").includes("Late directive.")
        )
      )
      assert.isTrue(input.some((item) => item.type === "additional_tools"))
      const disabled = yield* writer.AddUserModel({
        userId,
        connectionId: connection.id,
        key: `${key}-off`,
        overrides: {
          compat: {
            supportsExplicitPromptCacheMode: false,
            supportsMidConvoSystemMessages: false,
            supportsAdditionalTools: false
          }
        }
      })
      const refused = yield* providers
        .stream({
          userId,
          connectionId: connection.id,
          modelId: disabled.id,
          context,
          options: { cacheRetention: "long", sessionId: "synthetic-sdk-cache" },
          attribution: { purpose: "generation" }
        })
        .pipe(Stream.runCollect, Effect.result)
      assert.isDefined(refused)
      const sent = server.requests().filter((request) => !request.path.endsWith("/models"))
      assert.lengthOf(sent, 2)
      assert.isUndefined(sent[1]!.body!.prompt_cache_options)
      assert.notInclude(JSON.stringify(sent[1]!.body!.input), '"additional_tools"')
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

it("scopes the recorded SDK refusals to their endpoint, model and operation", () => {
  const base = {
    api: "openai-responses",
    provider: "openai-compatible",
    baseUrl: "https://synthetic.invalid/v1",
    key: "museum-gpt",
    hasEffort: false,
    hasPriorEffort: false
  }
  assert.isTrue(sdkCapabilityDefaults(base).supportsExplicitPromptCacheMode)
  const routed = sdkCapabilityDefaults({
    ...base,
    provider: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    key: "openai/gpt-5.6-sol"
  })
  assert.isFalse(routed.supportsExplicitPromptCacheMode)
  assert.isTrue(routed.supportsAdditionalTools)
  const mini = sdkCapabilityDefaults({ ...base, provider: "openrouter", key: "openai/gpt-5.4-mini:nitro" })
  assert.isFalse(mini.supportsAdditionalTools)
  assert.isTrue(mini.supportsMidConvoSystemMessages)
  assert.isFalse(
    sdkCapabilityDefaults({ ...base, key: "ft:gpt-5.4-mini:synthetic::deployment" }).supportsExplicitPromptCacheMode
  )
  const nano = sdkCapabilityDefaults({ ...base, key: "upstream.gpt-5.4-nano-2026-03-17" })
  assert.isFalse(nano.supportsToolSearch)
  assert.isTrue(nano.supportsAdditionalTools)
  const messages = { ...base, api: "anthropic-messages", provider: "anthropic", hasEffort: true, hasPriorEffort: true }
  assert.isTrue(sdkCapabilityDefaults(messages).supportsMidConvoEffort)
  const refused = sdkCapabilityDefaults({ ...messages, key: "global.anthropic.claude-sonnet-4-6-v1:0" })
  assert.isFalse(refused.supportsMidConvoSystemMessages)
  assert.isFalse(refused.supportsMidConvoToolChanges)
  assert.isFalse(refused.supportsMidConvoEffort)
})
