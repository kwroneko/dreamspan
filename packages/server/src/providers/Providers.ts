// The provider layer (spec/PROVIDERS.md): one streaming entry point over pi-ai for the
// assembler and, later, the agent loop, plus the connection operations that need the
// server secret or the network (encrypting secrets, fetching model lists, testing).
//
// pi-ai's API implementations are called directly with an explicit key and an empty
// env, never through its Models collection, so no request can pick up a key from the
// server's environment (PROVIDERS §4).
import type {
  Api,
  AssistantMessage,
  Context as PiContext,
  Model as PiModel,
  ThinkingLevel
} from "@earendil-works/pi-ai"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import {
  type Connection,
  type ConnectionId,
  type ConnectionSettings,
  type Credential,
  type CredentialId,
  type EffectiveModel,
  type Model,
  type ModelId,
  type ProviderKind,
  ProviderKindInfo,
  type ProxyMode,
  originOf,
  resolveModel
} from "@rp/shared/providers.ts"
import type { Cost, LlmRequestId, RequestPurpose, TokenCounts } from "@rp/shared/usage.ts"
import { createHash, timingSafeEqual } from "node:crypto"
import { ServerError } from "@rp/shared/errors.ts"
import { Cause, Context, Effect, Exit, Layer, Queue, Semaphore, Stream } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { Network, type ProxyOverride, RedirectRefused } from "../net/Network.ts"
import { describeRoute, proxyUrlProblem } from "../net/route.ts"
import { Secrets } from "../secrets.ts"
import { catalogEntry } from "./catalog.ts"
import { classify, parseRetryAfter, ProviderError, providerError, RETRYABLE } from "./errors.ts"
import type { ModelListError } from "./modelLists.ts"
import { type ProviderKindEntry, ProviderRegistry, type RequestTarget } from "./registry.ts"
import { type Capture, costOf, emptyCapture, finalCounts } from "./usage.ts"

export { ProviderError } from "./errors.ts"

/** Retries before the first token (PROVIDERS §7.2). After output, a failure is the user's call. */
interface RetryPolicy {
  readonly maxRetries: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}
const defaultRetryPolicy: RetryPolicy = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 }

export interface StreamRequest {
  readonly userId: UserId
  readonly connectionId: ConnectionId
  readonly modelId: ModelId
  readonly context: PiContext
  readonly options?: {
    readonly reasoning?: ThinkingLevel
    readonly maxTokens?: number
    readonly temperature?: number
    readonly sampling?: Readonly<Record<string, unknown>>
    readonly sessionId?: string
    readonly cacheRetention?: "none" | "short" | "long"
    /**
     * Explicit cache breakpoints (PROVIDERS §8): indices into `context.messages`, most
     * important first. Applied for Anthropic Messages; pi-ai's own markers stay.
     */
    readonly breakpoints?: ReadonlyArray<number>
  }
  readonly attribution: {
    readonly purpose: RequestPurpose
    readonly chatId?: ChatId | null
    readonly rolloutId?: string | null
    readonly versionId?: VersionId | null
  }
}

export type ProviderEvent =
  | { readonly type: "attempt"; readonly attempt: number; readonly requestId: LlmRequestId }
  | { readonly type: "route"; readonly description: string }
  /** Waiting out a rate limit the provider asked for on this connection, before sending. */
  | { readonly type: "paused"; readonly delayMs: number }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thinking"; readonly delta: string }
  | {
      readonly type: "retrying"
      readonly attempt: number
      readonly maxRetries: number
      readonly delayMs: number
      readonly error: ProviderError
    }
  | {
      readonly type: "done"
      readonly requestId: LlmRequestId
      readonly message: AssistantMessage
      readonly counts: TokenCounts
      readonly cost: Cost | null
    }

export interface TestResult {
  readonly ok: boolean
  readonly detail: string
  readonly route: string | null
  readonly models: number | null
}

/** Everything a request on a connection needs, secrets decrypted. Lives for one request. */
interface Prepared {
  readonly connection: Connection
  readonly kind: ProviderKindEntry
  readonly api: string
  readonly baseUrl: string
  readonly apiKey: string | null
  readonly headers: Readonly<Record<string, string>>
  readonly override: ProxyOverride
  /** Removes this connection's secrets from text that will be stored or shown (PROVIDERS §5). */
  readonly scrub: (text: string) => string
}

/** A scrubber for the given secrets: every occurrence becomes "[redacted]". */
export const makeScrub = (secrets: ReadonlyArray<string | null | undefined>) => {
  // Short values would redact ordinary words; real keys and tokens are long.
  const values = [...new Set(secrets.filter((v): v is string => typeof v === "string" && v.length >= 6))].sort(
    (a, b) => b.length - a.length
  )
  return (text: string) => values.reduce((out, value) => out.split(value).join("[redacted]"), text)
}

