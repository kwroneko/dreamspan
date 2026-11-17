// MCP servers on the main thread (spec/MCP.md §2, §7, §10): the connections' secrets, the MCP
// client over the app's network, Check, and the ledger row of every request sent. Storage goes
// through the database workers; this module only encrypts, decrypts and talks to servers.
//
// Deltas from reference-harness's `McpClientPool` (src/mcp/client-pool.ts): servers are rows the user
// adds, not config; nothing connects at startup; a client is opened for one piece of work the
// user started (here, Check) and closed after; headers and keys are host-bound secrets resolved
// per request; every request is a ledger row; requests go through `Network` (proxy, bypass,
// same-origin redirects) via the SDK's `fetch` option.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  ErrorCode,
  type JSONRPCMessage,
  McpError,
  type MessageExtraInfo,
  ResultSchema
} from "@modelcontextprotocol/sdk/types.js"
import type { UserId } from "@rp/shared/domain.ts"
import type { NotFound, StaleWrite } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import {
  MCP_LISTING_BYTES_LIMIT,
  MCP_TIMEOUT_MAX_S,
  MCP_TIMEOUT_MIN_S,
  MCP_TOOLS_LIMIT,
  McpCheck,
  type McpConnection,
  type McpConnectionId,
  type McpConnectionSettings,
  McpRefused,
  type McpServerInfo,
  type McpTool,
  type RemoteMcpTransport
} from "@rp/shared/mcp.ts"
import { type CredentialId, originOf, type ProxyMode } from "@rp/shared/providers.ts"
import { Context, Effect, Exit, Layer, Option, type Scope } from "effect"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { McpResolved, StorageError } from "../db/ops.ts"
import type { RpcClientError } from "effect/rpc"
import { Network, type ProxyOverride, type RequestNetwork } from "../net/Network.ts"
import { describeRoute, proxyUrlProblem } from "../net/route.ts"
import { credentialBinding, requestSecrets } from "../providers/Providers.ts"
import { Secrets } from "../secrets.ts"
import { buildCatalog, serverInfoOf } from "./catalog.ts"

/** What the app says it is to every server (spec/MCP.md §2.1): no capabilities declared. */
const MCP_CLIENT_INFO = { name: "rp-harness", version: "0.0.0" }

const headersBinding = (connectionId: string) => `mcp:${connectionId}:headers`
const proxyBinding = (connectionId: string) => `mcp:${connectionId}:proxy_url`

/** Everything a request to a server needs, secrets decrypted. Lives for one piece of work. */
export interface McpPrepared {
  readonly connection: McpConnection
  readonly url: URL
  /** The custom headers, with the key as `Authorization: Bearer`. */
  readonly headers: Readonly<Record<string, string>>
  readonly network: RequestNetwork
  /** Removes this connection's secrets from text that will be stored or shown. */
  readonly scrub: (text: string) => string
}

/** A client connected to one server, with what it has sent and received so far. */
interface McpSession {
  readonly client: Client
  readonly counts: { sent: number; received: number }
  readonly protocolVersion: () => string
  readonly route: () => string | null
}

/** Where a request is for, in the ledger. */
export interface McpAttribution {
  readonly purpose: "story" | "workshop" | "check"
  readonly chatId: string | null
  readonly rolloutId: string | null
  readonly toolCallId: string | null
  readonly attempt: number
}

const CHECK: McpAttribution = { purpose: "check", chatId: null, rolloutId: null, toolCallId: null, attempt: 1 }

type StorageFailure = StorageError | RpcClientError.RpcClientError
type McpFailure = McpRefused | NotFound | StaleWrite | StorageFailure

