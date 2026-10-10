import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { AppApi } from "@rp/shared/api.ts"
import { Effect, Layer, Option } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { AppConfig, type AppConfigShape } from "../src/config.ts"
import { ServerLive } from "../src/server.ts"

const testConfig = (overrides: Partial<AppConfigShape> = {}): AppConfigShape => ({
  host: "127.0.0.1",
  port: 40_000 + Math.floor(Math.random() * 20_000),
  dataDir: mkdtempSync(join(tmpdir(), "rp-rpc-")),
  dbReaders: 1,
  dbAllowNetworkFs: false,
  dbWorkers: "source",
  authMode: "single",
  authProxyHeader: "remote-user",
  clientDist: join(tmpdir(), "rp-no-client"),
  secretKey: Option.none(),
  secretKeyFile: Option.none(),
  ...overrides
})

/**
 * An RPC client over a real WebSocket, living as long as the enclosing scope.
 * Node's WebSocket accepts handshake headers, which stand in for a reverse proxy.
 */
const client = (config: AppConfigShape, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://${config.host}:${config.port}/rpc`)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor)(
            (url) => new WebSocket(url, { headers } as unknown as string[]) as unknown as globalThis.WebSocket
          )
        ),
        Layer.provide(RpcSerialization.layerJson)
      )
    )
    return yield* RpcClient.make(AppApi).pipe(Effect.provide(protocol))
  })

const withServer = (config: AppConfigShape) =>
  Effect.provide(ServerLive.pipe(Layer.provide(Layer.succeed(AppConfig)(config))))

describe("rpc", () => {
  it.live("single-user mode: every connection is the local admin", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(config)
      const me = yield* api.Whoami()
      assert.strictEqual(me.handle, "local")
      assert.strictEqual(me.role, "admin")
      const health = yield* api.Health()
      assert.strictEqual(health.readers, 1)
      assert.isAtLeast(health.eventLoopP99Ms, 0)
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("proxy mode: the identity header selects the user, and its absence is Unauthorized", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const alice = yield* client(config, { "Remote-User": "alice" })
      assert.strictEqual((yield* alice.Whoami()).handle, "alice")

      const bob = yield* client(config, { "Remote-User": "bob" })
      const bobUser = yield* bob.Whoami()
      assert.strictEqual(bobUser.handle, "bob")
      assert.strictEqual(bobUser.role, "user") // alice came first and administers the instance

      const anonymous = yield* client(config)
      const result = yield* anonymous.Whoami().pipe(
        Effect.map(() => "allowed"),
        Effect.catchTag("Unauthorized", (e) => Effect.succeed(`Unauthorized: ${e.message}`))
      )
      assert.strictEqual(result, "Unauthorized: missing remote-user header")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("connections: a key goes in and never comes out, and other users see nothing", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const alice = yield* client(config, { "Remote-User": "alice" })
      const bob = yield* client(config, { "Remote-User": "bob" })
      yield* alice.Whoami()

      const created = yield* alice.CreateConnection({
        kind: "openrouter",
        settings: {
          name: "Gateway",
          baseUrl: null,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-or-secret-value-4321"
      })
      assert.isTrue(created.hasKey)
      assert.strictEqual(created.keyHint, "4321")
      const listed = yield* alice.ListConnections()
      assert.notInclude(JSON.stringify(listed), "secret-value")
      yield* alice.SetConnectionHeaders({ connectionId: created.id, headers: { "X-Token": "header-secret" } })
      assert.notInclude(JSON.stringify(yield* alice.ListConnections()), "header-secret")

      // Bob can't see, use, change or delete Alice's connection.
      assert.deepStrictEqual(yield* bob.ListConnections(), [])
      const outcome = <A, E extends { readonly _tag: string }>(attempt: Effect.Effect<A, E>) =>
        attempt.pipe(
          Effect.map(() => "allowed"),
          Effect.catch((error: E) =>
            Effect.succeed(
              "reason" in error ? `${error._tag}:${String((error as { reason: unknown }).reason)}` : error._tag
            )
          )
        )
      const outcomes = yield* Effect.all([
        outcome(bob.SetConnectionKey({ connectionId: created.id, apiKey: "sk-bob" })),
        outcome(bob.TestConnection({ connectionId: created.id })),
        outcome(bob.RefreshModels({ connectionId: created.id })),
        outcome(bob.ListModels({ connectionId: created.id, includeHidden: true })),
        outcome(bob.DeleteConnection({ connectionId: created.id }))
      ])
      for (const result of outcomes) assert.oneOf(result, ["NotFound", "ProviderError:unusable"])
      assert.isTrue((yield* alice.ListConnections())[0]!.hasKey)
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("network settings are for admins only, and never show proxy credentials", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const alice = yield* client(config, { "Remote-User": "alice" })
      yield* alice.Whoami()
      const bob = yield* client(config, { "Remote-User": "bob" })
      const refused = yield* bob.GetNetworkSettings().pipe(
        Effect.map(() => "allowed"),
        Effect.catch((error) => Effect.succeed(error._tag))
      )
      assert.strictEqual(refused, "Forbidden")
      const set = yield* alice.SetNetworkSettings({
        proxyUrl: "socks5://user:pw@vpn.example:1080",
        bypass: ["localhost", "192.168.0.0/16"]
      })
      assert.strictEqual(set.proxy, "socks5://vpn.example:1080")
      const invalid = yield* alice.SetNetworkSettings({ bypass: ["not a host"] }).pipe(
        Effect.map(() => "allowed"),
        Effect.catch((error) => Effect.succeed(error._tag))
      )
      assert.strictEqual(invalid, "InvalidNetworkSettings")
    }).pipe(Effect.scoped, withServer(config))
  })
})
