import { makeHistoryHandlers } from "./api/history.ts"
import { ExecutionRegistry } from "./execution.ts"
import { RefusalJudge } from "./decision/RefusalJudge.ts"
import { SummaryChecks } from "./lcm/OutputChecks.ts"
import { Summarizer } from "./lcm/Summarizer.ts"
import { makeLcmHandlers } from "./api/lcm.ts"
// Composition of the HTTP server: the RPC endpoint over a WebSocket, login and logout,
// a health route, and the client build served as a single-page app.
import { createServer } from "node:http"
import type { Socket } from "node:net"
import type { Duplex } from "node:stream"
import { NodeHttpServer } from "@effect/platform-node"
import { AppApi, CurrentUser, Health } from "@rp/shared/api.ts"
import { ByteSize, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  Headers,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer
} from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { makeAccountHandlers } from "./api/accounts.ts"
import { makeLibraryHandlers } from "./api/library.ts"
import { makeChatHandlers } from "./api/chats.ts"
import { makeChatSetupHandlers } from "./api/chatSetup.ts"
import { makeEditorHandlers } from "./api/editor.ts"
import { makeGenerationHandlers } from "./api/generation.ts"
import { makeBinHandlers } from "./api/bin.ts"
import { makeComposerHandlers } from "./api/composer.ts"
import { makeNoticeHandlers } from "./api/notices.ts"
import { makeInspectorHandlers } from "./api/inspector.ts"
import { Notices } from "./chat/Notices.ts"
import { makeProviderHandlers } from "./api/providers.ts"
import { makeStImportHandlers } from "./api/stImport.ts"
import { Accounts, AuthenticationLive, PEER_HEADER, SESSION_COOKIE, SESSION_TTL_MS } from "./auth/Accounts.ts"
import { CacheWarmth } from "./chat/CacheWarmth.ts"
import { ChatHub } from "./chat/ChatHub.ts"
import { Generations } from "./chat/Generations.ts"
import * as ContextGenerator from "./chat/ContextGenerator.ts"
import type { Generator } from "./chat/Generator.ts"
import { AppConfig } from "./config.ts"
import * as Database from "./db/Database.ts"
import { EventLoopMonitor } from "./eventLoop.ts"
import * as Formats from "./importer/Formats.ts"
import * as ImportRoutes from "./importer/routes.ts"
import { MediaHolds } from "./importer/MediaHolds.ts"
import { StImports } from "./importer/StImports.ts"
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
    const accounts = yield* makeAccountHandlers
    const library = yield* makeLibraryHandlers
    const chats = yield* makeChatHandlers
    const chatSetup = yield* makeChatSetupHandlers
    // --- ST data folder import
    const stImport = yield* makeStImportHandlers
    const editor = yield* makeEditorHandlers
    const generation = yield* makeGenerationHandlers
    // --- The recycle bin, the composer's drafts, notices
    const bin = yield* makeBinHandlers
    const composer = yield* makeComposerHandlers
    const notices = yield* makeNoticeHandlers
    const inspector = yield* makeInspectorHandlers
    return AppApi.of({
      ...providers,
      ...accounts,
      ...library,
      ...chats,
      ...chatSetup,
      ...stImport,
      ...editor,
      ...generation,
      ...bin,
      ...composer,
      ...notices,
      ...inspector,
      ...(yield* makeLcmHandlers),
      ...(yield* makeHistoryHandlers),
      Health: () =>
        eventLoop.sample.pipe(
          Effect.map(
            (delay) =>
              new Health({
                version: VERSION,
                uptimeMs: Date.now() - startedAt,
                eventLoopP99Ms: delay.p99Ms,
                eventLoopMaxMs: delay.maxMs,
                readers: config.dbReaders
              })
          )
        ),
      Whoami: () => CurrentUser
    })
  })
)

/**
 * RPC requests received and not yet answered, so a stop can let their replies go out
 * first. Once `closing`, new requests are dropped unanswered: nothing starts that the stop
 * might cut off between its commit and its reply.
 */
class InFlightRpcs extends Context.Service<InFlightRpcs, { count: number; closing: boolean }>()(
  "rp/server/InFlightRpcs"
) {
  static readonly layer = Layer.sync(InFlightRpcs, () => ({ count: 0, closing: false }))
}

/**
 * JSON, minus the headers a client puts in its own messages. The RPC server appends
 * those to the upgrade request's headers, later entries win, and authentication reads
 * the result: a client could otherwise name any user in proxy mode. Identity comes
 * only from the upgrade request. It also counts requests in and replies (exits) out.
 */
