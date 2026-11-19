// MCP servers on the main thread (spec/MCP.md §2, §7, §10): the connections' secrets, the MCP
// client over the app's network, Check, and the ledger row of every request sent. Storage goes
// through the database workers; this module only encrypts, decrypts and talks to servers.
//
// Deltas from reference-harness's `McpClientPool` (src/mcp/client-pool.ts): servers are rows the user
// adds, not config; nothing connects at startup; a call's client is kept per (connection, user),
// opened at the first call that needs it and closed after 5 idle minutes, on an edit of the
// connection (its `cache_revision`), when it stops being usable and at shutdown; a Check opens a
// client of its own and closes it after. A dead session reconnects once, shared by concurrent
// callers, as reference-harness's `reconnect`, but the call is sent again only when the HTTP status
// proves the server refused it unprocessed (§7.2), never on a message match. Headers and keys
// are host-bound secrets resolved per call; every request is a ledger row; requests go through
// `Network` (proxy, bypass, same-origin redirects) via the SDK's `fetch` option.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  CallToolResultSchema,
  ErrorCode,
  type JSONRPCMessage,
  McpError,
  type MessageExtraInfo,
  ResultSchema,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js"
import { createHash } from "node:crypto"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound, type StaleWrite } from "@dreamspan/shared/errors.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import {
  MCP_LISTING_BYTES_LIMIT,
  MCP_OAUTH_CALLBACK,
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
} from "@dreamspan/shared/mcp.ts"
import { type CredentialId, originOf, type ProxyMode } from "@dreamspan/shared/providers.ts"
import { Context, Effect, Exit, Layer, Option, Scope, Semaphore } from "effect"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { McpResolved, StorageError } from "../db/ops.ts"
import type { RpcClientError } from "effect/rpc"
import { parsePublicOrigins } from "../net/exposure.ts"
import { Network, type ProxyOverride, type RequestNetwork } from "../net/Network.ts"
import { describeRoute, proxyUrlProblem } from "../net/route.ts"
import { credentialBinding, requestSecrets } from "../providers/Providers.ts"
import { Secrets } from "../secrets.ts"
import { buildCatalog, serverInfoOf } from "./catalog.ts"
import {
  LOCAL_PROGRAMS_OFF,
  makeProgramStarter,
  PROGRAM_LIMITS,
  ProgramEnded,
  programEnvProblem,
  ProgramTransport
} from "./stdio.ts"
import {
  briefSignInError,
  finishSignIn as finishFlow,
  makeClientRegistry,
  type PendingSignIn,
  REFRESH_AHEAD_MS,
  refreshSignIn,
  SIGN_IN_PENDING_MAX,
  SIGN_IN_PENDING_MS,
  SIGN_IN_PENDING_PER_USER,
  signInTargets,
  startSignIn as startFlow,
  type StoredSignIn
} from "./oauth.ts"

/** What the app says it is to every server (spec/MCP.md §2.1): no capabilities declared. */
const MCP_CLIENT_INFO = { name: "dreamspan", version: "0.0.0" }

const headersBinding = (connectionId: string) => `mcp:${connectionId}:headers`
const proxyBinding = (connectionId: string) => `mcp:${connectionId}:proxy_url`
/** A user's own sign-in with a connection (spec/MCP.md §2.4). */
const oauthBinding = (connectionId: string, userId: string) => `mcp:${connectionId}:${userId}:oauth`
const envBinding = (connectionId: string) => `mcp:${connectionId}:env`

/** Everything a request to a server needs, secrets decrypted. Lives for one piece of work. */
export interface McpPrepared {
  readonly connection: McpConnection
  /** A remote server's address; null for a local program. */
  readonly url: URL | null
  /** A local program: its argument list and its own variables, decrypted; null for a remote server. */
  readonly program: { readonly argv: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> } | null
  /** The custom headers, with the key as `Authorization: Bearer`. */
  readonly headers: Readonly<Record<string, string>>
  readonly network: RequestNetwork
  /** Removes this connection's secrets from text that will be stored or shown. */
  readonly scrub: (text: string) => string
  /** Which sign-in the headers carry ("" for none): a kept client opened with another is replaced. */
  readonly signIn: string
}

