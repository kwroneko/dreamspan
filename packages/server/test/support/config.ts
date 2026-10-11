import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppApi } from "@rp/shared/api.ts"
import { Effect, Layer, Option } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { AppConfig, type AppConfigShape } from "../../src/config.ts"
import { ServerLive } from "../../src/server.ts"

// Below Linux's ephemeral range (32768+), where outgoing connections could already hold
// a port. Sequential from a random start, so a file's own servers never collide.
let port = 20_000 + Math.floor(Math.random() * 12_000)
const nextPort = () => (port = port >= 32_000 ? 20_000 : port + 1)

/** A server on a free-looking loopback port with a fresh data directory. */
export const testConfig = (overrides: Partial<AppConfigShape> = {}): AppConfigShape => ({
  host: "127.0.0.1",
  port: nextPort(),
  dataDir: mkdtempSync(join(tmpdir(), "rp-server-")),
  dbReaders: 1,
  dbAllowNetworkFs: false,
  dbWorkers: "source",
  authMode: "single",
  authProxyHeader: "remote-user",
  allowedIps: [],
  trustedProxies: [],
  allowInsecureExposure: false,
  publicOrigins: [],
  loopbackRequiresLogin: true,
  adminUser: Option.none(),
  adminPassword: Option.none(),
  adminPasswordFile: Option.none(),
  clientDist: join(tmpdir(), "rp-no-client"),
  secretKey: Option.none(),
  secretKeyFile: Option.none(),
  keyHostBinding: true,
  ...overrides
})

export const serverLayer = (config: AppConfigShape) => ServerLive.pipe(Layer.provide(Layer.succeed(AppConfig)(config)))

export const withServer = (config: AppConfigShape) => Effect.provide(serverLayer(config))

/**
 * An RPC client over a real WebSocket, living as long as the enclosing scope.
 * Node's WebSocket accepts handshake headers, which stand in for a reverse proxy or a cookie.
 * Connecting to one of this machine's other addresses makes the connection come from it.
 */
export const client = (config: AppConfigShape, headers: Record<string, string> = {}, address = "127.0.0.1") =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://${address}:${config.port}/rpc`)),
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

/** An HTTP POST to the test server, as JSON unless the headers say otherwise. */
export const post = (config: AppConfigShape, path: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.promise(() =>
    fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    })
  )

/** Logs in, resolving to the status and the `cookie` header for later requests. */
export const login = (config: AppConfigShape, handle: string, password: string) =>
  post(config, "/auth/login", { handle, password }).pipe(
    Effect.map((response) => {
      const setCookie = response.headers.get("set-cookie") ?? ""
      return { status: response.status, setCookie, cookie: setCookie.split(";")[0]! }
    })
  )

/** The outcome of an RPC as a short string: "ok", or the error tag and reason. */
export const outcome = <A, E>(effect: Effect.Effect<A, E>, show: (a: A) => string = () => "ok") =>
  effect.pipe(
    Effect.map(show),
    Effect.catch((error: E) =>
      Effect.succeed(
        `${(error as { _tag: string })._tag}${(error as { reason?: string }).reason ? `:${(error as { reason: string }).reason}` : ""}`
      )
    )
  )
