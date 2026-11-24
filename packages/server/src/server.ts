import { TransportApi, type TransportRpcs } from "@dreamspan/shared/transportApi.ts"
import { installCardSourceCommands } from "./agent/cardSourceCommands.ts"
import { pluginRoutes } from "./plugins/serve.ts"
import { PluginHost } from "./plugins/Host.ts"
import { WorkshopFiles } from "./files/WorkshopFiles.ts"
import { makePluginHandlers } from "./api/plugins.ts"
import { AuthenticatedPluginApi } from "@dreamspan/shared/api.ts"
import { ExternalMedia, externalMediaRoute, makeExternalMediaHandlers } from "./api/externalMedia.ts"
import { AuthenticatedExternalMediaApi, AuthenticatedSavedMediaApi } from "@dreamspan/shared/api.ts"
import { makeSavedMediaHandlers, SavedMedia, savedMediaRoute } from "./api/savedMedia.ts"
import { operationWriter, installOperationRuntime } from "./agent/operations.ts"
import { installLibraryImport } from "./agent/libraryImport.ts"
import { makeWorkshopHandlers } from "./api/workshop.ts"
import { makeFilesQuotaHandlers } from "./api/filesQuota.ts"
import { makeFilesHandlers } from "./api/files.ts"
import {
  AuthenticatedAgentApi,
  AuthenticatedWorkshopApi,
  AuthenticatedFilesQuotaApi,
  AuthenticatedFilesApi,
  AuthenticatedChatEventsApi,
  AuthenticatedMessageVersionApi,
  AuthenticatedModelEditApi,
  AuthenticatedMoveApi,
  AuthenticatedStImportPlanApi,
  AuthenticatedChatMergeApi,
  AuthenticatedDecisionApi,
  AuthenticatedThinkingApi,
  AuthenticatedProviderListApi,
  AuthenticatedMcpApi,
  AuthenticatedSplitChatApi,
  AuthenticatedMessageSelectionApi,
  AuthenticatedChatContextsApi,
  AuthenticatedChatThreadsApi
} from "@dreamspan/shared/api.ts"
import { makeAgentHandlers } from "./api/agent.ts"
import { makeMergeHandlers } from "./api/merges.ts"
import { makeSplitChatHandlers } from "./api/splitChats.ts"
import { makeMessageSelectionHandlers } from "./api/messageSelection.ts"
import { makeChatContextsHandlers } from "./api/contexts.ts"
import { makeThreadHandlers } from "./api/threads.ts"
import { Commands } from "./commands.ts"
import { makeHistoryHandlers } from "./api/history.ts"
import { makeMessageHandlers, makeMoveHandlers } from "./api/messages.ts"
import { ExecutionRegistry } from "./execution.ts"
import { RefusalJudge } from "./decision/RefusalJudge.ts"
import { DecisionEngine } from "./decision/engine.ts"
import { makeDecisionHandlers } from "./api/decisions.ts"
import { makeThinkingHandlers } from "./api/thinking.ts"
import { SummaryChecks } from "./lcm/OutputChecks.ts"
import { Summarizer } from "./lcm/Summarizer.ts"
import { makeLcmHandlers, makeSummaryRequestHandlers } from "./api/lcm.ts"
// Composition of the HTTP server: the RPC endpoint over a WebSocket, login and logout,
// a health route, and the client build served as a single-page app.
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join, posix } from "node:path"
import type { Socket } from "node:net"
import type { Duplex } from "node:stream"
import { NodeHttpServer } from "@effect/platform-node"
import {
  AppCoreApi,
  AuthenticatedGalleryApi,
  AuthenticatedOwnTurnNoteApi,
  DatabaseStatusApi,
  AuthenticatedPanelApprovalApi,
  AuthenticatedPanelDataApi,
  AuthenticatedCardArchiveApi,
  AuthenticatedPersonaLockApi,
  AuthenticatedDraftChatApi,
  AuthenticatedTextSearchApi,
  AuthenticatedDraftPreviewApi,
  AuthenticatedCardSourcesApi,
  AuthenticatedSummaryRequestApi,
  AuthenticatedForkMergeApi,
  AuthenticatedWorkshopPresetApi,
  AuthenticatedShellUpdatesApi,
  CurrentUser,
  Health
} from "@dreamspan/shared/api.ts"
import { ByteSize, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  Headers,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer
} from "effect/http"
import { RpcSerialization, RpcServer, type RpcGroup } from "effect/rpc"
import { makeAccountHandlers } from "./api/accounts.ts"
import { makeLibraryHandlers } from "./api/library.ts"
import { makeChatEventHandlers, makeChatHandlers, makeMessageVersionHandlers } from "./api/chats.ts"
import { makeChatSetupHandlers, makeDraftPreviewHandlers } from "./api/chatSetup.ts"
import {
  makeEditorHandlers,
  makeOwnTurnNoteHandlers,
  makeWorkshopPresetHandlers,
  makeGalleryHandlers,
  makePanelApprovalHandlers,
  makeForkMergeHandlers,
  makeCardArchiveHandlers
} from "./api/editor.ts"
import { makePanelDataHandlers } from "./api/panelData.ts"
import { makeGenerationHandlers } from "./api/generation.ts"
import { makeBinHandlers } from "./api/bin.ts"
import { makeComposerHandlers } from "./api/composer.ts"
import { makeNoticeHandlers } from "./api/notices.ts"
import { makeInspectorHandlers } from "./api/inspector.ts"
import { Notices } from "./chat/Notices.ts"
import { makeModelEditHandlers, makeProviderHandlers, makeProviderListHandlers } from "./api/providers.ts"
import { makeStImportHandlers, makeStImportPlanHandlers } from "./api/stImport.ts"
import {
  imageRoute as SourceImageRoute,
  makeCardSourceHandlers,
  newerFileRoute as SourceNewerFileRoute
} from "./api/cardSources.ts"
import * as CardSources from "./sources/CardSources.ts"
import { Accounts, AuthenticationLive, PEER_HEADER, SESSION_COOKIE, SESSION_TTL_MS } from "./auth/Accounts.ts"
import { ImageTokenCounts } from "./chat/ImageTokenCounts.ts"
import { TextTokens } from "./providers/TextTokens.ts"
import { CacheWarmth } from "./chat/CacheWarmth.ts"
import { ChatHub } from "./chat/ChatHub.ts"
import { Generations } from "./chat/Generations.ts"
import * as ContextGenerator from "./chat/ContextGenerator.ts"
import { Generator } from "./chat/Generator.ts"
import { AppConfig } from "./config.ts"
import * as Database from "./db/Database.ts"
import { Forbidden, ServerError } from "@dreamspan/shared/errors.ts"
import { EventLoopMonitor } from "./eventLoop.ts"
import * as Formats from "./importer/Formats.ts"
import * as ImportRoutes from "./importer/routes.ts"
import { filesRoutes } from "./files/routes.ts"
import { FILES_ROUTES } from "@dreamspan/shared/files.ts"
import { MediaHolds } from "./importer/MediaHolds.ts"
import { StImportJobs } from "./importer/StImportJobs.ts"
import { StImportPlans } from "./importer/StImportPlans.ts"
import { StImports } from "./importer/StImports.ts"
import {
  crossSiteProblem,
  exposurePolicy,
  parsePublicOrigins,
  refusedResponse,
  TrustedAddresses,
  UnsafeExposure
} from "./net/exposure.ts"
import * as Network from "./net/Network.ts"
import * as ProviderBuiltins from "./providers/builtins.ts"
import * as Providers from "./providers/Providers.ts"
import * as Secrets from "./secrets.ts"
import { makeTextSearchHandlers } from "./api/textSearch.ts"
import { makeMcpHandlers } from "./api/mcp.ts"
import { makePersonaLockHandlers } from "./api/personaLock.ts"
import { makeDraftChatHandlers } from "./api/draftChats.ts"
import * as McpConnections from "./mcp/McpConnections.ts"

