// Composition of the HTTP server: the RPC endpoint over a WebSocket, a health route,
// and the client build served as a single-page app.
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { AppApi, CurrentUser, Health } from "@rp/shared/api.ts"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { AuthenticationLive } from "./auth.ts"
import { AppConfig } from "./config.ts"
import * as Database from "./db/Database.ts"
import { EventLoopMonitor } from "./eventLoop.ts"

const VERSION = "0.0.0"
const startedAt = Date.now()

const Handlers = AppApi.toLayer(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const eventLoop = yield* EventLoopMonitor
    return AppApi.of({
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

const HealthRoute = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"))

const StaticRoutes = Layer.unwrap(
  Effect.map(AppConfig, (config) => HttpStaticServer.layer({ root: config.clientDist, spa: true }))
)

const DatabaseLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    Database.layer({ dataDir: config.dataDir, readers: config.dbReaders, allowNetworkFs: config.dbAllowNetworkFs })
  )
)

const HttpServerLive = Layer.unwrap(
  Effect.map(AppConfig, (config) => NodeHttpServer.layer(createServer, { host: config.host, port: config.port }))
)

/** The whole server, minus configuration. Tests provide their own AppConfig. */
export const ServerLive = HttpRouter.serve(Layer.mergeAll(RpcRoute, HealthRoute, StaticRoutes)).pipe(
  Layer.provide([DatabaseLive, EventLoopMonitor.layer]),
  Layer.provide(HttpServerLive)
)
