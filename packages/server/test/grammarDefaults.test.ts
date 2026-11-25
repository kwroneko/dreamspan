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
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 1_000 } }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("grammar-defaults"), readers: 1, allowNetworkFs: false, ...testWorkers })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("synthetic grammar-default secret")))
  )

const context: PiContext = {
  messages: [{ role: "user", content: "Choose blue.", timestamp: 1 }],
  tools: [
    {
      name: "color",
      description: "Choose a color",
      parameters: Type.Object({ color: Type.Literal("blue") }),
      constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "blue"' } }
    }
  ]
}

for (const [kind, provider, key] of [
  ["openai-chat", "openai-compatible", "museum-gpt"],
  ["openai-responses", "openai-compatible", "ft:gpt-5.6-sol:synthetic::deployment"]
] as const)
  it.live(`${kind} ${provider} ${key} sends a grammar-constrained tool by default`, () =>
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
          attribution: { purpose: "generation" }
        })
        .pipe(Stream.runCollect, Effect.result)
      const requests = server.requests().filter((request) => !request.path.endsWith("/models"))
      assert.lengthOf(requests, 1, `the SDK must dispatch grammar sampling: ${JSON.stringify(result)}`)
      const tools = requests[0]!.body!.tools as Array<Record<string, unknown>>
      assert.strictEqual(tools[0]!.type, "custom")
      const declaration = (tools[0]!.custom ?? tools[0]) as {
        format: { grammar?: { definition: string }; definition?: string }
      }
      assert.strictEqual(declaration.format.grammar?.definition ?? declaration.format.definition, 'start: "blue"')
      const disabled = yield* writer.AddUserModel({
        userId,
        connectionId: connection.id,
        key: `${key}-off`,
        overrides: { compat: { supportsOpenAIGrammarTools: false } }
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
      assert.isDefined(refused)
      const sent = server.requests().filter((request) => !request.path.endsWith("/models"))
      assert.lengthOf(sent, 2)
      assert.strictEqual((sent[1]!.body!.tools as Array<{ type: string }>)[0]!.type, "function")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