const VERSION = "0.0.0"
const startedAt = Date.now()

const CoreHandlers = AppCoreApi.toLayer(
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
    return AppCoreApi.of({
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
      ...(yield* makeMessageHandlers),
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

// Admins only: what the database writer found when it last started (Settings → Server status).
const DatabaseStatusHandlers = DatabaseStatusApi.toLayer(
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    return {
      GetDatabaseStartup: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          if (user.role !== "admin") return yield* new Forbidden({ message: "only an admin can see this" })
          return yield* writer.GetDatabaseStartup()
        }).pipe(
          Effect.catchTag("RpcClientError", () =>
            Effect.fail(new ServerError({ message: "Could not reach the database" }))
          )
        )
    }
  })
)

const HandlerLayers = Layer.mergeAll(
  CoreHandlers,
  DatabaseStatusHandlers,
  AuthenticatedOwnTurnNoteApi.toLayer(makeOwnTurnNoteHandlers),
  AuthenticatedWorkshopPresetApi.toLayer(makeWorkshopPresetHandlers),
  AuthenticatedMessageVersionApi.toLayer(makeMessageVersionHandlers),
  AuthenticatedMoveApi.toLayer(makeMoveHandlers),
  AuthenticatedModelEditApi.toLayer(makeModelEditHandlers),
  AuthenticatedStImportPlanApi.toLayer(makeStImportPlanHandlers),
  AuthenticatedShellUpdatesApi.toLayer(
    Effect.map(makeChatSetupHandlers, ({ WatchShellCards, WatchShellForks }) => ({
      WatchShellCards,
      WatchShellForks
    }))
  ),
  AuthenticatedSummaryRequestApi.toLayer(makeSummaryRequestHandlers),
  AuthenticatedSplitChatApi.toLayer(makeSplitChatHandlers),
  AuthenticatedMessageSelectionApi.toLayer(makeMessageSelectionHandlers),
  AuthenticatedChatContextsApi.toLayer(makeChatContextsHandlers),
  AuthenticatedChatThreadsApi.toLayer(makeThreadHandlers),
  AuthenticatedChatMergeApi.toLayer(makeMergeHandlers),
  AuthenticatedChatEventsApi.toLayer(makeChatEventHandlers),
  AuthenticatedAgentApi.toLayer(makeAgentHandlers),
  AuthenticatedWorkshopApi.toLayer(makeWorkshopHandlers),
  AuthenticatedFilesQuotaApi.toLayer(makeFilesQuotaHandlers),
  AuthenticatedFilesApi.toLayer(makeFilesHandlers),
  AuthenticatedPluginApi.toLayer(makePluginHandlers),
  AuthenticatedDecisionApi.toLayer(makeDecisionHandlers),
  AuthenticatedThinkingApi.toLayer(makeThinkingHandlers),
  AuthenticatedForkMergeApi.toLayer(makeForkMergeHandlers),
  AuthenticatedCardArchiveApi.toLayer(makeCardArchiveHandlers),
  AuthenticatedPersonaLockApi.toLayer(makePersonaLockHandlers),
  AuthenticatedDraftChatApi.toLayer(makeDraftChatHandlers),
  AuthenticatedCardSourcesApi.toLayer(makeCardSourceHandlers),
  AuthenticatedGalleryApi.toLayer(makeGalleryHandlers),
  AuthenticatedProviderListApi.toLayer(makeProviderListHandlers),
  AuthenticatedMcpApi.toLayer(makeMcpHandlers),
  AuthenticatedExternalMediaApi.toLayer(makeExternalMediaHandlers),
  AuthenticatedSavedMediaApi.toLayer(makeSavedMediaHandlers),

  AuthenticatedTextSearchApi.toLayer(makeTextSearchHandlers),
  AuthenticatedDraftPreviewApi.toLayer(makeDraftPreviewHandlers),
  AuthenticatedPanelApprovalApi.toLayer(makePanelApprovalHandlers),
  AuthenticatedPanelDataApi.toLayer(makePanelDataHandlers)
)