export interface McpConnectionsShape {
  readonly create: (input: {
    readonly userId: UserId
    readonly settings: McpConnectionSettings
    readonly apiKey: string | null
    readonly credentialId: CredentialId | null
  }) => Effect.Effect<{ readonly connection: McpConnection; readonly check: McpCheck }, McpFailure>
  readonly update: (
    userId: UserId,
    connectionId: McpConnectionId,
    settings: McpConnectionSettings,
    expectedRowVersion: number
  ) => Effect.Effect<{ readonly connection: McpConnection; readonly check: McpCheck | null }, McpFailure>
  readonly setKey: (
    userId: UserId,
    connectionId: McpConnectionId,
    apiKey: string | null,
    expectedRowVersion: number
  ) => Effect.Effect<McpConnection, McpFailure>
  readonly setHeaders: (
    userId: UserId,
    connectionId: McpConnectionId,
    headers: Readonly<Record<string, string>> | null,
    expectedRowVersion: number
  ) => Effect.Effect<McpConnection, McpFailure>
  readonly setProxy: (
    userId: UserId,
    connectionId: McpConnectionId,
    mode: ProxyMode,
    url: string | null
  ) => Effect.Effect<McpConnection, McpFailure>
  /** Connects, lists the tools, stores them and closes. Sends nothing of the user's. */
  readonly check: (
    userId: UserId,
    connectionId: McpConnectionId
  ) => Effect.Effect<{ readonly connection: McpConnection; readonly check: McpCheck }, McpFailure>
  /** The decrypted secrets and network for one piece of work on a connection. */
  readonly prepare: (userId: UserId, connectionId: McpConnectionId) => Effect.Effect<McpPrepared, McpFailure>
  /**
   * Opens a client, recording `initialize` in the ledger, and closes it when the scope ends.
   * `transport` overrides the connection's (Check's probe of the other one).
   */
  readonly open: (
    userId: UserId,
    prepared: McpPrepared,
    attribution: McpAttribution,
    transport?: RemoteMcpTransport
  ) => Effect.Effect<McpSession, McpRequestFailed | NotFound | StorageFailure, Scope.Scope>
  /** One request on an open client, recorded in the ledger. */
  readonly request: <A>(
    userId: UserId,
    prepared: McpPrepared,
    session: McpSession,
    request: {
      readonly method: "tools/list" | "tools/call"
      readonly tool: string | null
      readonly attribution: McpAttribution
      readonly send: (signal: AbortSignal, timeoutMs: number) => Promise<A>
    }
  ) => Effect.Effect<A, McpRequestFailed | NotFound | StorageFailure>
}

export class McpConnections extends Context.Service<McpConnections, McpConnectionsShape>()("rp/McpConnections") {}

/** A request to a server that failed, with what the ledger and the user are told. */
export class McpRequestFailed extends Error {
  override readonly name = "McpRequestFailed"
  readonly status: "error" | "failed" | "timeout" | "cancelled"
  /** The server refused the key or headers: the other transport needn't be tried. */
  readonly auth: boolean
  constructor(status: McpRequestFailed["status"], message: string, auth: boolean) {
    super(message)
    this.status = status
    this.auth = auth
  }
}

/**
 * Counts what goes through a transport, and keeps the protocol version the client settles on.
 * The SDK's client sets the handlers on this wrapper; the wrapper passes the transport's on.
 */
class CountingTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
  protocolVersion = ""
  private readonly inner: Transport
  readonly counts: { sent: number; received: number }
  constructor(inner: Transport, counts: { sent: number; received: number }) {
    this.inner = inner
    this.counts = counts
    inner.onclose = () => this.onclose?.()
    inner.onerror = (error) => this.onerror?.(error)
    inner.onmessage = (message, extra) => {
      counts.received += Buffer.byteLength(JSON.stringify(message))
      this.onmessage?.(message, extra)
    }
  }
  get sessionId() {
    return this.inner.sessionId
  }
  start() {
    return this.inner.start()
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.counts.sent += Buffer.byteLength(JSON.stringify(message))
    return this.inner.send(message, options)
  }
  close() {
    return this.inner.close()
  }
  setProtocolVersion(version: string) {
    this.protocolVersion = version
    this.inner.setProtocolVersion?.(version)
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The status code an SDK transport error carries, if any. */
const httpCode = (error: unknown): number | undefined => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "number" && code >= 100 && code < 600 ? code : undefined
}

/** A failed request as the ledger records it and the user reads it, secrets scrubbed. */
const failureOf = (
  error: unknown,
  name: string,
  timeoutS: number,
  aborted: boolean,
  scrub: (text: string) => string
): McpRequestFailed => {
  if (aborted) return new McpRequestFailed("cancelled", "Stopped before the server answered.", false)
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
    return new McpRequestFailed("timeout", `${name} didn't answer within ${timeoutS} s.`, false)
  const code = httpCode(error)
  const text = scrub(messageOf(error))
  if (code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(text))
    return new McpRequestFailed("failed", `${name} refused the request (${code ?? "unauthorized"}): ${text}`, true)
  if (error instanceof McpError) return new McpRequestFailed("error", `${name} answered with an error: ${text}`, false)
  return new McpRequestFailed("failed", `Couldn't reach ${name}: ${text}`, false)
}