/** The secrets in a proxy URL: the whole URL and its password. */
const proxySecrets = (url: string | null) => {
  if (url === null) return []
  try {
    const parsed = new URL(url)
    return [url, decodeURIComponent(parsed.password), parsed.href]
  } catch {
    return [url]
  }
}

const binding = (connectionId: string, field: "headers" | "proxy_url") => `connection:${connectionId}:${field}`
const credentialBinding = (credentialId: string) => `credential:${credentialId}:key`

/** Compares two keys without leaking where they differ through timing. */
const sameKey = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())

export interface ProvidersOptions {
  readonly retry?: RetryPolicy
  /**
   * Keys are sent only to the origins their credential allows (PLUGINS.md §6.1). On by
   * default, and switchable only outside the app (KEY_HOST_BINDING), never from the
   * app or its agent (owner, 2026-10-11).
   */
  readonly bindKeysToOrigins?: boolean
}

export interface ProvidersShape {
  /**
   * A new connection, using an existing credential or a key typed for it. A typed key
   * becomes a credential named after the connection, bound to its origin.
   */
  readonly createConnection: (input: {
    readonly userId: UserId
    readonly kind: ProviderKind
    readonly settings: ConnectionSettings
    readonly apiKey?: string | null
    readonly credentialId?: CredentialId | null
  }) => Effect.Effect<Connection, ProviderError | ServerError>
  /** A credential: a key stored once, sent only to the origins of `urls`. */
  readonly createCredential: (input: {
    readonly userId: UserId
    readonly name: string
    readonly apiKey: string
    readonly urls: ReadonlyArray<string>
  }) => Effect.Effect<Credential, ProviderError | ServerError>
  /** A new key, with the origins it may go to stated again: approvals for the old key don't carry over. */
  readonly replaceCredentialKey: (
    userId: UserId,
    credentialId: CredentialId,
    apiKey: string,
    urls: ReadonlyArray<string>
  ) => Effect.Effect<Credential, ProviderError | ServerError>
  /**
   * Allows a credential's key to be sent to another origin. Takes the key typed again:
   * something acting as the user without knowing the key can't redirect it.
   */
  readonly allowCredentialOrigin: (input: {
    readonly userId: UserId
    readonly credentialId: CredentialId
    readonly apiKey: string
    readonly url: string
  }) => Effect.Effect<Credential, ProviderError | ServerError>
  /**
   * A key typed for a connection: a new credential bound to its origin, or null for none.
   * `expectedRowVersion` is the connection the user saw, so the key isn't bound to a base
   * URL someone changed in the meantime.
   */
  readonly setKey: (
    userId: UserId,
    connectionId: ConnectionId,
    apiKey: string | null,
    expectedRowVersion: number
  ) => Effect.Effect<Connection, ProviderError | ServerError>
  /** Header values, bound to the connection's current origin like a key. */
  readonly setHeaders: (
    userId: UserId,
    connectionId: ConnectionId,
    headers: Readonly<Record<string, string>> | null,
    expectedRowVersion: number
  ) => Effect.Effect<Connection, ProviderError | ServerError>
  readonly setProxy: (
    userId: UserId,
    connectionId: ConnectionId,
    mode: ProxyMode,
    url: string | null
  ) => Effect.Effect<Connection, ProviderError | ServerError>
  /** Fetches the upstream's model list and applies it (PROVIDERS §3.3). */
  readonly refreshModels: (
    userId: UserId,
    connectionId: ConnectionId
  ) => Effect.Effect<
    { readonly added: number; readonly updated: number; readonly missing: number; readonly route: string | null },
    ProviderError | ServerError
  >
  /** Checks a connection by fetching its model list; reports the route it took. */
  readonly testConnection: (
    userId: UserId,
    connectionId: ConnectionId
  ) => Effect.Effect<TestResult, ProviderError | ServerError>
  readonly stream: (request: StreamRequest) => Stream.Stream<ProviderEvent, ProviderError | ServerError>
  /** The provider kinds in effect, built-in and from plugins, in picker order. */
  readonly kinds: () => ReadonlyArray<ProviderKindInfo>
}

export class Providers extends Context.Service<Providers, ProvidersShape>()("rp/Providers") {}

/**
 * Storage outcomes the client can act on become provider errors (NotFound: unusable,
 * StaleWrite: reload). Anything else is logged and reaches the client only as ServerError.
 */