const Handlers = Layer.effectDiscard(
  Effect.gen(function* () {
    const execution = yield* ExecutionRegistry
    yield* installOperationRuntime(execution.operationRuntime, yield* Commands)
    yield* installLibraryImport(yield* Commands)
    yield* installCardSourceCommands(yield* Commands)
  })
).pipe(
  Layer.provideMerge(
    HandlerLayers.pipe(Layer.provide(Layer.effect(Database.Writer, Effect.map(Database.Writer, operationWriter))))
  )
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

const serverApi: RpcGroup.RpcGroup<TransportRpcs> = TransportApi
const RpcRoute = RpcServer.layerHttp({ group: serverApi, path: "/rpc", protocol: "websocket" }).pipe(
  Layer.provide([Handlers, AuthenticationLive, TransportHeadersOnly])
)

/** A host as a URL has it (name, IPv4 or bracketed IPv6, and a port), safe to put in a header. */
const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/

/**
 * The Content-Security-Policy on every response. Only the app's own scripts run: none
 * inline, none from elsewhere, so markup that slipped past sanitizing can't run script.
 * Images load from the app, local attachment blobs or `data:` URLs (a message's inline images,
 * which make no request), so text can't report on the chat through an image URL (the
 * message renderer blocks them as well). Connections go to the app and its WebSocket,
 * on the host the browser used; `'self'` covers the WebSocket in current browsers, the
 * explicit origins cover older ones. No form submits natively (every form of the app's handles
 * its submit), so none may: a form that slipped past sanitizing can't post to the app's routes.
 */
const contentSecurityPolicy = (host: string | undefined) => {
  const socket = host !== undefined && HOST.test(host) ? ` ws://${host} wss://${host}` : ""
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    "font-src 'self' blob: data:",
    `connect-src 'self'${socket}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; ")
}

/** The page a message's document block loads in its frame (spec/HTML-MESSAGES.md §3.3). */
const FRAME_PANEL = "/frame/panel"
/** Its one script, the client build's (packages/client/src/frame/bootstrap.ts). */
const FRAME_BOOTSTRAP = "/frame/bootstrap.js"
/** The vendored libraries a panel with scripts gets (the client build's `frame/lib/`). */
const FRAME_LIB = "/frame/lib/"

/**
 * Whether a request path is under `/frame/lib/` as the static server will read it: decoded once
 * and normalized, so `/frame/lib/..%2f..%2findex.html` is not.
 */
const underFrameLib = (path: string) => {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return false
  }
  return !decoded.includes("\0") && posix.normalize(decoded).startsWith(FRAME_LIB)
}

/** What a frame page may run: scripts once its source allowed them, the internet once allowed too. */
interface FrameMode {
  readonly scripts: boolean
  readonly network: boolean
}
const frameMode = (url: string): FrameMode => {
  const query = new URLSearchParams(url.split("?")[1] ?? "")
  const scripts = query.has("scripts")
  return { scripts, network: scripts && query.has("network") }
}

/**
 * The frame page's policy. Without scripts only the bootstrap runs, named by the page's nonce
 * (`nonce`; none, as on a refusal, runs nothing): the block's own scripts and handlers stay off,
 * and so does any other script of the app's, on any Host. With them (spec/HTML-MESSAGES.md §3.4)
 * the block's inline scripts, `eval` and the vendored libraries run too, and with the internet
 * allowed it may also load from and send to `https:` sites. A nonce would turn
 * `'unsafe-inline'` off, so the bootstrap and libraries are named by path: the frame is
 * sandboxed without allow-same-origin, so its origin is opaque and `'self'` can't name the
 * app, and the paths take the Host the browser used. A bracketed IPv6 Host can't be written in
 * a source expression, so there it's `'self'` (which matches the page's URL in current
 * browsers): the block runs any code it likes already, and what it loads from the app it can't
 * read (another origin's) nor send anywhere without the internet. A missing or malformed Host
 * gets the policy without scripts. Styles and `data:`/`blob:` images and fonts are the block's
 * own; it can never submit a form, change its base or be framed by another site. Whatever it
 * fetches from the app carries `Origin: null`, which RequestGuard refuses.
 */
const framePolicy = (
  host: string | undefined,
  mode: FrameMode = { scripts: false, network: false },
  nonce?: string
) => {
  const valid = host !== undefined && HOST.test(host)
  if (mode.scripts && !valid) return framePolicy(host, { scripts: false, network: false }, nonce)
  const ours = (path: string) => (host!.startsWith("[") ? "'self'" : `http://${host}${path} https://${host}${path}`)
  const web = mode.network ? " https:" : ""
  const lib = mode.scripts ? ` ${ours(FRAME_LIB)}` : ""
  const script = mode.scripts
    ? `'unsafe-inline' 'unsafe-eval' ${host!.startsWith("[") ? "'self'" : ours(FRAME_BOOTSTRAP) + lib}`
    : nonce === undefined
      ? "'none'"
      : `'nonce-${nonce}'`
  return [
    "default-src 'none'",
    `script-src ${script}${web}`,
    `style-src 'unsafe-inline'${lib}${web}`,
    `img-src data: blob:${lib}${web}`,
    `font-src data:${lib}${web}`,
    ...(mode.network ? ["media-src data: blob: https:"] : []),
    `connect-src ${mode.network ? "https:" : "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    // WebRTC's STUN and TURN aren't connect-src's; where a browser knows this, none (the
    // bootstrap takes WebRTC away where it doesn't).
    "webrtc 'block'",
    // A panel's HTML passes through the bootstrap's default policy (frames and hints out), and no
    // other policy can be made.
    ...(mode.scripts ? ["require-trusted-types-for 'script'", "trusted-types dreamspan default"] : []),
    // Opaque however the page is loaded (the app's frame is sandboxed the same way): opened as
    // a top-level page it would otherwise have the app's origin and this relaxed policy.
    "sandbox allow-scripts"
  ].join("; ")
}

/**
 * The frame page: nothing but the bootstrap, which writes the block's document when the app
 * posts it. Its policy (with the nonce) is set here; RequestGuard leaves it be.
 */
const FramePanelRoute = HttpRouter.add(
  "GET",
  FRAME_PANEL,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const nonce = randomBytes(18).toString("base64")
    return HttpServerResponse.text(
      `<!doctype html><html><head><meta charset="utf-8"><script nonce="${nonce}" src="${FRAME_BOOTSTRAP}"></script></head><body></body></html>`,
      {
        contentType: "text/html; charset=utf-8",
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-dns-prefetch-control": "off",
          "content-security-policy": framePolicy(request.headers.host, frameMode(request.url), nonce)
        }
      }
    )
  })
)

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
        const path = request.url.split("?")[0]!
        const policy =
          path === FRAME_PANEL
            ? framePolicy(request.headers.host, frameMode(request.url))
            : contentSecurityPolicy(request.headers.host)
        // A panel's fonts load from its opaque origin, as CORS requests with `Origin: null`: the
        // vendored libraries are public files, so only they answer it, to reads.
        const library =
          path.startsWith(FRAME_LIB) &&
          underFrameLib(path) &&
          (request.method === "GET" || request.method === "HEAD") &&
          request.headers.origin === "null"
        const csp = library
          ? (response: HttpServerResponse.HttpServerResponse) =>
              HttpServerResponse.setHeaders(response, {
                "content-security-policy": policy,
                "access-control-allow-origin": "*"
              })
          : (response: HttpServerResponse.HttpServerResponse) =>
              // The frame page sets its own, with its nonce.
              // A file's bytes (files/routes.ts) keep their sandboxed policy too.
              (path === FRAME_PANEL ||
                path === "/media/external" ||
                path.startsWith("/media/saved/") ||
                path === FILES_ROUTES.raw ||
                path === FILES_ROUTES.attachment) &&
              response.headers["content-security-policy"] !== undefined
                ? response
                : HttpServerResponse.setHeader(response, "content-security-policy", policy)
        const headers = { host: request.headers.host, origin: library ? undefined : request.headers.origin }
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

const HealthRoute = HttpRouter.add(
  "GET",
  "/healthz",
  Effect.gen(function* () {
    const config = yield* AppConfig
    const generator = yield* Generator
    const generatorKind = Option.isSome(generator) ? (generator.value.kind ?? "custom") : "none"
    const buildId = yield* Effect.promise(async () => {
      try {
        const stamp: unknown = JSON.parse(await readFile(join(config.clientDist, "build-id.json"), "utf8"))
        return typeof stamp === "object" && stamp !== null && "buildId" in stamp && typeof stamp.buildId === "string"
          ? stamp.buildId
          : undefined
      } catch {
        return undefined
      }
    })
    return HttpServerResponse.text("ok", {
      headers: {
        "cache-control": "no-store",
        "x-generator-kind": generatorKind,
        ...(buildId ? { "x-client-build": buildId } : {})
      }
    })
  })
)

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

/** The client build's content-hashed files: a new build gives them new names. */
const HASHED_ASSETS = "/assets/"

/**
 * Whether a request path names a hashed asset as the static server will read it: decoded once
 * and normalized, so `/assets/..%2findex.html` is not. Source maps reuse the bundle's hash.
 */
const hashedAsset = (path: string) => {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return false
  }
  const normalized = posix.normalize(decoded)
  return !decoded.includes("\0") && normalized.startsWith(HASHED_ASSETS) && !/\.(?:html?|map)$/i.test(normalized)
}

/**
 * The client build. Hashed assets are kept for a year; everything else (index.html, the SPA
 * fallback, source maps and unhashed files) is revalidated by its ETag on every load.
 */
const StaticRoutes = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter
        const pages = yield* HttpStaticServer.make({ root: config.clientDist, spa: true, cacheControl: "no-cache" })
        const assets = yield* HttpStaticServer.make({
          root: config.clientDist,
          index: undefined,
          cacheControl: "public, max-age=31536000, immutable"
        })
        yield* router.add(
          "GET",
          "/*",
          Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
            hashedAsset(request.url.split("?")[0]!) ? assets : pages
          ).pipe(Effect.catch(HttpServerRespondable.toResponse))
        )
      })
    )
  )
)

const DatabaseLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    Database.layer({
      dataDir: config.dataDir,
      readers: config.dbReaders,
      allowNetworkFs: config.dbAllowNetworkFs,
      workers: config.dbWorkers,
      shellPassPauseMs: config.shellPassPauseMs
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
    yield* McpConnections.interruptRunningCalls
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
    const policy = exposurePolicy(config, yield* TrustedAddresses, accounts.configured)
    if (typeof policy === "string") return yield* new UnsafeExposure({ message: policy })
    yield* Effect.logInfo(`Exposure: ${policy.summary()}`)
    const run = Effect.runForkWith(yield* Effect.context<never>())
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
          // Logged, so a proxy that moved shows up in the logs instead of as silent 403s.
          const warning = policy.refused(socket.remoteAddress)
          if (warning !== undefined) run(Effect.logWarning(warning))
          socket.write(refusedResponse(policy.refusal(socket.remoteAddress)))
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
  Effect.map(AppConfig, (config) =>
    Formats.layer({
      workers: config.dbWorkers,
      size: config.formatWorkers,
      thumbnailSize: config.thumbnailWorkers
    })
  )
)

/**
 * The whole server with this generator, minus configuration. Tests provide their own
 * AppConfig, with port 0, and read the port the kernel picked from the HttpServer this exposes.
 */
export const serverWith = <E>(
  generator: Layer.Layer<
    Generator,
    E,
    AppConfig | Database.Reader | Database.Writer | Providers.Providers | Summarizer | ChatHub
  >,
  summaries = Summarizer.layer,
  formats = FormatsLive,
  /** The decision engine: the development server may give every point another deadline (tests). */
  decisions = DecisionEngine.layer,
  /** The card sources (spec/CARD-SOURCES.md): the development server registers its fake source. */
  sources = CardSources.layer
) =>
  HttpRouter.serve(
    Layer.mergeAll(
      RpcRoute,
      HealthRoute,
      pluginRoutes,
      FramePanelRoute,
      AuthRoutes,
      ImportRoutes.layer,
      // The file manager (spec/FILES-AND-ENVIRONMENT.md §8.1).
      filesRoutes,
      SourceImageRoute,
      externalMediaRoute,
      savedMediaRoute,
      SourceNewerFileRoute,
      StaticRoutes,
      InterruptedRequests,
      RequestGuard
    )
  ).pipe(
    // --- ST data folder import (ARCHITECTURE.md §13)
    // Provided on, so a plugin can register folder handlers into it (PLUGINS §8).
    // Import jobs (StImportJobs) run the path imports in their own scope, past any request.
    Layer.provideMerge(StImportJobs.layer),
    // The re-import preview (StImportPlans): a dry run of the import over a folder, nothing written.
    Layer.provideMerge(StImportPlans.layer),
    Layer.provideMerge(StImports.layer),
    Layer.provide(
      // The estimate waits while a reply is written (CacheWarmth.hold).
      Generations.layer
        .pipe(
          Layer.provideMerge(
            CacheWarmth.layer.pipe(Layer.provideMerge(ImageTokenCounts.layer), Layer.provideMerge(TextTokens.layer))
          )
        )
        .pipe(
          Layer.provideMerge(generator),
          Layer.provideMerge(summaries),
          // The refusal judge registers itself with the summary checks the summarizer runs.
          Layer.provideMerge(RefusalJudge.layer.pipe(Layer.provideMerge(SummaryChecks.layer))),
          // Decision models (spec/AGENTIC.md §7): asked only for the points a user turned on.
          Layer.provideMerge(decisions),
          // Last, so the summarizer can tell open chats that their summaries changed.
          Layer.provideMerge(ChatHub.layer)
        )
    ),
    Layer.provideMerge(
      PluginHost.layer.pipe(
        // The workshop's file tools and commands (spec/FILES-AND-ENVIRONMENT.md §5).
        Layer.provideMerge(WorkshopFiles.layer),
        Layer.provideMerge(ExecutionRegistry.layer),
        Layer.provideMerge(Commands.layer),
        Layer.provideMerge(Notices.layer),
        Layer.provideMerge(decisions)
      )
    ),
    Layer.provideMerge(sources),
    Layer.provideMerge(ExternalMedia.layer),
    // Saved card media (spec/SAVED-MEDIA.md): its task downloads between writer transactions.
    Layer.provideMerge(SavedMedia.layer),
    // One set of held files for uploads, the ST folder import and adopting a source's cards.
    Layer.provideMerge(MediaHolds.layer),
    // MCP servers (spec/MCP.md): Check and, later, tool calls, over the same network.
    Layer.provideMerge(McpConnections.layer.pipe(Layer.provide(ProvidersLive))),
    Layer.provide(ProvidersLive),
    Layer.provideMerge(HttpServerLive),
    Layer.provideMerge(Accounts.layer),
    Layer.provideMerge(TrustedAddresses.layer),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, EventLoopMonitor.layer, formats)),
    Layer.provide(InFlightRpcs.layer)
  )

/**
 * The whole server, minus configuration, generating with the context assembler and the
 * provider layer (ARCHITECTURE §15). The fake generator is only in the development entry
 * point (dev/main.ts) and the tests.
 */
export const ServerLive = serverWith(ContextGenerator.layer)