export const layer = Layer.effect(
  McpConnections,
  Effect.gen(function* () {
    const reader = yield* Reader
    const writer = yield* Writer
    const network = yield* Network
    const secrets = yield* Secrets
    const config = yield* AppConfig
    const bindKeysToOrigins = config.keyHostBinding
    const runFork = Effect.runForkWith(yield* Effect.context<never>())

    const refused = (message: string) => Effect.fail(new McpRefused({ message }))

    /** The settings as the user may save them, trimmed; refused with what to fix. */
    const checked = (settings: McpConnectionSettings) =>
      Effect.gen(function* () {
        const name = settings.name.trim()
        const url = settings.url.trim()
        if (name === "" || name.length > 100) return yield* refused("Give the server a name of at most 100 characters.")
        if (settings.about.length > 1000) return yield* refused("Keep what it's for under 1,000 characters.")
        const origin = originOf(url)
        if (origin === null || !/^https?:$/.test(new URL(url).protocol) || url.length > 2048)
          return yield* refused("Enter the server's full address, such as https://example.com/mcp.")
        if (
          !Number.isInteger(settings.timeoutS) ||
          settings.timeoutS < MCP_TIMEOUT_MIN_S ||
          settings.timeoutS > MCP_TIMEOUT_MAX_S
        )
          return yield* refused(`Choose a timeout from ${MCP_TIMEOUT_MIN_S} to ${MCP_TIMEOUT_MAX_S} seconds.`)
        return { ...settings, name, url, about: settings.about.trim() }
      })

    /** A key as typed: whitespace dropped, nothing left means none. */
    const typedKey = (apiKey: string | null) => {
      const key = apiKey?.trim() ?? ""
      return key === "" ? null : key
    }

    /** A typed key as a credential the connection owns, bound to its address's origin. */
    const newCredential = (name: string, key: string, url: string) => {
      const credentialId = uuidv7() as CredentialId
      return {
        credentialId,
        name,
        key: {
          enc: secrets.encrypt(key, credentialBinding(credentialId)),
          hint: key.length >= 12 ? key.slice(-4) : ""
        },
        origins: [originOf(url)!]
      }
    }

    const prepare: McpConnectionsShape["prepare"] = (userId, connectionId) =>
      Effect.gen(function* () {
        const resolved: typeof McpResolved.Type = yield* reader.ResolveMcpConnection({ userId, connectionId })
        const connection = resolved.connection
        if (connection.transport === "stdio" || connection.url === null)
          return yield* refused(`${connection.name} is a local program, which this server doesn't run.`)
        const url = new URL(connection.url)
        const origin = url.origin
        const inventory = requestSecrets()
        inventory.route(connection.url)
        const decrypt = (blob: Uint8Array | null, binding: string) =>
          blob === null
            ? Effect.succeed(null)
            : secrets.decrypt(blob, binding).pipe(
                Effect.map(inventory.add),
                Effect.mapError((error) => new McpRefused({ message: error.message }))
              )
        const credential = resolved.credential
        // The key is checked against its allowed origins before it's even decrypted.
        if (credential !== null && bindKeysToOrigins && !credential.origins.includes(origin))
          return yield* refused(
            `${connection.name}'s key isn't allowed for ${origin}; enter the key again to allow it.`
          )
        const apiKey = credential === null ? null : yield* decrypt(credential.keyEnc, credentialBinding(credential.id))
        if (resolved.headersEnc !== null && bindKeysToOrigins && connection.headersOrigin !== origin)
          return yield* refused(
            `${connection.name}'s headers were set for ${connection.headersOrigin ?? "another address"}; set them again for ${origin}.`
          )
        const headersJson = yield* decrypt(resolved.headersEnc, headersBinding(connectionId))
        const proxyUrl = yield* decrypt(resolved.proxyUrlEnc, proxyBinding(connectionId))
        // An admin may require the instance proxy for everyone else, as for provider connections.
        const forced = network.forced() && resolved.ownerRole !== "admin"
        if (forced && (yield* network.view).proxy === null)
          return yield* refused("The admin requires the instance proxy, but none is set.")
        const override: ProxyOverride = forced
          ? { mode: "inherit" }
          : connection.proxyMode === "custom" && proxyUrl !== null
            ? { mode: "custom", url: proxyUrl }
            : connection.proxyMode === "direct"
              ? { mode: "direct" }
              : { mode: "inherit" }
        const headers: Record<string, string> = {
          ...(headersJson === null ? {} : (JSON.parse(headersJson) as Record<string, string>)),
          ...(apiKey === null ? {} : { Authorization: `Bearer ${apiKey}` })
        }
        inventory.headers(headers)
        // Over http a connection's own proxy reads every byte, the key included.
        if (override.mode === "custom" && Object.keys(headers).length > 0 && url.protocol === "http:")
          return yield* refused(
            `${connection.name} sends its key over http, so its own proxy could read it; use https, or the instance proxy.`
          )
        return {
          connection,
          url,
          headers,
          network: network.prepare(override, inventory.add),
          scrub: inventory.scrub
        } satisfies McpPrepared
      })

    /** Runs one request with its ledger row: opened before anything is sent, closed once after. */
    const recorded = <A>(
      userId: UserId,
      prepared: McpPrepared,
      counts: { sent: number; received: number },
      row: { readonly method: "initialize" | "tools/list" | "tools/call"; readonly tool: string | null },
      attribution: McpAttribution,
      send: (signal: AbortSignal, timeoutMs: number) => Promise<A>
    ) =>
      Effect.gen(function* () {
        const connection = prepared.connection
        const id = uuidv7()
        yield* writer.OpenMcpCall({
          userId,
          call: {
            id,
            connectionId: connection.id,
            connectionRevision: connection.cacheRevision,
            method: row.method,
            tool: row.tool,
            purpose: attribution.purpose,
            chatId: attribution.chatId,
            rolloutId: attribution.rolloutId,
            toolCallId: attribution.toolCallId,
            attempt: attribution.attempt,
            startedAt: Date.now()
          }
        })
        const before = { ...counts }
        const timeoutMs = connection.timeoutS * 1000
        const close = (status: "complete" | McpRequestFailed["status"], error: string | null) =>
          writer
            .CloseMcpCall({
              userId,
              callId: id,
              status,
              endedAt: Date.now(),
              sentBytes: counts.sent - before.sent,
              receivedBytes: counts.received - before.received,
              error
            })
            .pipe(Effect.ignore)
        let aborted = false
        return yield* Effect.tryPromise({
          try: (signal) => {
            signal.addEventListener("abort", () => (aborted = true))
            return send(signal, timeoutMs)
          },
          catch: (error) => failureOf(error, connection.name, connection.timeoutS, aborted, prepared.scrub)
        }).pipe(
          // The SSE transport's start has no timeout of its own.
          Effect.timeoutOrElse({
            duration: timeoutMs + 1000,
            orElse: () =>
              Effect.fail(
                new McpRequestFailed(
                  "timeout",
                  `${connection.name} didn't answer within ${connection.timeoutS} s.`,
                  false
                )
              )
          }),
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return close("complete", null)
            const error = Option.getOrUndefined(Exit.findErrorOption(exit))
            return error instanceof McpRequestFailed
              ? close(error.status, error.message)
              : close("cancelled", "Stopped before the server answered.")
          })
        )
      })

    const open: McpConnectionsShape["open"] = (userId, prepared, attribution, which) =>
      Effect.gen(function* () {
        const connection = prepared.connection
        let route: string | null = null
        const fetch = prepared.network.fetchFor((next, target) => (route = describeRoute(next, target)))
        const options = { fetch, requestInit: { headers: { ...prepared.headers } } }
        const kind = which ?? (connection.transport === "sse" ? "sse" : "streamable-http")
        const counts = { sent: 0, received: 0 }
        const transport = new CountingTransport(
          kind === "sse"
            ? new SSEClientTransport(prepared.url, options)
            : new StreamableHTTPClientTransport(prepared.url, {
                ...options,
                // A dropped stream isn't reopened behind the app's back: the call reports it.
                reconnectionOptions: {
                  maxRetries: 0,
                  initialReconnectionDelay: 1000,
                  maxReconnectionDelay: 1000,
                  reconnectionDelayGrowFactor: 1
                }
              }),
          counts
        )
        const client = new Client(MCP_CLIENT_INFO, { capabilities: {} })
        // Sampling, roots and elicitation are never declared; a server asking anyway is refused.
        client.fallbackRequestHandler = async (request) => {
          runFork(
            Effect.logWarning(
              `MCP server "${connection.name}" asked for ${request.method}, which the app doesn't offer`
            )
          )
          throw new McpError(ErrorCode.MethodNotFound, `${request.method} isn't supported`)
        }
        yield* Effect.acquireRelease(
          recorded(userId, prepared, counts, { method: "initialize", tool: null }, attribution, (signal, timeout) =>
            client.connect(transport, { signal, timeout })
          ),
          // Closing aborts the client's streams; a server that never lets go doesn't hold the caller.
          () =>
            Effect.promise(() => client.close().catch(() => undefined)).pipe(Effect.timeout("5 seconds"), Effect.ignore)
        )
        return {
          client,
          counts,
          protocolVersion: () => transport.protocolVersion,
          route: () => route
        } satisfies McpSession
      })

    const request: McpConnectionsShape["request"] = (userId, prepared, session, { method, tool, attribution, send }) =>
      recorded(userId, prepared, session.counts, { method, tool }, attribution, send)

    /** `initialize` and every page of `tools/list`, up to the listing's bounds. */
    const list = (userId: UserId, prepared: McpPrepared, transport: RemoteMcpTransport) =>
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* open(userId, prepared, CHECK, transport)
          const tools: Array<unknown> = []
          let bytes = 0
          let truncated = false
          let cursor: string | undefined
          do {
            const page = yield* request(userId, prepared, session, {
              method: "tools/list",
              tool: null,
              attribution: CHECK,
              send: (signal, timeout) =>
                session.client.request(
                  { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
                  ResultSchema,
                  { signal, timeout }
                )
            })
            const listed = Array.isArray(page.tools) ? page.tools : []
            for (const tool of listed) {
              bytes += Buffer.byteLength(JSON.stringify(tool))
              if (tools.length >= MCP_TOOLS_LIMIT || bytes > MCP_LISTING_BYTES_LIMIT) {
                truncated = true
                break
              }
              tools.push(tool)
            }
            cursor = typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : undefined
          } while (cursor !== undefined && !truncated)
          const server = serverInfoOf(
            session.client.getServerVersion(),
            session.protocolVersion(),
            session.client.getServerCapabilities(),
            session.client.getInstructions(),
            truncated
          )
          return { server, tools, route: session.route() }
        })
      )

    const check: McpConnectionsShape["check"] = (userId, connectionId) =>
      Effect.gen(function* () {
        const before = yield* reader.GetMcpConnection({ userId, connectionId })
        const save = (outcome: { server: McpServerInfo; tools: Array<McpTool> } | { error: string }) =>
          writer.SaveMcpCatalog({
            userId,
            connectionId,
            expectedCacheRevision: before.cacheRevision,
            expectedCatalogRevision: before.catalogRevision,
            outcome,
            at: Date.now()
          })
        const prepared = yield* Effect.result(prepare(userId, connectionId))
        if (prepared._tag === "Failure") {
          if (prepared.failure._tag !== "McpRefused") return yield* Effect.fail(prepared.failure)
          const connection = yield* save({ error: prepared.failure.message })
          return {
            connection,
            check: new McpCheck({
              ok: false,
              detail: prepared.failure.message,
              toolCount: null,
              route: null,
              alternative: null
            })
          }
        }
        const transport = before.transport === "sse" ? "sse" : "streamable-http"
        const listed = yield* Effect.result(list(userId, prepared.success, transport))
        if (listed._tag === "Success") {
          const tools = buildCatalog(before.key, listed.success.tools, before.tools, before.catalogRevision + 1)
          const connection = yield* save({ server: listed.success.server, tools })
          const usable = tools.filter((tool) => tool.problem === null).length
          const name = listed.success.server.title ?? listed.success.server.name
          return {
            connection,
            check: new McpCheck({
              ok: true,
              detail: `Connected${name ? ` to ${name}` : ""}. ${tools.length} tool${tools.length === 1 ? "" : "s"} listed${usable < tools.length ? `, ${tools.length - usable} of them unusable` : ""}${listed.success.server.truncated ? " (the listing was cut short)" : ""}.`,
              toolCount: tools.length,
              route: listed.success.route,
              alternative: null
            })
          }
        }
        if (!(listed.failure instanceof McpRequestFailed)) return yield* Effect.fail(listed.failure)
        // The user picks the transport; when it fails, Check sees whether the other one answers.
        const other: RemoteMcpTransport = transport === "sse" ? "streamable-http" : "sse"
        const probe =
          listed.failure.auth || listed.failure.status === "timeout" || listed.failure.status === "cancelled"
            ? false
            : yield* Effect.scoped(open(userId, prepared.success, CHECK, other)).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false))
              )
        const connection = yield* save({ error: listed.failure.message })
        return {
          connection,
          check: new McpCheck({
            ok: false,
            detail: probe
              ? `${listed.failure.message} It answers the ${other === "sse" ? "older SSE" : "Streamable HTTP"} transport: switch to it.`
              : listed.failure.message,
            toolCount: null,
            route: null,
            alternative: probe ? other : null
          })
        }
      })

    const create: McpConnectionsShape["create"] = ({ userId, settings, apiKey, credentialId }) =>
      Effect.gen(function* () {
        const valid = yield* checked(settings)
        const key = typedKey(apiKey)
        const connectionId = uuidv7() as McpConnectionId
        yield* writer.CreateMcpConnection({
          userId,
          connectionId,
          settings: valid,
          credential: key === null ? { existing: credentialId } : { typed: newCredential(valid.name, key, valid.url) },
          at: Date.now()
        })
        // Saving a new server checks it once (spec/MCP.md §2.5).
        return yield* check(userId, connectionId)
      })

    const update: McpConnectionsShape["update"] = (userId, connectionId, settings, expectedRowVersion) =>
      Effect.gen(function* () {
        const valid = yield* checked(settings)
        const before = yield* reader.GetMcpConnection({ userId, connectionId })
        const connection = yield* writer.UpdateMcpConnection({
          userId,
          connectionId,
          settings: valid,
          expectedRowVersion,
          at: Date.now()
        })
        if (before.url === connection.url && before.transport === connection.transport)
          return { connection, check: null }
        return yield* check(userId, connectionId)
      })

    const setKey: McpConnectionsShape["setKey"] = (userId, connectionId, apiKey, expectedRowVersion) =>
      Effect.gen(function* () {
        const connection = yield* reader.GetMcpConnection({ userId, connectionId })
        const key = typedKey(apiKey)
        if (key !== null && connection.url === null)
          return yield* refused("This server has no address to send a key to.")
        return yield* writer.SetMcpKey({
          userId,
          connectionId,
          expectedRowVersion,
          credential: key === null ? null : newCredential(connection.name, key, connection.url!),
          at: Date.now()
        })
      })

    const setHeaders: McpConnectionsShape["setHeaders"] = (userId, connectionId, headers, expectedRowVersion) =>
      Effect.gen(function* () {
        const connection = yield* reader.GetMcpConnection({ userId, connectionId })
        const entries = Object.entries(headers ?? {}).map(([name, value]) => [name.trim(), value] as const)
        for (const [name] of entries)
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return yield* refused(`"${name}" isn't a valid header name.`)
        const origin = connection.url === null ? null : originOf(connection.url)
        if (entries.length > 0 && origin === null)
          return yield* refused("This server has no address to send headers to.")
        return yield* writer.SetMcpHeaders({
          userId,
          connectionId,
          expectedRowVersion,
          headers:
            entries.length === 0
              ? null
              : {
                  enc: secrets.encrypt(JSON.stringify(Object.fromEntries(entries)), headersBinding(connectionId)),
                  names: entries.map(([name]) => name),
                  origin: origin!
                },
          at: Date.now()
        })
      })

    const setProxy: McpConnectionsShape["setProxy"] = (userId, connectionId, mode, url) =>
      Effect.gen(function* () {
        if (mode !== "inherit" && network.forced()) {
          const resolved = yield* reader.ResolveMcpConnection({ userId, connectionId })
          if (resolved.ownerRole !== "admin")
            return yield* refused("The admin requires every connection to use the instance proxy.")
        }
        if (mode === "custom") {
          const problem = url === null ? "no proxy URL" : proxyUrlProblem(url)
          if (problem) return yield* refused(`Proxy: ${problem}.`)
        }
        return yield* writer.SetMcpProxy({
          userId,
          connectionId,
          mode,
          urlEnc: mode === "custom" && url !== null ? secrets.encrypt(url, proxyBinding(connectionId)) : null,
          at: Date.now()
        })
      })

    return McpConnections.of({ create, update, setKey, setHeaders, setProxy, check, prepare, open, request })
  })
)

/** Startup: requests a previous process left running stay as records, marked interrupted (spec/MCP.md §8.3). */
export const interruptRunningCalls = Effect.gen(function* () {
  const writer = yield* Writer
  const { interrupted } = yield* writer.InterruptRunningMcpCalls()
  if (interrupted > 0) yield* Effect.logWarning(`${interrupted} MCP requests were interrupted by the last shutdown`)
})