const fromStorage = <A, R>(
  effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>
): Effect.Effect<A, ProviderError | ServerError, R> =>
  effect.pipe(
    Effect.catch((error): Effect.Effect<never, ProviderError | ServerError> =>
      error._tag === "NotFound"
        ? Effect.fail(providerError("unusable", `${error.message || "not found"}`))
        : error._tag === "StaleWrite"
          ? Effect.fail(providerError("bad_request", "the connection changed in another tab; reload it"))
          : Effect.logError("provider storage operation failed", error).pipe(
              Effect.andThen(Effect.fail(new ServerError({ message: "storage operation failed" })))
            )
    )
  )

const fromList = (error: ModelListError) =>
  providerError(
    error.reason === "auth"
      ? "auth"
      : error.reason === "network"
        ? "network"
        : error.reason === "parse" || error.reason === "not_found"
          ? "bad_request"
          : "unknown",
    error.message,
    { status: error.status }
  )

/** The pi-ai model for a request: the catalog entry when it's for this wire API, overlaid with the merged description. */
const buildPiModel = async (prepared: Prepared, model: Model, effective: EffectiveModel): Promise<PiModel<Api>> => {
  const found = await catalogEntry(prepared.kind, model.key)
  const base = found?.sameApi ? found.entry : null
  const price = effective.price
  return {
    ...base,
    id: model.key,
    name: effective.name.value,
    api: prepared.api,
    provider: prepared.kind.piProvider,
    baseUrl: prepared.baseUrl,
    reasoning: effective.reasoning.value,
    ...(effective.thinkingLevels.value ? { thinkingLevelMap: { ...effective.thinkingLevels.value } } : {}),
    input: effective.vision.value ? ["text", "image"] : ["text"],
    cost: {
      input: price?.input ?? 0,
      output: price?.output ?? 0,
      cacheRead: price?.cacheRead ?? 0,
      cacheWrite: price?.cacheWrite ?? 0,
      ...(price?.tiers
        ? { tiers: price.tiers.map((t) => ({ ...t, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0 })) }
        : {})
    },
    contextWindow: effective.context.value,
    maxTokens: effective.maxOutput.value,
    ...(effective.cacheTtlS.value !== null ? { promptCache: { short: effective.cacheTtlS.value } } : {}),
    compat: { ...effective.compat } as never,
    ...(Object.keys(effective.sampling).length > 0 ? { samplingParams: { ...effective.sampling } as never } : {})
  } as PiModel<Api>
}