const TransportHeadersOnly = Layer.effect(
  RpcSerialization.RpcSerialization,
  Effect.map(InFlightRpcs, (inFlight) =>
    RpcSerialization.RpcSerialization.of({
      ...RpcSerialization.json,
      makeUnsafe: () => {
        const parser = RpcSerialization.json.makeUnsafe()
        return {
          encode: (response) => {
            const replies = Array.isArray(response) ? response : [response]
            inFlight.count -= replies.filter((reply) => Predicate.isTagged(reply, "Exit")).length
            return parser.encode(response)
          },
          decode: (data) =>
            parser.decode(data).flatMap((message) => {
              if (!Predicate.isTagged(message, "Request")) return [message]
              if (inFlight.closing) return []
              inFlight.count++
              return [{ ...message, headers: [] }]
            })
        }
      }
    })
  )
)

const RpcRoute = RpcServer.layerHttp({ group: AppApi, path: "/rpc", protocol: "websocket" }).pipe(
  Layer.provide([Handlers, AuthenticationLive, TransportHeadersOnly])
)

/** A host as a URL has it (name, IPv4 or bracketed IPv6, and a port), safe to put in a header. */
const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/

/**
 * The Content-Security-Policy on every response. Only the app's own scripts run: none
 * inline, none from elsewhere, so markup that slipped past sanitizing can't run script.
 * Images load only from the app itself, so text can't report on the chat through an
 * image URL (Markdown blocks them as well). Connections go to the app and its WebSocket,
 * on the host the browser used; `'self'` covers the WebSocket in current browsers, the
 * explicit origins cover older ones.
 */
const contentSecurityPolicy = (host: string | undefined) => {
  const socket = host !== undefined && HOST.test(host) ? ` ws://${host} wss://${host}` : ""
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src 'self'${socket}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ")
}

/**
 * Every request passes here first. It refuses other sites' pages and DNS-rebound names
 * (net/exposure.ts), and records the socket's address in PEER_HEADER for authentication,
 * replacing any copy the client sent. Every response gets the Content-Security-Policy.
 */
const RequestGuard = HttpRouter.middleware(
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
        const csp = HttpServerResponse.setHeader("content-security-policy", contentSecurityPolicy(request.headers.host))
        const headers = { host: request.headers.host, origin: request.headers.origin }
        const problem = crossSiteProblem(headers, publicOrigins, checkHost)
        if (problem !== undefined) return Effect.succeed(csp(HttpServerResponse.text(problem, { status: 403 })))
        const withoutPeer = Headers.remove(request.headers, PEER_HEADER)
        const peered = request.modify({
          headers: Option.match(request.remoteAddress, {
            onNone: () => withoutPeer,
            onSome: (address) => Headers.set(withoutPeer, PEER_HEADER, address)
          })
        })
        return Effect.provideService(httpEffect, HttpServerRequest.HttpServerRequest, peered).pipe(Effect.map(csp))
      })
  }),
  { global: true }
)

const HealthRoute = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"))

const LoginBody = Schema.Struct({ handle: Schema.String, password: Schema.String })

const jsonError = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

/**
 * Login and logout are plain HTTP, since only a response can set a cookie. The session
 * cookie is HttpOnly and SameSite=Strict, and Secure when the page is on https. A
 * WebSocket opened before login doesn't carry it: the client reconnects.
 */
const AuthRoutes = Layer.mergeAll(
  HttpRouter.add(
    "POST",
    "/auth/login",
    Effect.gen(function* () {
      const accounts = yield* Accounts
      const request = yield* HttpServerRequest.HttpServerRequest
      // A cross-site form can't send JSON, on top of the Origin check in RequestGuard.
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return jsonError(415, "expected application/json")
      }
      const body = yield* HttpServerRequest.schemaBodyJson(LoginBody).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
        Effect.option
      )
      if (Option.isNone(body)) return jsonError(400, "expected a handle and a password")
      const token = yield* accounts.login(body.value.handle, body.value.password, request.headers[PEER_HEADER] ?? "")
      return yield* HttpServerResponse.empty({ status: 204 }).pipe(
        HttpServerResponse.setCookie(SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          maxAge: `${SESSION_TTL_MS} millis`,
          secure: request.headers.origin?.startsWith("https://") ?? false
        }),
        Effect.orDie
      )
    }).pipe(
      Effect.catchTags({
        AccountRejected: (error) => Effect.succeed(jsonError(error.reason === "proxy_mode" ? 404 : 401, error.message)),
        LoginThrottled: (error) =>
          Effect.succeed(
            jsonError(429, "too many failed logins").pipe(
              HttpServerResponse.setHeader("retry-after", String(Math.ceil(error.retryAfterMs / 1000)))
            )
          ),
        ServerError: (error) => Effect.succeed(jsonError(500, error.message))
      })
    )
  ),
  HttpRouter.add(
    "POST",
    "/auth/logout",
    Effect.gen(function* () {
      const accounts = yield* Accounts
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = request.cookies[SESSION_COOKIE]
      if (token) yield* accounts.logout(token)
      return yield* HttpServerResponse.empty({ status: 204 }).pipe(
        HttpServerResponse.expireCookie(SESSION_COOKIE, { path: "/" }),
        Effect.orDie
      )
    }).pipe(Effect.catchTag("ServerError", (error) => Effect.succeed(jsonError(500, error.message))))
  )
)

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

