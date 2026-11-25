// A constrained tool must reach each compatible wire even when the deployment has an opaque ID.
import { Type, type Context as PiContext } from "@earendil-works/pi-ai"
import { assert, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { anthropicSse, completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 1_000 } }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("strict-defaults"), readers: 1, allowNetworkFs: false, ...testWorkers })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("synthetic strict-default secret")))
  )

const context: PiContext = {
  messages: [{ role: "user", content: "Choose blue.", timestamp: 1 }],
  tools: [
    {
      name: "color",
      description: "Choose a color",
      parameters: Type.Object({ color: Type.Literal("blue") }),
      constrainedSampling: { type: "json_schema", strict: "require" }
    }
  ]
}

for (const [kind, provider, key] of [
  ["openai-chat", "openai-compatible", "museum-gpt"],
  ["openai-chat", "openai", "o4-mini-2025-04-16"],
  ["openai-responses", "openai-compatible", "ft:gpt-5.6-sol:synthetic::deployment"],
  ["anthropic", "anthropic", "museum-claude"]
] as const)
  it.live(`${kind} ${provider} ${key} sends a strict-required tool by default`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            if (request.path.endsWith("/messages")) return anthropicSse(res, [])
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
          attribution: { purpose: "generation" }
        })
        .pipe(Stream.runCollect, Effect.result)
      const requests = server.requests().filter((request) => !request.path.endsWith("/models"))
      assert.lengthOf(requests, 1, `the SDK must dispatch strict sampling: ${JSON.stringify(result)}`)
      const tools = requests[0]!.body!.tools as Array<{
        name?: string
        strict?: boolean
        function?: { name: string; strict?: boolean }
      }>
      const tool = tools.find((tool) => (tool.function?.name ?? tool.name) === "color")!
      assert.isDefined(tool)
      assert.strictEqual(tool.function?.strict ?? tool.strict, true)
      const disabled = yield* writer.AddUserModel({
        userId,
        connectionId: connection.id,
        key: `${key}-off`,
        overrides: { compat: { [kind === "anthropic" ? "supportsStrictTools" : "supportsStrictMode"]: false } }
      })
      const refused = yield* providers
        .stream({
          userId,
          connectionId: connection.id,
          modelId: disabled.id,
          context,
          attribution: { purpose: "generation" }
        })
        .pipe(Stream.runCollect, Effect.result)
      assert.strictEqual(refused._tag, "Failure")
      if (refused._tag === "Failure") assert.include(refused.failure.message, "strict tools are unsupported")
      assert.lengthOf(
        server.requests().filter((request) => !request.path.endsWith("/models")),
        1
      )
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
