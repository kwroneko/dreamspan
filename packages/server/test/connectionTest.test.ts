// Checking a connection (ARCHITECTURE §6 "Connections"): the model list and one short message,
// for a saved connection through the real request path, and for the new-connection form's values
// with nothing stored: not the connection, the typed key or the request.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ConnectionSettings, ModelId } from "@dreamspan/shared/providers.ts"
import { Effect, Layer } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { completionChunks, json, sse, startMockProvider, type Handler } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const KEY = "sk-typed-draft-key-5521"

const setup = () => {
  const dataDir = tempDir("conntest")
  const layer = Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 1_000 } }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
  )
  return { dataDir, layer }
}

const mock = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (server) => Effect.promise(() => server.close())
  )

const settings = (baseUrl: string): ConnectionSettings => ({
  name: "Draft",
  baseUrl,
  compat: {},
  cacheTtlS: null,
  maxConcurrent: null,
  presetOverrideRefId: null
})

/** Every byte the data directory holds, to show a value never reached it. */
const stored = (dir: string): string =>
  readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? stored(path) : readFileSync(path).toString("latin1")))
    .join("\n")

const provider: Handler = (request, res) => {
  if (request.headers.authorization !== `Bearer ${KEY}`)
    return json(res, 401, { error: { message: "Invalid API key provided" } })
  if (request.path === "/v1/models") return json(res, 200, { data: [{ id: "small" }, { id: "large" }] })
  sse(res, completionChunks(["Hello", " there."], { prompt_tokens: 3, completion_tokens: 2 }))
}