/** A client connected to one server, with what it has sent and received so far. */
interface McpSession {
  /** A local program's transport, which knows when it ended; null for a remote server. */
  readonly program: ProgramTransport | null
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
  /** `MCP_LOCAL_PROGRAMS=on`: local programs may run here. */
  readonly localPrograms: boolean
  /** Whether a user with this role may add local programs here, and if not, why. */
  readonly localProgramsFor: (
    role: "admin" | "user"
  ) => Effect.Effect<{ readonly allowed: boolean; readonly reason: string | null }>
  /** A local program's environment (admins: the RPC checks); its kept clients close. */
  readonly setEnvironment: (
    userId: UserId,
    connectionId: McpConnectionId,
    env: Readonly<Record<string, string>> | null,
    expectedRowVersion: number
  ) => Effect.Effect<McpConnection, McpFailure>
  /** The caller's own process of a local program: whether it runs, and its last stderr. */
  readonly programOutput: (
    userId: UserId,
    connectionId: McpConnectionId
  ) => Effect.Effect<{ readonly running: boolean; readonly output: string }, NotFound | StorageFailure>
  /**
   * One `tools/call` (spec/MCP.md §7): a client opened for it (its `initialize` in the ledger),
   * the call recorded before it's sent, and closed after. Stop (interrupting the effect) and the
   * connection's timeout send `notifications/cancelled`; progress resets the timeout, up to 30
   * minutes in all. Says whether the call itself was sent, so a failure before it changes nothing.
   */
  readonly call: (input: {
    readonly userId: UserId
    readonly connectionId: McpConnectionId
    readonly tool: string
    readonly args: unknown
    readonly attribution: McpAttribution
    /** The server's progress notifications for this call, as they come (spec/MCP.md §7.3). */
    readonly onProgress?: (progress: McpProgress) => void
  }) => Effect.Effect<McpCallOutcome, StorageFailure>
  /** Closes every kept client of a connection (an edit, a delete), whoever's. */
  readonly closeKept: (connectionId: McpConnectionId) => Effect.Effect<void>
  /** How many kept clients are open now, for tests. */
  readonly kept: () => number
  /** What is held in memory between requests, for tests: each is bounded. */
  readonly retained: () => {
    readonly pendingSignIns: number
    readonly locks: number
    readonly outputs: number
    readonly registrations: number
  }
  /**
   * Starts the user's sign-in with the server (spec/MCP.md §2.4): the page the browser opens,
   * which sends it back to `appOrigin` + MCP_OAUTH_CALLBACK.
   */
  readonly startSignIn: (
    userId: UserId,
    connectionId: McpConnectionId,
    appOrigin: string
  ) => Effect.Effect<{ readonly authorizationUrl: string }, McpFailure>
  /** The browser came back from the sign-in page: the code becomes the user's own tokens. */
  readonly finishSignIn: (
    userId: UserId,
    state: string,
    code: string | null,
    error: string | null
  ) => Effect.Effect<{ readonly connectionId: McpConnectionId; readonly name: string }, McpFailure>
  /** Forgets the user's sign-in; their kept client closes. */
  readonly signOut: (
    userId: UserId,
    connectionId: McpConnectionId
  ) => Effect.Effect<McpConnection, NotFound | StaleWrite | StorageFailure>
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

/** How one `tools/call` went. `sent`: the request left the app, so it may have happened. */
type McpCallOutcome =
  | { readonly _tag: "Result"; readonly result: unknown; readonly scrub: (text: string) => string }
  | {
      readonly _tag: "Failed"
      readonly sent: boolean
      readonly status: McpRequestFailed["status"] | "refused"
      readonly message: string
    }

/** A server's progress notification for a call. */
export interface McpProgress {
  readonly progress: number
  readonly total?: number | undefined
  readonly message?: string | undefined
}

/** A kept client (spec/MCP.md §7.1) and who is using it. */
interface Pooled {
  readonly connectionId: string
  readonly userId: string
  /** The connection's `cache_revision` it was opened at. */
  readonly revision: number
  /** The sign-in its headers carry (McpPrepared.signIn). */
  readonly signIn: string
  readonly scope: Scope.Closeable
  readonly session: McpSession
  /** Calls running on it now. */
  users: number
  timer: ReturnType<typeof setTimeout> | null
  /** Closed by the server or the network, or its session is in doubt. */
  dead: boolean
  /** Out of the pool; closes once its last call ends. */
  retired: boolean
}

/** A kept client closes after `idleMs` unused (spec/MCP.md §7.1: 5 minutes); tests shorten it. */
export const mcpClientTiming = { idleMs: 5 * 60 * 1000 }

/** A call may report progress for this long in all (spec/MCP.md §7.3). */
const MCP_CALL_MAX_MS = 30 * 60 * 1000

export class McpConnections extends Context.Service<McpConnections, McpConnectionsShape>()("rp/McpConnections") {}

/** A request to a server that failed, with what the ledger and the user are told. */
export class McpRequestFailed extends Error {
  override readonly name = "McpRequestFailed"
  /** `interrupted`: a local program ended while the request waited on it. */
  readonly status: "error" | "failed" | "timeout" | "cancelled" | "interrupted"
  /** The server refused the key or headers: the other transport needn't be tried. */
  readonly auth: boolean
  /**
   * The server answered this very request with a status that proves it didn't process it: it
   * lost the session (spec/MCP.md §7.2). Only then may a call be sent again.
   */
  readonly deadSession: boolean
  constructor(status: McpRequestFailed["status"], message: string, auth: boolean, deadSession = false) {
    super(message)
    this.status = status
    this.auth = auth
    this.deadSession = deadSession
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
  private readonly pending = new Set<Promise<void>>()
  send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.counts.sent += Buffer.byteLength(JSON.stringify(message))
    const sending = this.inner.send(message, options)
    const tracked = sending.catch(() => undefined).finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
    return sending
  }
  /** What is still being sent (a cancellation, say) has gone, or failed. */
  drain() {
    return Promise.all([...this.pending]).then(() => undefined)
  }
  close() {
    return this.inner.close()
  }
  setProtocolVersion(version: string) {
    this.protocolVersion = version
    this.inner.setProtocolVersion?.(version)
  }
}

const keyOf = (connectionId: string, userId: string) => `${connectionId}\u0000${userId}`

/** Locks by key, each gone once nothing holds or waits for it, so they don't pile up. */
const keyedLocks = () => {
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>()
  const withLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      let entry = locks.get(key)
      if (!entry) locks.set(key, (entry = { lock: Semaphore.makeUnsafe(1), users: 0 }))
      const held = entry
      held.users += 1
      return held.lock.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            held.users -= 1
            if (held.users === 0 && locks.get(key) === held) locks.delete(key)
          })
        )
      )
    })
  return { withLock, size: () => locks.size }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The status code an SDK transport error carries, if any. */
const httpCode = (error: unknown): number | undefined => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "number" && code >= 100 && code < 600 ? code : undefined
}

/**
 * The server answered the request itself with "I don't know this session": a 404 on the
 * session, or a 400 saying it isn't initialized (spec/MCP.md §7.2). Both are HTTP statuses on
 * the response to the request's own POST, so the server refused it before processing it. A
 * transport error, a timeout or an error message alone never counts.
 */
const isDeadSession = (error: unknown) =>
  error instanceof StreamableHTTPError &&
  (error.code === 404 || (error.code === 400 && /not initiali[sz]ed|session/i.test(error.message)))

