import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { AppApi } from "@rp/shared/api.ts"
import { Effect, Layer } from "effect"
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
  authMode: "single",
  authProxyHeader: "remote-user",
  clientDist: join(tmpdir(), "rp-no-client"),
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
})