/** A server-to-client WebSocket close frame (unmasked) with code 1001, "going away". */
const WEBSOCKET_GOING_AWAY = Buffer.from([0x88, 0x02, 0x03, 0xe9])
/** How long RPCs in flight get to reply once the server stops, before WebSockets are closed. */
const DRAIN_MS = 2000
/** How long sockets get to close after that, before they're destroyed. */
const CLOSE_MS = 1000

/**
 * Refused peers are turned away on connect, before the socket is read, so no route,
 * upgrade or static file is reachable from them.
 */
const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const accounts = yield* Accounts
    const inFlight = yield* InFlightRpcs
    const policy = exposurePolicy(config, accounts.configured)
    if (typeof policy === "string") return yield* new UnsafeExposure({ message: policy })
    yield* Effect.logInfo(`Exposure: ${policy.summary}`)
    const make = () => {
      const sockets = new Set<Socket>()
      const upgraded = new WeakSet<Duplex>()
      const server = createServer()
        .on("connection", (socket) => {
          if (policy.allows(socket.remoteAddress)) {
            sockets.add(socket)
            socket.once("close", () => sockets.delete(socket))
            return
          }
          // Destroyed, not just ended: the HTTP parser is already attached, and on a
          // half-open socket it would still dispatch the peer's requests.
          socket.write(REFUSED_RESPONSE)
          socket.destroy()
        })
        .on("upgrade", (_request, socket) => upgraded.add(socket))
      // close() waits for every connection, and an open tab's WebSocket never ends on its
      // own: a stop would hang until killed, with the database workers mid-flight. So a
      // close ends idle HTTP connections, lets the RPCs in flight reply (two quiet checks
      // in a row, so a reply being written goes out too), then tells WebSockets the server
      // is going away, and destroys whatever is left. Each wait is bounded.
      const close = server.close.bind(server)
      server.close = ((callback?: (error?: Error) => void) => {
        close(callback)
        inFlight.closing = true
        server.closeIdleConnections()
        const deadline = Date.now() + DRAIN_MS
        let quiet = 0
        const drain = setInterval(() => {
          quiet = inFlight.count <= 0 ? quiet + 1 : 0
          if (quiet < 2 && Date.now() < deadline) return
          clearInterval(drain)
          for (const socket of sockets) if (upgraded.has(socket)) socket.end(WEBSOCKET_GOING_AWAY)
          setTimeout(() => {
            for (const socket of sockets) socket.destroy()
          }, CLOSE_MS).unref()
        }, 25)
        return server
      }) as typeof server.close
      return server
    }
    return NodeHttpServer.layer(make, { host: config.host, port: config.port })
  })
)

/** The format workers (ARCHITECTURE.md §11.3), started alongside the database's. */
const FormatsLive = Layer.unwrap(
  Effect.map(AppConfig, (config) => Formats.layer({ workers: config.dbWorkers, size: config.formatWorkers }))
)

/**
 * The whole server with this generator, minus configuration. Tests provide their own
 * AppConfig, with port 0, and read the port the kernel picked from the HttpServer this exposes.
 */
export const serverWith = <E>(
  generator: Layer.Layer<
    Generator,
    E,
    AppConfig | Database.Reader | Database.Writer | Providers.Providers | Summarizer
  >,
  summaries = Summarizer.layer,
  formats = FormatsLive
) =>
  HttpRouter.serve(
    Layer.mergeAll(
      RpcRoute,
      HealthRoute,
      AuthRoutes,
      ImportRoutes.layer,
      StaticRoutes,
      InterruptedRequests,
      RequestGuard
    )
  ).pipe(
    // --- ST data folder import (ARCHITECTURE.md §13)
    // Provided on, so a plugin can register folder handlers into it (PLUGINS §8).
    Layer.provideMerge(StImports.layer.pipe(Layer.provideMerge(MediaHolds.layer))),
    Layer.provide(
      Layer.merge(Generations.layer, CacheWarmth.layer).pipe(
        Layer.provideMerge(generator),
        Layer.provideMerge(summaries),
        // The refusal judge registers itself with the summary checks the summarizer runs.
        Layer.provideMerge(RefusalJudge.layer.pipe(Layer.provideMerge(SummaryChecks.layer))),
        // Last, so the summarizer can tell open chats that their summaries changed.
        Layer.provideMerge(ChatHub.layer)
      )
    ),
    Layer.provideMerge(ExecutionRegistry.layer),
    Layer.provideMerge(Notices.layer),
    Layer.provide(ProvidersLive),
    Layer.provideMerge(HttpServerLive),
    Layer.provideMerge(Accounts.layer),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, EventLoopMonitor.layer, formats)),
    Layer.provide(InFlightRpcs.layer)
  )

/**
 * The whole server, minus configuration, generating with the context assembler and the
 * provider layer (ARCHITECTURE §15). The fake generator is only in the development entry
 * point (dev/main.ts) and the tests.
 */
export const ServerLive = serverWith(ContextGenerator.layer)