/** A failed request as the ledger records it and the user reads it, secrets scrubbed. */
const failureOf = (
  error: unknown,
  name: string,
  timeoutS: number,
  aborted: boolean,
  scrub: (text: string) => string,
  program: ProgramTransport | null
): McpRequestFailed => {
  if (aborted) return new McpRequestFailed("cancelled", "Stopped before the server answered.", false)
  // A local program that ended under a request: it may have done it before it stopped.
  if (program !== null && (program.ended !== null || error instanceof ProgramEnded))
    return new McpRequestFailed(
      "interrupted",
      `${name} stopped while it ran: ${(program.ended ?? (error as Error)).message}.`,
      false
    )
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
    return new McpRequestFailed("timeout", `${name} didn't answer within ${timeoutS} s.`, false)
  const code = httpCode(error)
  const text = scrub(messageOf(error))
  if (code === 401)
    return new McpRequestFailed(
      "failed",
      `${name} asks you to sign in (401). Sign in with the server, or give it a key.`,
      true
    )
  if (code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(text))
    return new McpRequestFailed("failed", `${name} refused the request (${code ?? "unauthorized"}): ${text}`, true)
  if (error instanceof McpError) return new McpRequestFailed("error", `${name} answered with an error: ${text}`, false)
  if (isDeadSession(error))
    return new McpRequestFailed("failed", `${name} had lost the app's session (${code}).`, false, true)
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
        if (
          !Number.isInteger(settings.timeoutS) ||
          settings.timeoutS < MCP_TIMEOUT_MIN_S ||
          settings.timeoutS > MCP_TIMEOUT_MAX_S
        )
          return yield* refused(`Choose a timeout from ${MCP_TIMEOUT_MIN_S} to ${MCP_TIMEOUT_MAX_S} seconds.`)
        if (settings.transport === "stdio") {
          const command = settings.program?.command.trim() ?? ""
          const args = settings.program?.args ?? []
          if (command === "" || command.length > PROGRAM_LIMITS.command || command.includes("\0"))
            return yield* refused("Enter the program to run, such as npx.")
          if (
            args.length > PROGRAM_LIMITS.arguments ||
            args.some((arg) => arg.length > PROGRAM_LIMITS.argument || arg.includes("\0"))
          )
            return yield* refused(
              `Give at most ${PROGRAM_LIMITS.arguments} arguments of at most ${PROGRAM_LIMITS.argument.toLocaleString("en")} characters.`
            )
          return { ...settings, name, url: "", program: { command, args: [...args] }, about: settings.about.trim() }
        }
        const origin = originOf(url)
        if (origin === null || !/^https?:$/.test(new URL(url).protocol) || url.length > 2048)
          return yield* refused("Enter the server's full address, such as https://example.com/mcp.")
        if (
          !Number.isInteger(settings.timeoutS) ||
          settings.timeoutS < MCP_TIMEOUT_MIN_S ||
          settings.timeoutS > MCP_TIMEOUT_MAX_S
        )
          return yield* refused(`Choose a timeout from ${MCP_TIMEOUT_MIN_S} to ${MCP_TIMEOUT_MAX_S} seconds.`)
        const { program: _program, ...remote } = settings
        return { ...remote, name, url, about: settings.about.trim() }
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

    /** Every request of a sign-in step counted, and stopped with the ledger row's signal. */
    const signInFetch =
      (fetchFn: typeof fetch, counts: { sent: number; received: number }, signal: AbortSignal) =>
      async (url: string | URL, init?: RequestInit) => {
        const body = init?.body
        counts.sent +=
          typeof body === "string"
            ? Buffer.byteLength(body)
            : body instanceof URLSearchParams
              ? Buffer.byteLength(body.toString())
              : 0
        const response = await fetchFn(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal
        })
        const length = Number(response.headers.get("content-length"))
        if (Number.isFinite(length)) counts.received += length
        return response
      }

    /**
     * One sign-in step (discovery, registration, the code exchange or a refresh) as a ledger row.
     * Its requests go through the connection's network, to the server's own origin or to public
     * addresses only unless the user typed the server as local (`signInTargets`), each pinned to
     * the addresses checked, and its failure never repeats what a service answered.
     */
    const signInStep = <A>(
      userId: UserId,
      target: Pick<McpPrepared, "connection" | "scrub">,
      network: RequestNetwork,
      server: URL,
      step: (fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>) => Promise<A>
    ) => {
      const counts = { sent: 0, received: 0 }
      return recorded(userId, target, counts, { method: "oauth", tool: null }, CHECK, (signal) =>
        step(
          signInFetch(
            network.fetchFor(undefined, signInTargets(server, { bypassed: network.bypassed })),
            counts,
            signal
          )
        ).catch((error: unknown) => {
          throw Object.assign(new Error(briefSignInError(target.scrub(messageOf(error)))), {
            code: httpCode(error)
          })
        })
      ).pipe(
        Effect.mapError((failure) =>
          failure instanceof McpRequestFailed
            ? new McpRefused({
                message:
                  failure.status === "timeout"
                    ? failure.message
                    : `Signing in with ${target.connection.name} didn't work: ${failure.message.replace(/^Couldn't reach [^:]*: /, "")}`
              })
            : failure
        )
      )
    }

    /** A stored sign-in, decrypted, or null when it can't be read (the user signs in again). */
    const readSignIn = (connectionId: string, userId: string, blob: Uint8Array) =>
      secrets.decrypt(blob, oauthBinding(connectionId, userId)).pipe(
        Effect.map((json) => JSON.parse(json) as StoredSignIn),
        Effect.orElseSucceed(() => null)
      )

    const signInLocks = keyedLocks()

    /**
     * The user's sign-in, its access token refreshed first when it has expired or is about to
     * (spec/MCP.md §2.4: in the call path, before the request, once). One refresh at a time per
     * (connection, user): a caller that waited uses what the first stored.
     */
    const currentSignIn = (
      userId: UserId,
      connection: McpConnection,
      url: URL,
      network: RequestNetwork,
      scrub: (text: string) => string,
      blob: Uint8Array
    ) =>
      Effect.gen(function* () {
        const again = () => refused(`Sign in to ${connection.name} again.`)
        const moved = () => refused(`Sign in to ${connection.name} again: its address changed since you signed in.`)
        if (connection.use.signIn?.origin !== url.origin) return yield* moved()
        const fresh = (stored: StoredSignIn) =>
          stored.expiresAt === null || stored.expiresAt - REFRESH_AHEAD_MS > Date.now()
        const stored = yield* readSignIn(connection.id, userId, blob)
        if (stored === null) return yield* again()
        // Tokens go only to the address they were issued for.
        if (stored.serverUrl !== url.href) return yield* moved()
        if (fresh(stored)) return stored
        return yield* signInLocks.withLock(
          keyOf(connection.id, userId),
          Effect.gen(function* () {
            // Another call may have refreshed it while this one waited.
            const latest = yield* reader.ResolveMcpConnection({ userId, connectionId: connection.id })
            if (latest.oauthEnc === null) return yield* again()
            const current = yield* readSignIn(connection.id, userId, latest.oauthEnc)
            if (current === null) return yield* again()
            if (current.serverUrl !== url.href) return yield* moved()
            if (fresh(current)) return current
            const refreshed = yield* signInStep(userId, { connection, scrub }, network, url, (fetchFn) =>
              refreshSignIn(fetchFn, url, current, Date.now())
            )
            if (refreshed === null) return yield* again()
            yield* writer
              .SetMcpOAuth({
                userId,
                connectionId: connection.id,
                oauth: {
                  enc: secrets.encrypt(JSON.stringify(refreshed), oauthBinding(connection.id, userId)),
                  origin: url.origin,
                  expiresAt: refreshed.expiresAt
                },
                expectedEnc: latest.oauthEnc,
                at: Date.now()
              })
              .pipe(Effect.catchTag("StaleWrite", () => again()))
            return refreshed
          })
        )
      })

    const prepareWith = (userId: UserId, connectionId: McpConnectionId, withSignIn: boolean) =>
      Effect.gen(function* () {
        const resolved: typeof McpResolved.Type = yield* reader.ResolveMcpConnection({ userId, connectionId })
        const connection = resolved.connection
        if (connection.transport === "stdio" || connection.url === null) return yield* prepareProgram(resolved)
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
        const requestNetwork = network.prepare(override, inventory.add)
        // The user's own sign-in, when they have one, is sent in place of the connection's key.
        const signIn =
          withSignIn && resolved.oauthEnc !== null
            ? yield* currentSignIn(userId, connection, url, requestNetwork, inventory.scrub, resolved.oauthEnc)
            : null
        if (signIn !== null) {
          inventory.add(signIn.tokens.access_token)
          if (signIn.tokens.refresh_token) inventory.add(signIn.tokens.refresh_token)
        }
        const headers: Record<string, string> = {
          ...(headersJson === null ? {} : (JSON.parse(headersJson) as Record<string, string>)),
          ...(signIn !== null
            ? { Authorization: `Bearer ${signIn.tokens.access_token}` }
            : apiKey === null
              ? {}
              : { Authorization: `Bearer ${apiKey}` })
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
          program: null,
          headers,
          network: requestNetwork,
          scrub: inventory.scrub,
          signIn:
            signIn === null ? "" : createHash("sha256").update(signIn.tokens.access_token).digest("hex").slice(0, 16)
        } satisfies McpPrepared
      })

    const prepare: McpConnectionsShape["prepare"] = (userId, connectionId) => prepareWith(userId, connectionId, true)

    // Local programs (spec/MCP.md §2.2): run in the command sandbox, only where the instance
    // allows them and only while their owner is an admin.
    const programs = makeProgramStarter({ dataDir: config.dataDir, sandboxId: config.commandSandbox })
    const localProgramsFor: McpConnectionsShape["localProgramsFor"] = (role) =>
      Effect.promise(async () => {
        if (!config.mcpLocalPrograms) return { allowed: false, reason: LOCAL_PROGRAMS_OFF }
        if (role !== "admin") return { allowed: false, reason: "Only an admin can add a local program." }
        const reason = await programs.unavailable()
        return { allowed: reason === null, reason }
      })
    const prepareProgram = (resolved: typeof McpResolved.Type) =>
      Effect.gen(function* () {
        const connection = resolved.connection
        if (!config.mcpLocalPrograms) return yield* refused(LOCAL_PROGRAMS_OFF)
        if (resolved.ownerRole !== "admin")
          return yield* refused(`${connection.name} is a local program, which only an admin's server runs.`)
        if (connection.program === null || connection.program.command === "")
          return yield* refused(`${connection.name} has no program to run.`)
        const inventory = requestSecrets()
        const envJson =
          resolved.envEnc === null
            ? null
            : yield* secrets
                .decrypt(resolved.envEnc, envBinding(connection.id))
                .pipe(Effect.mapError((error) => new McpRefused({ message: error.message })))
        const env = envJson === null ? {} : (JSON.parse(envJson) as Record<string, string>)
        for (const value of Object.values(env)) inventory.add(value)
        return {
          connection,
          url: null,
          program: { argv: [connection.program.command, ...connection.program.args], env },
          headers: {},
          // Unused: the program reaches the internet through the sandbox's own proxy.
          network: network.prepare({ mode: "inherit" }, inventory.add),
          scrub: inventory.scrub,
          signIn: ""
        } satisfies McpPrepared
      })

    /** Runs one request with its ledger row: opened before anything is sent, closed once after. */
    const recorded = <A>(
      userId: UserId,
      prepared: Pick<McpPrepared, "connection" | "scrub">,
      counts: { sent: number; received: number },
      row: { readonly method: "initialize" | "tools/list" | "tools/call" | "oauth"; readonly tool: string | null },
      attribution: McpAttribution,
      send: (signal: AbortSignal, timeoutMs: number) => Promise<A>,
      /** The longest the request may take in all (a call reporting progress); else the timeout. */
      totalMs?: number,
      /** A local program's transport, to tell a request it ended under. */
      program: ProgramTransport | null = null
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
          catch: (error) => failureOf(error, connection.name, connection.timeoutS, aborted, prepared.scrub, program)
        }).pipe(
          // The SSE transport's start has no timeout of its own.
          Effect.timeoutOrElse({
            duration: (totalMs ?? timeoutMs) + 1000,
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
        const local = prepared.program
        const startProgram = (local: NonNullable<McpPrepared["program"]>) => {
          // What it writes to stderr is shown without the owner's variables' values.
          const output = programs.outputOf(connection.id, userId)
          output.keepSecrets(Object.values(local.env))
          return new ProgramTransport(
            () => programs.start({ connectionId: connection.id, userId, argv: local.argv, env: local.env }),
            output
          )
        }
        const program = local === null ? null : startProgram(local)
        const url = prepared.url
        if (program === null && url === null) return yield* Effect.die(new Error("no address"))
        const transport = new CountingTransport(
          program !== null
            ? program
            : kind === "sse"
              ? new SSEClientTransport(url!, options)
              : new StreamableHTTPClientTransport(url!, {
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
          recorded(
            userId,
            prepared,
            counts,
            { method: "initialize", tool: null },
            attribution,
            (signal, timeout) => client.connect(transport, { signal, timeout }),
            undefined,
            program
          ),
          // A cancellation being sent goes first. Closing aborts the client's streams; a server that
          // never lets go doesn't hold the caller.
          () =>
            Effect.promise(() =>
              Promise.race([transport.drain(), new Promise((resolve) => setTimeout(resolve, 2000))]).then(() =>
                client.close().catch(() => undefined)
              )
            ).pipe(Effect.timeout("5 seconds"), Effect.ignore)
        )
        return {
          program,
          client,
          counts,
          protocolVersion: () => transport.protocolVersion,
          route: () => route
        } satisfies McpSession
      })

    const request: McpConnectionsShape["request"] = (userId, prepared, session, { method, tool, attribution, send }) =>
      recorded(userId, prepared, session.counts, { method, tool }, attribution, send, undefined, session.program)

    // The kept clients (spec/MCP.md §7.1): one per (connection, user), opened by the first call
    // that needs one and closed after 5 idle minutes, when the connection's `cache_revision`
    // moves on (an edit of where or how calls are sent), when it stops being usable and at
    // shutdown. Opening and reconnecting a key take its lock, so concurrent callers share one.
    const pool = new Map<string, Pooled>()
    const locks = keyedLocks()

    /** Closes a kept client once nothing uses it; a call still running on it keeps it open. */
    const retire = (key: string, entry: Pooled) =>
      Effect.suspend(() => {
        if (pool.get(key) === entry) pool.delete(key)
        if (entry.timer !== null) clearTimeout(entry.timer)
        entry.timer = null
        entry.retired = true
        return entry.users > 0 ? Effect.void : Scope.close(entry.scope, Exit.void)
      })

    const idleLater = (key: string, entry: Pooled) => {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => runFork(retire(key, entry)), mcpClientTiming.idleMs)
      entry.timer.unref?.()
    }

    /** Stops using a kept client: idle from now, or closed if it was retired while in use. */
    const release = (key: string, entry: Pooled) =>
      Effect.suspend(() => {
        entry.users -= 1
        if (entry.users > 0) return Effect.void
        if (entry.retired || entry.dead) return retire(key, entry)
        idleLater(key, entry)
        return Effect.void
      })

    const closeKept: McpConnectionsShape["closeKept"] = (connectionId) =>
      Effect.forEach(
        [...pool].filter(([, entry]) => entry.connectionId === connectionId),
        ([key, entry]) => retire(key, entry),
        { discard: true }
      )

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...pool], ([key, entry]) => Effect.ignore(retire(key, entry)), { discard: true })
    )

    /**
     * The user's kept client for the connection, opened (its `initialize` in the ledger) when there
     * is none, it died, or the connection changed since. `stale`: the client a dead session was
     * found on; it's replaced unless another caller replaced it already (one reconnect for all).
     */
    const acquire = (userId: UserId, prepared: McpPrepared, attribution: McpAttribution, stale?: Pooled) => {
      const key = keyOf(prepared.connection.id, userId)
      return locks.withLock(
        key,
        Effect.gen(function* () {
          const kept = pool.get(key)
          if (
            kept !== undefined &&
            kept !== stale &&
            !kept.dead &&
            kept.revision === prepared.connection.cacheRevision &&
            kept.signIn === prepared.signIn
          ) {
            kept.users += 1
            if (kept.timer !== null) clearTimeout(kept.timer)
            kept.timer = null
            return { key, entry: kept }
          }
          if (kept !== undefined) yield* retire(key, kept)
          const scope = yield* Scope.make()
          const session = yield* open(userId, prepared, attribution).pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void))
          )
          const entry: Pooled = {
            connectionId: prepared.connection.id,
            userId,
            revision: prepared.connection.cacheRevision,
            signIn: prepared.signIn,
            scope,
            session,
            users: 1,
            timer: null,
            dead: false,
            retired: false
          }
          // The server or the network closed it: the next call opens another.
          session.client.onclose = () => {
            entry.dead = true
          }
          // A connected server says its tools changed: list them again at once (spec/MCP.md §4.1).
          // Only the owner's session stores what everyone sharing the server sees.
          session.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            if (prepared.connection.owned) runFork(relist(userId, prepared, key, entry))
          })
          pool.set(key, entry)
          return { key, entry }
        })
      )
    }

    const unavailable = (failure: McpRefused | NotFound | StaleWrite) =>
      ({
        _tag: "Failed",
        sent: false,
        status: "refused",
        message:
          failure._tag === "McpRefused"
            ? failure.message
            : failure._tag === "NotFound"
              ? "This server isn't available now."
              : "This server changed. Try again."
      }) as const

    const call: McpConnectionsShape["call"] = ({ userId, connectionId, tool, args, attribution, onProgress }) =>
      Effect.gen(function* () {
        const prepared = yield* Effect.result(prepare(userId, connectionId))
        if (prepared._tag === "Failure") {
          const failure = prepared.failure
          // A server that can't be used now keeps no client.
          if (failure._tag === "McpRefused" || failure._tag === "NotFound" || failure._tag === "StaleWrite") {
            yield* closeKeptFor(connectionId, userId)
            return unavailable(failure)
          }
          return yield* Effect.fail(failure)
        }
        const ready = prepared.success
        // `initialize` is the connection's, not the call's: only `tools/call` names the call.
        const opening = { ...attribution, rolloutId: null, toolCallId: null }
        const send = (session: McpSession, attempt: number) =>
          recorded(
            userId,
            ready,
            session.counts,
            { method: "tools/call", tool },
            { ...attribution, attempt },
            (signal, timeout) =>
              session.client.request(
                {
                  method: "tools/call",
                  params: { name: tool, arguments: (args ?? {}) as Record<string, unknown> }
                },
                CallToolResultSchema,
                {
                  signal,
                  timeout,
                  resetTimeoutOnProgress: true,
                  maxTotalTimeout: MCP_CALL_MAX_MS,
                  // The server's words are shown to the user: its secrets scrubbed first.
                  onprogress: (progress) =>
                    onProgress?.({
                      ...progress,
                      message: progress.message === undefined ? undefined : ready.scrub(progress.message)
                    })
                }
              ),
            MCP_CALL_MAX_MS,
            session.program
          )
        /** One attempt on a kept client, released after; `stale` asks for a fresh one. */
        const attempt = (number: number, stale?: Pooled) =>
          Effect.gen(function* () {
            const held = yield* Effect.result(acquire(userId, ready, opening, stale))
            if (held._tag === "Failure") return { _tag: "NotSent", failure: held.failure } as const
            const { key, entry } = held.success
            const outcome = yield* Effect.result(send(entry.session, number)).pipe(
              Effect.ensuring(Effect.suspend(() => release(key, entry)))
            )
            if (outcome._tag === "Success") return { _tag: "Done", result: outcome.success } as const
            const failure = outcome.failure
            // A dropped connection leaves the session in doubt: the next call opens another.
            if (
              failure instanceof McpRequestFailed &&
              (failure.status === "failed" || failure.status === "interrupted")
            )
              entry.dead = true
            return { _tag: "Sent", failure, entry } as const
          })
        const first = yield* attempt(attribution.attempt)
        // The owner's first connect of this process for the connection lists its tools again, after
        // the call.
        if (first._tag !== "NotSent" && ready.connection.owned && !listedHere.has(connectionId)) {
          listedHere.add(connectionId)
          const key = keyOf(connectionId, userId)
          const entry = pool.get(key)
          if (entry !== undefined) runFork(relist(userId, ready, key, entry))
        }
        const settled =
          // The server refused it unprocessed: reconnect once and send it again (spec/MCP.md §7.2).
          first._tag === "Sent" && first.failure instanceof McpRequestFailed && first.failure.deadSession
            ? yield* attempt(attribution.attempt + 1, first.entry)
            : first
        if (settled._tag === "Done") return { _tag: "Result", result: settled.result, scrub: ready.scrub } as const
        const failure = settled.failure
        // Refused unprocessed both times, or never sent at all: nothing can have happened.
        const sent = settled._tag === "Sent" && !(failure instanceof McpRequestFailed && failure.deadSession)
        if (failure instanceof McpRequestFailed)
          return { _tag: "Failed", sent, status: failure.status, message: failure.message } as const
        if (failure._tag === "NotFound")
          return { _tag: "Failed", sent, status: "refused", message: "This server isn't available now." } as const
        return yield* Effect.fail(failure)
      })

    const closeKeptFor = (connectionId: string, userId: string) =>
      Effect.suspend(() => {
        const key = keyOf(connectionId, userId)
        const entry = pool.get(key)
        return entry === undefined ? Effect.void : retire(key, entry)
      })

    /** `initialize` and every page of `tools/list`, up to the listing's bounds. */
    const list = (userId: UserId, prepared: McpPrepared, transport: RemoteMcpTransport) =>
      Effect.scoped(
        Effect.flatMap(open(userId, prepared, CHECK, transport), (session) => listOn(userId, prepared, session))
      )

    /** Every page of `tools/list` on an open client, up to the listing's bounds, as Check stores it. */
    const listOn = (userId: UserId, prepared: McpPrepared, session: McpSession) =>
      Effect.gen(function* () {
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

    // Listing again on a kept client (spec/MCP.md §4.1): when a connected server says its tools
    // changed (`notifications/tools/list_changed`), and at the first connect of this process for a
    // connection. It carries nothing of the user's, and the connection is enabled, or it wouldn't
    // be connected. Only on the owner's session: a shared user's session carries their own
    // sign-in (or their own program's files), and the catalog and instructions it lists are what
    // every other user's model is sent, so another account's listing never replaces them. The catalog is stored only if it changed (`SaveMcpCatalog`), and a listing made
    // against an older `cache_revision` is dropped. One listing of a connection at a time.
    const listedHere = new Set<string>()
    const listLocks = keyedLocks()
    const relist = (userId: UserId, prepared: McpPrepared, key: string, entry: Pooled) => {
      const connectionId = prepared.connection.id
      return listLocks
        .withLock(
          connectionId,
          Effect.gen(function* () {
            if (entry.dead || entry.retired) return
            const before = yield* reader.GetMcpConnection({ userId, connectionId })
            if (!before.owned || before.cacheRevision !== entry.revision) return
            entry.users += 1
            if (entry.timer !== null) clearTimeout(entry.timer)
            entry.timer = null
            const listed = yield* listOn(userId, prepared, entry.session).pipe(
              Effect.ensuring(Effect.suspend(() => release(key, entry)))
            )
            const tools = buildCatalog(before.key, listed.tools, before.tools, before.catalogRevision + 1)
            yield* writer.SaveMcpCatalog({
              userId,
              connectionId,
              expectedCacheRevision: before.cacheRevision,
              expectedCatalogRevision: before.catalogRevision,
              outcome: { server: listed.server, tools },
              at: Date.now()
            })
          })
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`listing ${prepared.connection.name}'s tools again failed`, cause)
          )
        )
    }

    const check: McpConnectionsShape["check"] = (userId, connectionId) =>
      Effect.gen(function* () {
        const before = yield* reader.GetMcpConnection({ userId, connectionId })
        // Check stores the catalog everyone sharing it sees: only the owner starts one.
        if (!before.owned) return yield* Effect.fail(new NotFound({ entity: "mcp_connection", id: connectionId }))
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
          before.transport === "stdio" ||
          listed.failure.auth ||
          listed.failure.status === "timeout" ||
          listed.failure.status === "cancelled"
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
        if (valid.transport === "stdio" && (key !== null || credentialId !== null))
          return yield* refused("A local program takes no key: give it environment variables instead.")
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
        if (connection.cacheRevision !== before.cacheRevision) yield* closeKept(connectionId)
        if (
          before.url === connection.url &&
          before.transport === connection.transport &&
          JSON.stringify(before.program) === JSON.stringify(connection.program)
        )
          return { connection, check: null }
        return yield* check(userId, connectionId)
      })

    const setKey: McpConnectionsShape["setKey"] = (userId, connectionId, apiKey, expectedRowVersion) =>
      Effect.gen(function* () {
        const connection = yield* reader.GetMcpConnection({ userId, connectionId })
        const key = typedKey(apiKey)
        if (key !== null && connection.url === null)
          return yield* refused("This server has no address to send a key to.")
        return yield* writer
          .SetMcpKey({
            userId,
            connectionId,
            expectedRowVersion,
            credential: key === null ? null : newCredential(connection.name, key, connection.url!),
            at: Date.now()
          })
          .pipe(Effect.tap(() => closeKept(connectionId)))
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
        return yield* writer
          .SetMcpHeaders({
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
          .pipe(Effect.tap(() => closeKept(connectionId)))
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
        return yield* writer
          .SetMcpProxy({
            userId,
            connectionId,
            mode,
            urlEnc: mode === "custom" && url !== null ? secrets.encrypt(url, proxyBinding(connectionId)) : null,
            at: Date.now()
          })
          .pipe(Effect.tap(() => closeKept(connectionId)))
      })

    // Signing in with the server (spec/MCP.md §2.4). The browser is away on the server's sign-in
    // page between the two steps; what the second needs waits here, keyed by the random `state`
    // the page sends back, for the user who started it. It doesn't outlive the process.
    const pendingSignIns = new Map<
      string,
      {
        readonly userId: UserId
        readonly connectionId: McpConnectionId
        readonly cacheRevision: number
        readonly origin: string
        readonly pending: PendingSignIn
        readonly until: number
      }
    >()
    const prunePending = (now: number) => {
      for (const [state, entry] of pendingSignIns) if (entry.until < now) pendingSignIns.delete(state)
    }
    const clientRegistry = makeClientRegistry()
    const { publicOrigins } = parsePublicOrigins(config.publicOrigins)
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

    /** The browser's address for the app, if the sign-in page may send it back there. */
    const appOriginProblem = (appOrigin: string) => {
      const origin = originOf(appOrigin)
      if (origin === null || origin !== appOrigin) return "This app's address isn't valid."
      const host = new URL(origin).hostname
      if (publicOrigins.origins.includes(origin) || loopbackHosts.has(host)) return null
      return `The server can't send you back to ${origin}: it isn't one of this app's public addresses. An admin can add it to PUBLIC_ORIGINS.`
    }

    const startSignIn: McpConnectionsShape["startSignIn"] = (userId, connectionId, appOrigin) =>
      Effect.gen(function* () {
        const problem = appOriginProblem(appOrigin)
        if (problem !== null) return yield* refused(problem)
        const prepared = yield* prepareWith(userId, connectionId, false)
        const url = prepared.url
        if (url === null) return yield* refused(`${prepared.connection.name} is a local program: it has no sign-in.`)
        const resolved = yield* reader.ResolveMcpConnection({ userId, connectionId })
        // An earlier sign-in's discovery and registration are used again only for the same address.
        const previous = resolved.oauthEnc === null ? null : yield* readSignIn(connectionId, userId, resolved.oauthEnc)
        const redirectUri = `${appOrigin}${MCP_OAUTH_CALLBACK}`
        prunePending(Date.now())
        if (pendingSignIns.size >= SIGN_IN_PENDING_MAX)
          return yield* refused("Too many sign-ins are waiting on this server. Try again in a few minutes.")
        const started = yield* signInStep(userId, prepared, prepared.network, url, (fetchFn) =>
          startFlow(fetchFn, url, redirectUri, previous, {
            registry: clientRegistry,
            // A shared user's browser is sent with the server's origin only (spec/MCP.md §3).
            resourceOrigin: !prepared.connection.owned
          })
        )
        // The page is opened by the browser: only a web address.
        if (!/^https?:$/.test(started.authorizationUrl.protocol))
          return yield* refused(`${prepared.connection.name}'s sign-in page isn't a web address.`)
        const now = Date.now()
        prunePending(now)
        // A user's oldest waiting sign-ins give way to a new one.
        const mine = [...pendingSignIns].filter(([, entry]) => entry.userId === userId)
        for (const [state] of mine.slice(0, Math.max(0, mine.length - SIGN_IN_PENDING_PER_USER + 1)))
          pendingSignIns.delete(state)
        pendingSignIns.set(started.pending.state, {
          userId,
          connectionId,
          cacheRevision: prepared.connection.cacheRevision,
          origin: url.origin,
          pending: started.pending,
          until: now + SIGN_IN_PENDING_MS
        })
        return { authorizationUrl: started.authorizationUrl.href }
      })

    const finishSignIn: McpConnectionsShape["finishSignIn"] = (userId, state, code, error) =>
      Effect.gen(function* () {
        prunePending(Date.now())
        const entry = pendingSignIns.get(state)
        // Only the user who started it may finish it, so a link to someone else's sign-in does nothing.
        if (entry === undefined || entry.userId !== userId || entry.until < Date.now())
          return yield* refused(
            "This sign-in has expired or was started elsewhere. Start it again from the server's page."
          )
        pendingSignIns.delete(state)
        const prepared = yield* prepareWith(userId, entry.connectionId, false)
        const name = prepared.connection.name
        if (error !== null) return yield* refused(`${name} didn't sign you in: ${prepared.scrub(error).slice(0, 200)}`)
        if (code === null || code === "") return yield* refused(`${name} didn't sign you in.`)
        const url = prepared.url
        if (prepared.connection.cacheRevision !== entry.cacheRevision || url === null || url.origin !== entry.origin)
          return yield* refused(`${name}'s address changed while you were signing in. Start again.`)
        const stored = yield* signInStep(userId, prepared, prepared.network, url, (fetchFn) =>
          finishFlow(fetchFn, url, entry.pending, code, Date.now())
        )
        yield* writer.SetMcpOAuth({
          userId,
          connectionId: entry.connectionId,
          oauth: {
            enc: secrets.encrypt(JSON.stringify(stored), oauthBinding(entry.connectionId, userId)),
            origin: entry.origin,
            expiresAt: stored.expiresAt
          },
          at: Date.now()
        })
        yield* closeKeptFor(entry.connectionId, userId)
        // A new sign-in is checked once, as a new address is (spec/MCP.md §2.5).
        yield* check(userId, entry.connectionId).pipe(Effect.ignore)
        return { connectionId: entry.connectionId, name }
      })

    const signOut: McpConnectionsShape["signOut"] = (userId, connectionId) =>
      writer
        .SetMcpOAuth({ userId, connectionId, oauth: null, at: Date.now() })
        .pipe(Effect.tap(() => closeKeptFor(connectionId, userId)))

    const setEnvironment: McpConnectionsShape["setEnvironment"] = (userId, connectionId, env, expectedRowVersion) =>
      Effect.gen(function* () {
        const connection = yield* reader.GetMcpConnection({ userId, connectionId })
        if (connection.transport !== "stdio") return yield* refused("Only a local program has environment variables.")
        const entries = Object.entries(env ?? {}).map(([name, value]) => [name.trim(), value] as const)
        for (const [name, value] of entries) {
          // PATH, HOME and LANG are the sandbox's own, and nothing that changes how programs start.
          const problem = programEnvProblem(name)
          if (problem !== null) return yield* refused(problem)
          if (value.includes("\0") || value.length > 32_768)
            return yield* refused(`${name}'s value is too long or invalid.`)
        }
        if (entries.length > 64) return yield* refused("Give at most 64 variables.")
        return yield* writer
          .SetMcpEnvironment({
            userId,
            connectionId,
            expectedRowVersion,
            env:
              entries.length === 0
                ? null
                : {
                    enc: secrets.encrypt(JSON.stringify(Object.fromEntries(entries)), envBinding(connectionId)),
                    names: entries.map(([name]) => name)
                  },
            at: Date.now()
          })
          .pipe(
            Effect.tap(() => closeKept(connectionId)),
            Effect.tap(() => Effect.sync(() => programs.forget(connectionId)))
          )
      })

    // A program's error output is its owner's only (spec/MCP.md §3: a shared user never sees
    // its secrets, and programs print their configuration), and the owner's variables' values
    // are scrubbed from it.
    const programOutput: McpConnectionsShape["programOutput"] = (userId, connectionId) =>
      Effect.flatMap(reader.GetMcpConnection({ userId, connectionId }), (connection) => {
        if (!connection.owned) return Effect.fail(new NotFound({ entity: "mcp_connection", id: connectionId }))
        const ring = programs.outputOf(connectionId, userId)
        return Effect.succeed({ running: ring.running, output: ring.text() })
      })

    return McpConnections.of({
      localPrograms: config.mcpLocalPrograms,
      localProgramsFor,
      setEnvironment,
      programOutput,
      startSignIn,
      finishSignIn,
      signOut,
      create,
      update,
      setKey,
      setHeaders,
      setProxy,
      check,
      prepare,
      open,
      request,
      call,
      closeKept,
      kept: () => [...pool.values()].filter((entry) => !entry.dead && !entry.retired).length,
      retained: () => ({
        pendingSignIns: pendingSignIns.size,
        locks: locks.size() + signInLocks.size() + listLocks.size(),
        outputs: programs.size(),
        registrations: clientRegistry.size()
      })
    })
  })
)

/** Startup: requests a previous process left running stay as records, marked interrupted (spec/MCP.md §8.3). */
export const interruptRunningCalls = Effect.gen(function* () {
  const writer = yield* Writer
  const { interrupted } = yield* writer.InterruptRunningMcpCalls()
  if (interrupted > 0) yield* Effect.logWarning(`${interrupted} MCP requests were interrupted by the last shutdown`)
})