const user = Effect.gen(function* () {
  const writer = yield* Database.Writer
  return (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
})

describe("checking a connection", () => {
  const draft = setup()
  it.live("a draft lists models and sends one short message, storing nothing", () =>
    Effect.gen(function* () {
      const server = yield* mock(provider)
      const providers = yield* Providers.Providers
      const reader = yield* Database.Reader
      const userId = yield* user
      const base = {
        userId,
        role: "user" as const,
        kind: "openai-chat" as const,
        settings: settings(`${server.url}/v1`),
        apiKey: KEY
      }

      const listed = yield* providers.testDraft(base)
      assert.isTrue(listed.ok)
      assert.strictEqual(listed.models, 2)
      assert.deepStrictEqual(listed.modelKeys, ["small", "large"])
      assert.include(listed.route!, "direct")
      assert.isNull(listed.reply)
      assert.isFalse(server.requests().some((r) => r.path.endsWith("/chat/completions")))

      const sent = yield* providers.testDraft({ ...base, model: "large" })
      assert.isTrue(sent.ok)
      assert.strictEqual(sent.reply!.model, "large")
      assert.isTrue(sent.reply!.ok)
      assert.strictEqual(sent.reply!.text, "Hello there.")
      assert.isAtLeast(sent.reply!.ms, 0)
      const completion = server.requests().find((r) => r.path.endsWith("/chat/completions"))!
      assert.strictEqual(completion.body!["model"], "large")
      // One word, a tiny limit.
      assert.deepInclude(completion.body!["messages"] as Array<unknown>, { role: "user", content: "Hi" })
      assert.isAtMost(Number(completion.body!["max_tokens"] ?? completion.body!["max_completion_tokens"]), 16)
      assert.notInclude(JSON.stringify(sent), KEY)

      // Nothing was stored: no connection, no credential, no request, and the key is nowhere on disk.
      assert.lengthOf(yield* reader.ListConnections({ userId }), 0)
      assert.lengthOf(yield* reader.ListCredentials({ userId }), 0)
      assert.lengthOf(yield* reader.ListLlmRequests({ userId, limit: 10, before: null }), 0)
      assert.notInclude(stored(draft.dataDir), KEY)
    }).pipe(Effect.scoped, Effect.provide(draft.layer))
  )

  it.live("a wrong key fails both steps as auth, in the provider's words", () =>
    Effect.gen(function* () {
      const server = yield* mock(provider)
      const providers = yield* Providers.Providers
      const userId = yield* user
      const result = yield* providers.testDraft({
        userId,
        role: "user",
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        apiKey: "sk-wrong-key-000000",
        model: "small"
      })
      assert.isFalse(result.ok)
      assert.strictEqual(result.reason, "auth")
      assert.strictEqual(result.status, 401)
      assert.include(result.detail, "Invalid API key")
      assert.isFalse(result.reply!.ok)
      assert.strictEqual(result.reply!.reason, "auth")
      assert.notInclude(JSON.stringify(result), "sk-wrong-key-000000")
    }).pipe(Effect.scoped, Effect.provide(setup().layer))
  )

  it.live("an unreachable server is a network failure, and a cut-off reply still works", () =>
    Effect.gen(function* () {
      const providers = yield* Providers.Providers
      const userId = yield* user
      const down = yield* providers.testDraft({
        userId,
        role: "user",
        kind: "openai-chat",
        settings: settings("http://127.0.0.1:9/v1"),
        apiKey: KEY,
        model: "small"
      })
      assert.isFalse(down.ok)
      assert.strictEqual(down.reason, "network")
      assert.strictEqual(down.reply!.reason, "network")

      const server = yield* mock((request, res) =>
        request.path === "/v1/models"
          ? json(res, 200, { data: [{ id: "small" }] })
          : sse(
              res,
              completionChunks(["Hel"], { prompt_tokens: 3, completion_tokens: 16 }).map((chunk) =>
                JSON.stringify(chunk).includes('"stop"')
                  ? JSON.parse(JSON.stringify(chunk).replace('"stop"', '"length"'))
                  : chunk
              )
            )
      )
      const cut = yield* providers.testDraft({
        userId,
        role: "user",
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        apiKey: KEY,
        model: "small"
      })
      assert.isTrue(cut.ok)
      assert.strictEqual(cut.reply!.text, "Hel")
    }).pipe(Effect.scoped, Effect.provide(setup().layer))
  )

  it.live("another user's saved key can't be used, and nothing is sent", () =>
    Effect.gen(function* () {
      const server = yield* mock(provider)
      const providers = yield* Providers.Providers
      const writer = yield* Database.Writer
      const owner = yield* user
      const credential = yield* providers.createCredential({
        userId: owner,
        name: "Ana's",
        apiKey: KEY,
        urls: [server.url]
      })
      const other = (yield* writer.EnsureUser({ handle: "bo", displayName: "Bo" })).id as UserId
      const refused = yield* providers
        .testDraft({
          userId: other,
          role: "user",
          kind: "openai-chat",
          settings: settings(`${server.url}/v1`),
          credentialId: credential.id,
          model: "small"
        })
        .pipe(Effect.flip)
      assert.strictEqual((refused as Providers.ProviderError).reason, "unusable")
      assert.lengthOf(server.requests(), 0)

      // The owner's own saved key works, as the created connection would use it.
      const own = yield* providers.testDraft({
        userId: owner,
        role: "user",
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        credentialId: credential.id,
        model: "small"
      })
      assert.isTrue(own.ok)
    }).pipe(Effect.scoped, Effect.provide(setup().layer))
  )

  it.live("a saved connection's message goes through the request path and is recorded as a test", () =>
    Effect.gen(function* () {
      const server = yield* mock(provider)
      const providers = yield* Providers.Providers
      const reader = yield* Database.Reader
      const userId = yield* user
      const connection = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: settings(`${server.url}/v1`),
        apiKey: KEY
      })
      yield* providers.refreshModels(userId, connection.id)
      const models = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
      const modelId = models.find((m) => m.key === "small")!.id as ModelId
      const result = yield* providers.testConnection(userId, connection.id, modelId)
      assert.isTrue(result.ok)
      assert.strictEqual(result.models, 2)
      assert.strictEqual(result.reply!.text, "Hello there.")
      assert.include(result.reply!.route!, "direct")
      const [row] = yield* reader.ListLlmRequests({ userId, limit: 10, before: null })
      assert.strictEqual(row!.purpose, "test")
      assert.strictEqual(row!.status, "complete")
    }).pipe(Effect.scoped, Effect.provide(setup().layer))
  )
})