export const layer = (options: ProvidersOptions = {}) =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      const reader = yield* Reader
      const writer = yield* Writer
      const secrets = yield* Secrets
      const network = yield* Network
      const registry = yield* ProviderRegistry
      const policy = options.retry ?? defaultRetryPolicy
      const bindKeysToOrigins = options.bindKeysToOrigins ?? true

      const prepare = (userId: UserId, connectionId: ConnectionId) =>
        Effect.gen(function* () {
          const resolved = yield* fromStorage(reader.ResolveConnection({ userId, connectionId }))
          const connection = resolved.connection
          const info = registry.kinds.get(connection.kind)
          if (!info) {
            return yield* providerError("unusable", `the provider kind "${connection.kind}" isn't available`)
          }
          // A plugin may override a kind; it mustn't silently change existing connections' wire API.
          if (info.api !== connection.api) {
            return yield* providerError(
              "unusable",
              `the provider kind "${connection.kind}" now speaks ${info.api}, not ${connection.api}; create the connection again`
            )
          }
          const decryptWith = (blob: Uint8Array | null, bound: string) =>
            blob === null
              ? Effect.succeed(null)
              : secrets.decrypt(blob, bound).pipe(Effect.mapError((error) => providerError("unusable", error.message)))
          const baseUrl = connection.baseUrl ?? info.defaultBaseUrl
          const origin = originOf(baseUrl)
          if (origin === null) {
            return yield* providerError("unusable", `${connection.name}'s base URL isn't a valid URL: "${baseUrl}"`)
          }
          const credential = resolved.credential
          // The key is checked against its allowed origins before it's even decrypted.
          if (credential !== null && bindKeysToOrigins && !credential.origins.includes(origin)) {
            return yield* providerError(
              "unusable",
              `the key "${connection.credentialName ?? "?"}" isn't allowed for ${origin}; enter the key again to allow it`
            )
          }
          const apiKey =
            credential === null ? null : yield* decryptWith(credential.keyEnc, credentialBinding(credential.id))
          if (apiKey === null && !info.keyOptional) {
            return yield* providerError("unusable", `${connection.name} has no API key`)
          }
          // Header values often carry credentials, so they're bound to their origin like a key.
          if (resolved.headersEnc !== null && bindKeysToOrigins && resolved.headersOrigin !== origin) {
            return yield* providerError(
              "unusable",
              resolved.headersOrigin === null
                ? `${connection.name}'s custom headers were set before they were bound to a host; set them again`
                : `${connection.name}'s custom headers were set for ${resolved.headersOrigin}; set them again for ${origin}`
            )
          }
          const headersJson = yield* decryptWith(resolved.headersEnc, binding(connectionId, "headers"))
          const proxyUrl = yield* decryptWith(resolved.proxyUrlEnc, binding(connectionId, "proxy_url"))
          // An admin may require the instance proxy for everyone else (owner, 2026-10-11).
          const forced = network.forced() && resolved.ownerRole !== "admin"
          // Fails closed: setInstance refuses forcing without a proxy, but an unreadable one counts too.
          if (forced && (yield* network.view).proxy === null) {
            return yield* providerError("unusable", "the admin requires the instance proxy, but none is set")
          }
          const override: ProxyOverride = forced
            ? { mode: "inherit" }
            : connection.proxyMode === "custom" && proxyUrl !== null
              ? { mode: "custom", url: proxyUrl }
              : connection.proxyMode === "direct"
                ? { mode: "direct" }
                : { mode: "inherit" }
          const headers = headersJson === null ? {} : (JSON.parse(headersJson) as Record<string, string>)
          // Over http a connection's own proxy reads every byte. Setting one needs no key, so
          // it would otherwise be a way to collect the key in the clear.
          const secret = apiKey !== null || Object.keys(headers).length > 0
          if (override.mode === "custom" && secret && new URL(baseUrl).protocol === "http:") {
            return yield* providerError(
              "unusable",
              `${connection.name} sends its key over http, so its own proxy could read it; use https, or the instance proxy`
            )
          }
          const prepared: Prepared = {
            connection,
            kind: info,
            api: info.api,
            baseUrl,
            apiKey,
            headers,
            override,
            scrub: makeScrub([apiKey, ...Object.values(headers), ...proxySecrets(proxyUrl)])
          }
          if (!info.acceptsFetch) {
            // Its traffic would bypass our fetch, so it may only go where we'd send it direct anyway.
            const route = yield* network.route(new URL(prepared.baseUrl), override)
            if (route.via === "proxy") {
              return yield* providerError(
                "unusable",
                forced
                  ? `${info.label} connections can't go through a proxy yet (pi-ai's adapter doesn't take one), and the admin requires the instance proxy`
                  : `${info.label} connections can't go through a proxy yet (pi-ai's adapter doesn't take one); set this connection to direct or add the host to the bypass list`
              )
            }
          }
          return prepared
        })

      const scrubbed = (prepared: Prepared, error: ProviderError) =>
        providerError(error.reason, prepared.scrub(error.message), error)

      /** The fetch for a prepared connection's requests, reporting each route. */
      const fetchFor = (prepared: Prepared, onRoute: (description: string) => void) =>
        network.fetchFor(prepared.override, (route, target) => onRoute(describeRoute(route, target)))

      // --- Connection operations that need the secret ------------------------------

      /** A key as entered: surrounding whitespace dropped, and nothing left means no key. */
      const typedKey = (apiKey: string | null | undefined) => {
        const trimmed = apiKey?.trim() ?? ""
        return trimmed === "" ? null : trimmed
      }

      /** Short keys get no hint: four characters would be most of the key. */
      const encryptKey = (key: string, credentialId: CredentialId) => ({
        enc: secrets.encrypt(key, credentialBinding(credentialId)),
        hint: key.length >= 12 ? key.slice(-4) : ""
      })

      /** A typed key as a credential owned by a connection, bound to the connection's origin. */
      const typedCredential = (name: string, key: string, baseUrl: string) =>
        Effect.gen(function* () {
          const credentialId = uuidv7() as CredentialId
          const origins = yield* originsOf([baseUrl])
          return { credentialId, name, key: encryptKey(key, credentialId), origins }
        })

      const originsOf = (urls: ReadonlyArray<string>) =>
        Effect.forEach(urls, (url) => {
          const origin = originOf(url)
          return origin === null
            ? Effect.fail(providerError("bad_request", `not a URL: "${url}"`))
            : Effect.succeed(origin)
        })

      const createCredential: ProvidersShape["createCredential"] = ({ userId, name, apiKey, urls }) =>
        Effect.gen(function* () {
          const key = typedKey(apiKey)
          if (key === null) return yield* providerError("bad_request", "the key is empty")
          const origins = yield* originsOf(urls)
          const credentialId = uuidv7() as CredentialId
          return yield* fromStorage(
            writer.CreateCredential({
              userId,
              credentialId,
              name,
              key: encryptKey(key, credentialId),
              origins
            })
          )
        })

      const replaceCredentialKey: ProvidersShape["replaceCredentialKey"] = (userId, credentialId, apiKey, urls) =>
        Effect.gen(function* () {
          const key = typedKey(apiKey)
          if (key === null) return yield* providerError("bad_request", "the key is empty")
          const origins = yield* originsOf(urls)
          return yield* fromStorage(
            writer.ReplaceCredentialKey({ userId, credentialId, key: encryptKey(key, credentialId), origins })
          )
        })

      const allowCredentialOrigin: ProvidersShape["allowCredentialOrigin"] = ({ userId, credentialId, apiKey, url }) =>
        Effect.gen(function* () {
          const [origin] = yield* originsOf([url])
          const stored = yield* fromStorage(reader.ResolveCredential({ userId, credentialId }))
          const key = yield* secrets
            .decrypt(stored.keyEnc, credentialBinding(credentialId))
            .pipe(Effect.mapError((error) => providerError("unusable", error.message)))
          if (!sameKey(key, typedKey(apiKey) ?? "")) {
            return yield* providerError("auth", "that isn't this credential's key")
          }
          return yield* fromStorage(writer.AddCredentialOrigin({ userId, credentialId, origin: origin! }))
        })

      const createConnection: ProvidersShape["createConnection"] = ({ userId, kind, settings, apiKey, credentialId }) =>
        Effect.gen(function* () {
          const entry = registry.kinds.get(kind)
          if (!entry) return yield* providerError("bad_request", `unknown provider kind "${kind}"`)
          const key = typedKey(apiKey)
          const credential =
            key === null
              ? { existing: credentialId ?? null }
              : { typed: yield* typedCredential(settings.name, key, settings.baseUrl ?? entry.defaultBaseUrl) }
          return yield* fromStorage(
            writer.CreateConnection({
              userId,
              connectionId: uuidv7() as ConnectionId,
              kind,
              api: entry.api,
              settings,
              credential
            })
          )
        })

      /** The origin a connection's requests go to now. */
      const connectionOrigin = (userId: UserId, connectionId: ConnectionId) =>
        Effect.gen(function* () {
          const connection = yield* fromStorage(reader.GetConnection({ userId, connectionId }))
          const entry = registry.kinds.get(connection.kind)
          if (!entry) return yield* providerError("unusable", `the provider kind "${connection.kind}" isn't available`)
          return { connection, baseUrl: connection.baseUrl ?? entry.defaultBaseUrl }
        })

      const setKey: ProvidersShape["setKey"] = (userId, connectionId, apiKey, expectedRowVersion) =>
        Effect.gen(function* () {
          const key = typedKey(apiKey)
          const { connection, baseUrl } = yield* connectionOrigin(userId, connectionId)
          const credential = key === null ? null : yield* typedCredential(connection.name, key, baseUrl)
          return yield* fromStorage(writer.SetConnectionKey({ userId, connectionId, expectedRowVersion, credential }))
        })

      const setHeaders: ProvidersShape["setHeaders"] = (userId, connectionId, headers, expectedRowVersion) =>
        Effect.gen(function* () {
          const { baseUrl } = yield* connectionOrigin(userId, connectionId)
          const [origin] = yield* originsOf([baseUrl])
          return yield* fromStorage(
            writer.SetConnectionHeaders({
              userId,
              connectionId,
              expectedRowVersion,
              headers:
                headers === null || Object.keys(headers).length === 0
                  ? null
                  : {
                      enc: secrets.encrypt(JSON.stringify(headers), binding(connectionId, "headers")),
                      names: Object.keys(headers),
                      origin: origin!
                    }
            })
          )
        })

      const setProxy: ProvidersShape["setProxy"] = (userId, connectionId, mode, url) =>
        Effect.gen(function* () {
          if (mode !== "inherit" && network.forced()) {
            const resolved = yield* fromStorage(reader.ResolveConnection({ userId, connectionId }))
            if (resolved.ownerRole !== "admin") {
              return yield* providerError(
                "bad_request",
                "the admin requires every connection to use the instance proxy"
              )
            }
          }
          if (mode === "custom") {
            const problem = url === null ? "no proxy URL" : proxyUrlProblem(url)
            if (problem) return yield* providerError("bad_request", `proxy: ${problem}`)
          }
          return yield* fromStorage(
            writer.SetConnectionProxy({
              userId,
              connectionId,
              mode,
              urlEnc:
                mode === "custom" && url !== null ? secrets.encrypt(url, binding(connectionId, "proxy_url")) : null
            })
          )
        })

      const listModels = (prepared: Prepared, onRoute: (description: string) => void) =>
        prepared.kind
          .listModels({
            baseUrl: prepared.baseUrl,
            apiKey: prepared.apiKey,
            headers: prepared.headers,
            fetch: fetchFor(prepared, onRoute),
            scrub: prepared.scrub
          })
          .pipe(Effect.mapError((error) => scrubbed(prepared, fromList(error))))

      const refreshModels: ProvidersShape["refreshModels"] = (userId, connectionId) =>
        Effect.gen(function* () {
          const prepared = yield* prepare(userId, connectionId)
          let route: string | null = null
          const models = yield* listModels(prepared, (d) => (route = d))
          const result = yield* fromStorage(
            writer.SyncFetchedModels({ userId, connectionId, models, fetchedAt: Date.now() })
          )
          return { ...result, route }
        })

      const testConnection: ProvidersShape["testConnection"] = (userId, connectionId) =>
        Effect.gen(function* () {
          const prepared = yield* prepare(userId, connectionId)
          let route: string | null = null
          return yield* listModels(prepared, (d) => (route = d)).pipe(
            Effect.map((models): TestResult => ({
              ok: true,
              detail: `${models.length} models listed`,
              route,
              models: models.length
            })),
            Effect.catch((error) =>
              Effect.succeed<TestResult>({
                ok: false,
                detail: `${error.reason}: ${error.message}`,
                route,
                models: null
              })
            )
          )
        })

      // --- Streaming ----------------------------------------------------------------

      // Per-connection cap (PROVIDERS §7.3) and the pause a Retry-After asks for.
      const caps = new Map<string, { semaphore: Semaphore.Semaphore; permits: number }>()
      const pausedUntil = new Map<string, number>()
      const withCap = (connection: Connection) =>
        Effect.gen(function* () {
          if (connection.maxConcurrent === null) return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
          let cap = caps.get(connection.id)
          if (!cap) {
            cap = { semaphore: yield* Semaphore.make(connection.maxConcurrent), permits: connection.maxConcurrent }
            caps.set(connection.id, cap)
          } else if (cap.permits !== connection.maxConcurrent) {
            yield* cap.semaphore.resize(connection.maxConcurrent)
            cap.permits = connection.maxConcurrent
          }
          return cap.semaphore.withPermits(1)
        })

      /**
       * Waits out a pause the provider asked for, announcing it. Checked after taking a
       * permit, so queued requests honor a pause that began while they waited. A pause
       * longer than the retry policy allows fails instead of stalling silently.
       */
      const waitForPause = (connectionId: string, offer: (event: ProviderEvent) => void) =>
        Effect.suspend(() => {
          const wait = (pausedUntil.get(connectionId) ?? 0) - Date.now()
          if (wait <= 0) return Effect.void
          if (wait > policy.maxDelayMs) {
            return Effect.fail(
              providerError("rate_limited", `the provider asked to wait ${Math.ceil(wait / 1000)} s`, {
                retryAfterMs: wait
              })
            )
          }
          offer({ type: "paused", delayMs: wait })
          return Effect.sleep(wait)
        })

      type AttemptOutcome =
        | { readonly ok: true; readonly event: Extract<ProviderEvent, { type: "done" }> }
        | { readonly ok: false; readonly error: ProviderError }

      const emptyUsage = () => ({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      })

      const attempt = (
        prepared: Prepared,
        model: Model,
        piModel: PiModel<Api>,
        knownContext: number | undefined,
        request: StreamRequest,
        offer: (event: ProviderEvent) => void,
        number: number
      ) => {
        const requestId = uuidv7() as LlmRequestId
        const attribution = request.attribution
        const state = {
          capture: emptyCapture() as Capture,
          status: null as number | null,
          retryAfterMs: null as number | null,
          firstTokenAt: null as number | null,
          partial: null as AssistantMessage | null,
          refused: null as string | null
        }
        /** What the request produced so far, for a close after an interruption or a defect. */
        const partialMessage = (stopReason: "aborted" | "error", errorMessage?: string): AssistantMessage => ({
          ...(state.partial ?? {
            role: "assistant",
            content: [],
            api: prepared.api,
            provider: piModel.provider,
            model: model.key,
            usage: emptyUsage(),
            timestamp: Date.now()
          }),
          stopReason,
          ...(errorMessage !== undefined ? { errorMessage } : {})
        })

        const writeClose = (message: AssistantMessage, error: ProviderError | null, context: PiContext["messages"]) =>
          Effect.gen(function* () {
            const { counts, source } = finalCounts(message, state.capture, context)
            const cost = costOf(
              registry.costs.list(),
              { kind: prepared.kind.id, api: prepared.api, model: model.key },
              { counts, capture: state.capture, price: model.upstream.price ?? null }
            )
            yield* writer
              .CloseLlmRequest({
                userId: request.userId,
                request: {
                  id: requestId,
                  status: error === null ? "complete" : error.reason === "aborted" ? "aborted" : "failed",
                  endedAt: Date.now(),
                  firstTokenAt: state.firstTokenAt,
                  responseModel: message.responseModel ?? (message.model !== model.key ? message.model : null),
                  upstream: state.capture.upstream,
                  counts,
                  usageSource: source,
                  rawUsage: state.capture.rawUsage,
                  reportedCost: state.capture.reportedCost,
                  cost,
                  error: error === null ? null : { reason: error.reason, message: error.message, status: error.status }
                }
              })
              .pipe(Effect.catch((e) => Effect.logError(`could not close ledger row ${requestId}`, e)))
            return { counts, cost }
          })

        const open = fromStorage(
          writer.OpenLlmRequest({
            userId: request.userId,
            request: {
              id: requestId,
              connectionId: prepared.connection.id,
              modelId: model.id,
              chatId: attribution.chatId ?? null,
              rolloutId: attribution.rolloutId ?? null,
              versionId: attribution.versionId ?? null,
              purpose: attribution.purpose,
              api: prepared.api,
              provider: piModel.provider,
              modelKey: model.key,
              startedAt: Date.now()
            }
          })
        )

        const use = Effect.gen(function* () {
          offer({ type: "attempt", attempt: number, requestId })
          const transcript = yield* Effect.try({
            try: () => normalizeContext(request.context),
            catch: (error) => providerError("bad_request", `the request context is invalid: ${String(error)}`)
          })
          const onRoute = (description: string) => offer({ type: "route", description })
          if (!prepared.kind.acceptsFetch) {
            const route = yield* network.route(new URL(prepared.baseUrl), prepared.override)
            onRoute(describeRoute(route, new URL(prepared.baseUrl)))
          }
          // pi-ai reports onResponse only for successful responses (the SDKs throw first on
          // errors), so the status and Retry-After are read here, on every response.
          const routed = fetchFor(prepared, onRoute)
          const observed: typeof fetch = async (input, init) => {
            // pi turns a thrown fetch into "Connection error.", which would be retried as a
            // network failure; a refused redirect is kept and reported as it is.
            const response = await routed(input, init).catch((error: unknown) => {
              if (error instanceof RedirectRefused) state.refused = error.message
              throw error
            })
            state.status = response.status
            state.retryAfterMs = parseRetryAfter(response.headers.get("retry-after") ?? undefined)
            return response
          }

          const message = yield* Effect.tryPromise({
            try: async (signal) => {
              const options = request.options ?? {}
              const target: RequestTarget = { kind: prepared.kind.id, api: prepared.api }
              const transforms = registry.transforms.list().filter((t) => t.appliesTo(target))
              const observers = registry.observers.list().filter((o) => o.appliesTo(target))
              const breakpoints = options.breakpoints ?? []
              const events = prepared.kind.streams.streamSimple(piModel, transcript, {
                // A keyless local server still needs a value; pi's direct calls require one.
                apiKey: prepared.apiKey ?? "no-key",
                env: {},
                maxRetries: 0,
                signal,
                headers: prepared.headers,
                ...(prepared.kind.acceptsFetch ? { fetch: observed } : {}),
                ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
                ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
                ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
                ...(options.cacheRetention !== undefined ? { cacheRetention: options.cacheRetention } : {}),
                ...(options.sampling !== undefined ? { samplingParams: { ...options.sampling } as never } : {}),
                onResponse: (response) => {
                  state.status = response.status
                  state.retryAfterMs = parseRetryAfter(response.headers["retry-after"])
                },
                // Registered observers read the raw events (usage capture, PROVIDERS §9.2).
                onProviderStreamEvent: (data) => {
                  for (const observer of observers) observer.observe(data, state.capture)
                },
                // Registered transforms rewrite the payload, in registration order.
                ...(transforms.length > 0
                  ? {
                      onPayload: (payload: unknown) =>
                        transforms.reduce(
                          (current, t) =>
                            t.transform(current, { target, messages: request.context.messages, breakpoints }),
                          payload as Record<string, unknown>
                        )
                    }
                  : {})
              })
              for await (const event of events) {
                if ("partial" in event) state.partial = event.partial
                if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
                  state.firstTokenAt ??= Date.now()
                  if (event.type === "text_delta") offer({ type: "text", delta: event.delta })
                  if (event.type === "thinking_delta") offer({ type: "thinking", delta: event.delta })
                }
              }
              return await events.result()
            },
            catch: (error) => error
          }).pipe(
            // pi-ai reports request failures in the message, but a direct call can also
            // throw; either way the result is a failed message.
            Effect.catch((thrown) =>
              Effect.succeed(partialMessage("error", thrown instanceof Error ? thrown.message : String(thrown)))
            )
          )
          const classified =
            state.refused !== null
              ? providerError("unusable", state.refused)
              : classify(
                  message,
                  { status: state.status, retryAfterMs: state.retryAfterMs, category: state.capture.refusalCategory },
                  knownContext,
                  state.firstTokenAt !== null
                )
          const error = classified === null ? null : scrubbed(prepared, classified)
          return { message, error }
        })

        // The row is opened before sending and closed on every exit: success, failure,
        // interruption at any point, or a defect (PROVIDERS §9.1).
        return Effect.acquireUseRelease(
          open,
          () => use,
          (_, exit) => {
            if (Exit.isSuccess(exit)) return Effect.void
            const interrupted = Cause.hasInterrupts(exit.cause)
            const detail = prepared.scrub(Cause.pretty(exit.cause))
            return writeClose(
              partialMessage(interrupted ? "aborted" : "error", interrupted ? undefined : detail),
              interrupted
                ? providerError("aborted", "stopped", { afterTokens: true })
                : providerError("unknown", detail),
              request.context.messages
            ).pipe(Effect.asVoid)
          }
        ).pipe(
          Effect.flatMap(({ message, error }) =>
            writeClose(message, error, request.context.messages).pipe(
              Effect.map(({ counts, cost }): AttemptOutcome =>
                error ? { ok: false, error } : { ok: true, event: { type: "done", requestId, message, counts, cost } }
              )
            )
          )
        )
      }

      const stream: ProvidersShape["stream"] = (request) =>
        Stream.callback<ProviderEvent, ProviderError | ServerError>((queue) =>
          Effect.gen(function* () {
            const offer = (event: ProviderEvent) => void Queue.offerUnsafe(queue, event)
            const prepared = yield* prepare(request.userId, request.connectionId)
            const model = yield* fromStorage(reader.GetModel({ userId: request.userId, modelId: request.modelId }))
            if (model.connectionId !== prepared.connection.id) {
              return yield* providerError("unusable", "that model belongs to another connection")
            }
            const effective = resolveModel(model.key, model.upstream, model.overrides, prepared.connection.compat)
            const piModel = yield* Effect.tryPromise({
              try: () => buildPiModel(prepared, model, effective),
              catch: (error) => providerError("unknown", `could not prepare the model: ${String(error)}`)
            })
            // An unknown context gets a default for the request, but overflow is only judged
            // against a context some source actually reported.
            const knownContext = effective.context.source === "unknown" ? undefined : effective.context.value
            const capped = yield* withCap(prepared.connection)

            for (let n = 0; ; n++) {
              const outcome = yield* capped(
                waitForPause(prepared.connection.id, offer).pipe(
                  Effect.andThen(attempt(prepared, model, piModel, knownContext, request, offer, n + 1))
                )
              )
              if (outcome.ok) {
                offer(outcome.event)
                yield* Queue.end(queue)
                return
              }
              const error = outcome.error
              if (error.reason === "rate_limited" && error.retryAfterMs !== null) {
                pausedUntil.set(prepared.connection.id, Date.now() + error.retryAfterMs)
              }
              const delayMs = error.retryAfterMs ?? Math.min(policy.baseDelayMs * 2 ** n, policy.maxDelayMs)
              const retry =
                RETRYABLE.has(error.reason) &&
                !error.afterTokens &&
                n < policy.maxRetries &&
                delayMs <= policy.maxDelayMs
              if (!retry) return yield* error
              offer({ type: "retrying", attempt: n + 1, maxRetries: policy.maxRetries, delayMs, error })
              // A pause set by this error is waited out (and announced) before the next attempt.
              if (pausedUntil.get(prepared.connection.id) === undefined || error.retryAfterMs === null) {
                yield* Effect.sleep(delayMs)
              }
            }
          }).pipe(
            // The stream ends on every exit: typed failures go through the queue, and a
            // defect becomes a typed error instead of leaving the stream open forever.
            Effect.catchCause((cause) => {
              const failure = Cause.findErrorOption(cause)
              if (failure._tag === "Some") return Queue.fail(queue, failure.value)
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
              return Effect.logError("provider stream defect", cause).pipe(
                Effect.andThen(Queue.fail(queue, providerError("unknown", "the request failed unexpectedly")))
              )
            })
          )
        )

      return Providers.of({
        kinds: () =>
          registry.kinds.list().map(
            (entry) =>
              new ProviderKindInfo({
                id: entry.id,
                label: entry.label,
                api: entry.api,
                defaultBaseUrl: entry.defaultBaseUrl,
                keyOptional: entry.keyOptional
              })
          ),
        createConnection,
        createCredential,
        replaceCredentialKey,
        allowCredentialOrigin,
        setKey,
        setHeaders,
        setProxy,
        refreshModels,
        testConnection,
        stream
      })
    })
  )
