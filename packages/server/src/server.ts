// Composition of the HTTP server: the RPC endpoint over a WebSocket, a health route,
// and the client build served as a single-page app.
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { AppApi, CurrentUser, Health } from "@rp/shared/api.ts"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { makeProviderHandlers } from "./api/providers.ts"
import { AuthenticationLive } from "./auth.ts"
import { AppConfig } from "./config.ts"
import * as Database from "./db/Database.ts"
import { EventLoopMonitor } from "./eventLoop.ts"
import {
  crossSiteProblem,
  exposurePolicy,
  parsePublicOrigins,
  REFUSED_RESPONSE,
  UnsafeExposure
} from "./net/exposure.ts"
import * as Network from "./net/Network.ts"
import * as ProviderBuiltins from "./providers/builtins.ts"
import * as Providers from "./providers/Providers.ts"
import * as Secrets from "./secrets.ts"

const VERSION = "0.0.0"
const startedAt = Date.now()

const Handlers = AppApi.toLayer(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const eventLoop = yield* EventLoopMonitor
    const providers = yield* makeProviderHandlers
    return AppApi.of({
      ...providers,
      Health: () =>
        eventLoop.sampleP99Ms.pipe(
          Effect.map(
            (eventLoopP99Ms) =>
              new Health({
                version: VERSION,
                uptimeMs: Date.now() - startedAt,
                eventLoopP99Ms,
                readers: config.dbReaders
              })
          )
        ),
      Whoami: () => CurrentUser
    })
  })
)

const RpcRoute = RpcServer.layerHttp({ group: AppApi, path: "/rpc", protocol: "websocket" }).pipe(
  Layer.provide([Handlers, AuthenticationLive, RpcSerialization.layerJson])
)

/** Refuses requests from other sites' pages and DNS-rebound names (net/exposure.ts). */
const CrossSiteGuard = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const { publicOrigins, invalid } = parsePublicOrigins(config.publicOrigins)
    if (invalid.length > 0) {
      return yield* new UnsafeExposure({
        message: `PUBLIC_ORIGINS entries must be exact origins (scheme://host[:port], default port omitted, no path): ${invalid.join(", ")}`
      })
    }
    // With loopback trusted, a page rebound to it is same-origin and could fetch() with its
    // own identity header. A same-host proxy forwards 127.0.0.1 or localhost, which pass.
    const checkHost = config.authMode === "single" || config.trustedProxies.every((entry) => entry.trim() === "")
    if (!checkHost && publicOrigins.origins.length === 0) {
      yield* Effect.logWarning(
        "Proxy mode without PUBLIC_ORIGINS: browsers are refused unless the proxy forwards the Host they used"
      )
    }
    return (httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        const headers = { host: request.headers.host, origin: request.headers.origin }
        const problem = crossSiteProblem(headers, publicOrigins, checkHost)
        return problem === undefined ? httpEffect : Effect.succeed(HttpServerResponse.text(problem, { status: 403 }))
      })
  }),
  { global: true }
)

const HealthRoute = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"))

const StaticRoutes = Layer.unwrap(
  Effect.map(AppConfig, (config) => HttpStaticServer.layer({ root: config.clientDist, spa: true }))
)

const DatabaseLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    Database.layer({
      dataDir: config.dataDir,
      readers: config.dbReaders,
      allowNetworkFs: config.dbAllowNetworkFs,
      workers: config.dbWorkers
    })
  )
)

const SecretsLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    Secrets.layer({ dataDir: config.dataDir, secretKey: config.secretKey, secretKeyFile: config.secretKeyFile })
  )
)

/** The provider layer and what it needs: the server secret, the network module, storage. */
const ProvidersLive = Layer.unwrap(
  Effect.map(AppConfig, (config) => Providers.layer({ bindKeysToOrigins: config.keyHostBinding }))
).pipe(Layer.provideMerge(Network.layer), Layer.provideMerge(SecretsLive), Layer.provideMerge(ProviderBuiltins.layer))

/**
 * Requests left running by a previous process may have been billed, so they're kept,
 * marked interrupted, never left looking live (spec/PROVIDERS.md §9.1).
 */
const InterruptedRequests = Layer.effectDiscard(
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const { interrupted } = yield* writer.InterruptRunningLlmRequests()
    if (interrupted > 0) yield* Effect.logWarning(`${interrupted} model requests were interrupted by the last shutdown`)
  })
)

/**
 * Refused peers are turned away on connect, before the socket is read, so no route,
 * upgrade or static file is reachable from them.
 */
const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const policy = exposurePolicy(config)
    if (typeof policy === "string") return yield* new UnsafeExposure({ message: policy })
    yield* Effect.logInfo(`Exposure: ${policy.summary}`)
    const make = () =>
      createServer().on("connection", (socket) => {
        if (policy.allows(socket.remoteAddress)) return
        // Destroyed, not just ended: the HTTP parser is already attached, and on a
        // half-open socket it would still dispatch the peer's requests.
        socket.write(REFUSED_RESPONSE)
        socket.destroy()
      })
    return NodeHttpServer.layer(make, { host: config.host, port: config.port })
  })
)

/** The whole server, minus configuration. Tests provide their own AppConfig. */
export const ServerLive = HttpRouter.serve(
  Layer.mergeAll(RpcRoute, HealthRoute, StaticRoutes, InterruptedRequests, CrossSiteGuard)
).pipe(
  Layer.provide(ProvidersLive),
  Layer.provideMerge(Layer.mergeAll(DatabaseLive, EventLoopMonitor.layer)),
  Layer.provide(HttpServerLive)
)
