import { documentedCachePolicy } from "./cachePolicy.ts"
import { hasImageBlocks, limitImages } from "./images.ts"
import { imageSample, payloadImages } from "./imageSamples.ts"
import { captureToolArguments } from "./toolArguments.ts"
// The provider layer (spec/PROVIDERS.md): one streaming entry point over pi-ai for the
// assembler and, later, the agent loop, plus the connection operations that need the
// server secret or the network (encrypting secrets, fetching model lists, testing).
//
// pi-ai's API implementations are called directly with an explicit key and an empty
// env, never through its Models collection, so no request can pick up a key from the
// server's environment (PROVIDERS §4).
import { inspectWire } from "../assembler/inspection.ts"
import { markWireSources, sentWire, wireContext } from "../assembler/wire.ts"
import type { AssembledRequest, ModelInput, InspectionInputs } from "../assembler/types.ts"
import { defaultCacheRelease, makeCacheStagger } from "./cacheStagger.ts"
import { cacheIdentity, routeCacheIdentity } from "./cacheIdentity.ts"
import { mappingCapabilities } from "./mapping.ts"
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
  type ModelUpstream,
  type ProviderKind,
  ProviderKindInfo,
  type ProxyMode,
  originOf,
  resolveModel
} from "@rp/shared/providers.ts"
import type { Cost, LlmRequestId, RequestPurpose, TokenCounts } from "@rp/shared/usage.ts"
import { createHash, timingSafeEqual } from "node:crypto"
import { ServerError, StaleWrite } from "@rp/shared/errors.ts"
import { Cause, Context, Effect, Exit, Layer, Queue, Semaphore, Stream } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { Network, type ProxyOverride, type RequestNetwork, RedirectRefused } from "../net/Network.ts"
import { describeRoute, proxyUrlProblem } from "../net/route.ts"
import { Secrets } from "../secrets.ts"
import { catalogEntry } from "./catalog.ts"
import { fillFromCatalogs, withCatalogs } from "./contextCatalog.ts"
import { statedContextLimit } from "./contextLimits.ts"
import { classify, parseRetryAfter, ProviderError, providerError, RETRYABLE } from "./errors.ts"
import type { ModelListError } from "./modelLists.ts"
import { type ProviderKindEntry, ProviderRegistry, type RequestTarget } from "./registry.ts"
import type { TextCountRequest } from "./textCounters.ts"
import { countingModelKey } from "./countingModel.ts"
import { type Capture, captureUsageHeaders, costOf, emptyCapture, finalCounts } from "./usage.ts"

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
  readonly inspection?: {
    readonly request: AssembledRequest
    readonly model: ModelInput
    readonly display?: InspectionInputs | undefined
  }
  readonly options?: {
    /** A forced tool used as generated prose, included in usage estimates. */
    readonly replyTool?: string
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
    /**
     * Fields set over the body pi-ai built, before the registered transforms run: what the
     * caller decides that pi-ai doesn't model, such as the context assembler's exact Chat
     * Completions messages and per-provider samplers.
     */
    readonly payload?: Readonly<Record<string, unknown>>
  }
  readonly attribution: {
    readonly purpose: RequestPurpose
    readonly chatId?: ChatId | null
    readonly rolloutId?: string | null
    readonly versionId?: VersionId | null
  }
}

export type ProviderEvent =
  | { readonly type: "waiting-cache"; readonly waiting: boolean }
  | { readonly type: "attempt"; readonly attempt: number; readonly requestId: LlmRequestId }
  | { readonly type: "route"; readonly description: string }
  /** Waiting out a rate limit the provider asked for on this connection, before sending. */
  | { readonly type: "paused"; readonly delayMs: number }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thinking"; readonly delta: string }
  | { readonly type: "toolcall"; readonly name: string; readonly arguments: unknown }
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
      readonly toolArguments: Readonly<Record<string, string>>
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
  readonly registerHeaders: (headers: Readonly<Record<string, string | undefined>> | undefined) => void
  readonly transport: RequestNetwork
  /** Removes this connection's secrets from text that will be stored or shown (PROVIDERS §5). */
  readonly scrub: (text: string) => string
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The caller's fields over pi-ai's body: objects merge key by key (Google's `config`), anything else replaces. */
const merged = (base: unknown, over: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const out: Record<string, unknown> = isPlain(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlain(value) && isPlain(out[key]) ? merged(out[key], value) : value
  }
  return out
}

/** A scrubber for the given secrets: every occurrence becomes "[redacted]". */
export const makeScrub = (secrets: ReadonlyArray<string | null | undefined>) => {
  const values = [...new Set(secrets.filter((v): v is string => typeof v === "string" && v.length > 0))].sort(
    (a, b) => b.length - a.length
  )
  const pattern = values.length
    ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : null
  return (text: string) => (pattern ? text.replace(pattern, "[redacted]") : text)
}

/** One request-local inventory, populated as secrets resolve, before any payload is captured. */
const requestSecrets = () => {
  const values = new Set<string>()
  let cached: ((text: string) => string) | undefined
  const add = (value: string) => {
    cached = undefined
    if (value) values.add(value)
    // Proxy credentials may be echoed independently, percent encoded, or as Basic auth.
    try {
      const url = new URL(value)
      values.add(url.href)
      const username = decodeURIComponent(url.username)
      const password = decodeURIComponent(url.password)
      for (const part of [url.username, url.password, username, password]) if (part) values.add(part)
      if (username || password) values.add(Buffer.from(`${username}:${password}`).toString("base64"))
    } catch {
      /* Most secrets aren't URLs. */
    }
    return value
  }
  const headers = (headers: Readonly<Record<string, string | undefined>> | undefined) => {
    for (const value of Object.values(headers ?? {})) {
      if (typeof value !== "string") continue
      add(value)
      const auth = /^(Bearer|Basic)\s+(.+)$/i.exec(value.trim())
      if (!auth) continue
      add(auth[2]!)
      if (auth[1]!.toLowerCase() === "basic") {
        const decoded = Buffer.from(auth[2]!, "base64").toString("utf8")
        add(decoded)
        const colon = decoded.indexOf(":")
        if (colon >= 0) {
          add(decoded.slice(0, colon))
          add(decoded.slice(colon + 1))
        }
      }
    }
  }
  const route = (value: string) => {
    add(value)
    const url = new URL(value)
    // Routes have no public/private component annotation: conservatively protect all values.
    for (const part of [
      ...url.pathname.split("/"),
      ...url.search
        .slice(1)
        .split("&")
        .map((p) => p.slice(p.indexOf("=") + 1))
    ]) {
      if (!part) continue
      add(part)
      try {
        add(decodeURIComponent(part))
      } catch {
        /* Malformed encodings remain covered verbatim. */
      }
    }
    for (const value of url.searchParams.values()) add(value)
  }
  return { add, headers, route, scrub: (text: string) => (cached ??= makeScrub([...values]))(text) }
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
  ) => Effect.Effect<Connection, ProviderError | StaleWrite | ServerError>
  /** Header values, bound to the connection's current origin like a key. */
  readonly setHeaders: (
    userId: UserId,
    connectionId: ConnectionId,
    headers: Readonly<Record<string, string>> | null,
    expectedRowVersion: number
  ) => Effect.Effect<Connection, ProviderError | StaleWrite | ServerError>
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
  /**
   * What the registered catalogs know of a model id on this connection (its window, its output
   * limit), for a model the user adds by id; empty when nothing matches or the connection is gone.
   */
  readonly catalogUpstream: (userId: UserId, connectionId: ConnectionId, key: string) => Effect.Effect<ModelUpstream>
  /** Checks a connection by fetching its model list; reports the route it took. */
  readonly testConnection: (
    userId: UserId,
    connectionId: ConnectionId
  ) => Effect.Effect<TestResult, ProviderError | ServerError>
  readonly stream: (request: StreamRequest) => Stream.Stream<ProviderEvent, ProviderError | ServerError>
  /**
   * What a request with these counts would cost through the cost formulas, as the ledger
   * would record it (PROVIDERS §9.3): null when no formula prices this model. Nothing is sent.
   */
  readonly estimateCost: (
    userId: UserId,
    connectionId: ConnectionId,
    modelId: ModelId,
    counts: TokenCounts
  ) => Effect.Effect<Cost | null, ProviderError | ServerError>
  /** The provider kinds in effect, built-in and from plugins, in picker order. */
  readonly kinds: () => ReadonlyArray<ProviderKindInfo>
  /**
   * One image's exact token count for a model, from a registered image counter (ARCHITECTURE
   * §6); null when none applies. Never part of a send. A counter that asks a provider runs only
   * through `via`, the connection the user chose to count with (DESIGN §11: nothing goes to a
   * provider the user didn't choose); with `via` null only a local counter can count.
   */
  readonly countImageTokens: (input: {
    readonly userId: UserId
    readonly connectionId: ConnectionId
    readonly modelKey: string
    readonly image: { readonly data: string; readonly mimeType: string }
    readonly detail: string
    readonly via: ConnectionId | null
  }) => Effect.Effect<number | null, ProviderError | ServerError>
  /**
   * Each text's tokens with the model's own tokenizer, from the newest registered text counter
   * that applies (ARCHITECTURE §6 "Text tokens"), and what counted; null when none applies.
   * Never part of a send.
   */
  readonly countTextTokens: (input: {
    readonly userId: UserId
    readonly connectionId: ConnectionId
    readonly modelKey: string
    readonly texts: ReadonlyArray<string>
    readonly encode: TextCountRequest["encode"]
    /**
     * The connection whose provider the user chose to count with: this one or another of theirs
     * (owner, 2026-11-02: off by default, since the text goes to that provider); null, and
     * remote counters are skipped.
     */
    readonly via: ConnectionId | null
  }) => Effect.Effect<
    | { readonly counts: ReadonlyArray<number>; readonly id: string; readonly label: string }
    /** A provider's counter would apply, but the connection isn't opted in: its label. */
    | { readonly optIn: string }
    | null,
    ProviderError | ServerError
  >
}

export class Providers extends Context.Service<Providers, ProvidersShape>()("rp/Providers") {}

/**
 * Storage outcomes the client can act on become provider errors (NotFound: unusable).
 * Anything else is logged and reaches the client only as ServerError.
 */
const fromStorage = <A, R>(
  effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>
): Effect.Effect<A, ProviderError | ServerError, R> =>
  effect.pipe(
    Effect.catch((error): Effect.Effect<never, ProviderError | ServerError> =>
      error._tag === "NotFound"
        ? Effect.fail(providerError("unusable", `${error.message || "not found"}`))
        : Effect.logError("provider storage operation failed", error).pipe(
            Effect.andThen(Effect.fail(new ServerError({ message: "storage operation failed" })))
          )
    )
  )

/** A write checked against a row version: a StaleWrite reaches the client as itself, so it reloads. */
const fromVersionedStorage = <A, R>(
  effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>
): Effect.Effect<A, ProviderError | StaleWrite | ServerError, R> =>
  effect.pipe(
    Effect.catch((error): Effect.Effect<never, ProviderError | StaleWrite | ServerError> =>
      error instanceof StaleWrite ? Effect.fail(error) : fromStorage(Effect.fail(error))
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
  prepared.registerHeaders(base?.headers)
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
      /**
       * A context-length error with the limit it states, for the user to save on the model. A
       * request refused for its size under another status (a proxy's 400) is the same error.
       */
      const pickExtra = ({ status, retryAfterMs, category, afterTokens }: ProviderError) => ({
        status,
        retryAfterMs,
        category,
        afterTokens
      })
      const withStatedLimit = (error: ProviderError): ProviderError => {
        if (!["context_overflow", "bad_request", "unknown"].includes(error.reason)) return error
        const limit = statedContextLimit(registry.contextLimits.list(), error.message)
        if (limit === null) return error
        return providerError("context_overflow", error.message, { ...pickExtra(error), contextLimit: limit })
      }
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
          const inventory = requestSecrets()
          const decryptWith = (blob: Uint8Array | null, bound: string) =>
            blob === null
              ? Effect.succeed(null)
              : secrets.decrypt(blob, bound).pipe(
                  Effect.map(inventory.add),
                  Effect.mapError((error) => providerError("unusable", error.message))
                )
          const baseUrl = connection.baseUrl ?? info.defaultBaseUrl
          const origin = originOf(baseUrl)
          if (origin === null) {
            return yield* providerError("unusable", `${connection.name}'s base URL isn't a valid URL: "${baseUrl}"`)
          }
          inventory.route(baseUrl)
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
          inventory.headers(headers)
          const transport = network.prepare(override, inventory.add)
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
            transport,
            registerHeaders: inventory.headers,
            scrub: inventory.scrub
          }
          if (!info.acceptsFetch) {
            // Its traffic would bypass our fetch, so it may only go where we'd send it direct anyway.
            const route = yield* transport.route(new URL(prepared.baseUrl))
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
        prepared.transport.fetchFor((route, target) => onRoute(describeRoute(route, target)))

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
          return yield* fromVersionedStorage(
            writer.SetConnectionKey({ userId, connectionId, expectedRowVersion, credential })
          )
        })

      const setHeaders: ProvidersShape["setHeaders"] = (userId, connectionId, headers, expectedRowVersion) =>
        Effect.gen(function* () {
          const { baseUrl } = yield* connectionOrigin(userId, connectionId)
          const [origin] = yield* originsOf([baseUrl])
          return yield* fromVersionedStorage(
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
          const listed = yield* listModels(prepared, (d) => (route = d))
          const models = yield* withCatalogs(registry.catalogs.list(), prepared.kind.id, listed)
          const result = yield* fromStorage(
            writer.SyncFetchedModels({ userId, connectionId, models, fetchedAt: Date.now() })
          )
          return { ...result, route }
        })

      const catalogUpstream: ProvidersShape["catalogUpstream"] = (userId, connectionId, key) =>
        reader.GetConnection({ userId, connectionId }).pipe(
          Effect.flatMap((connection) =>
            Effect.promise(() => fillFromCatalogs(registry.catalogs.list(), connection.kind, { key, upstream: {} }))
          ),
          Effect.map((model) => model.upstream),
          Effect.catch(() => Effect.succeed<ModelUpstream>({}))
        )

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
      const stagger = makeCacheStagger()
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
        number: number,
        pricing: import("./userCosts.ts").UserPricing
      ) => {
        const requestId = uuidv7() as LlmRequestId
        const attribution = request.attribution
        const toolArguments = captureToolArguments()
        const state = {
          opened: false,
          held: false,
          cachePolicy: null as {
            readonly ttlS: number | null
            readonly fixed: boolean
            readonly source: string | null
          } | null,
          pendingIdentity: undefined as ReturnType<typeof cacheIdentity> | undefined,
          cacheIdentity: null as { readonly prefixes: ReadonlyArray<string>; readonly expiresAt: number | null } | null,
          capture: emptyCapture() as Capture,
          status: null as number | null,
          retryAfterMs: null as number | null,
          firstTokenAt: null as number | null,
          partial: null as AssistantMessage | null,
          refused: null as string | null,
          gate: undefined as ReturnType<typeof stagger.join> | undefined,
          release: undefined as "first-chunk" | "complete" | "timeout" | "leader-ended" | undefined,
          /** The images the final payload sent, for image token calibration. */
          sentImages: null as ReturnType<typeof payloadImages> | null
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

        const metadata = (value: string | null) => (value === null ? null : prepared.scrub(value).slice(0, 256))

        const writeClose = (message: AssistantMessage, error: ProviderError | null, context: PiContext["messages"]) =>
          Effect.gen(function* () {
            const { counts, source } = finalCounts(message, state.capture, context, request.options?.replyTool)
            if (!state.opened) return { counts, cost: null }
            // A request with images calibrates its model's image cost (ARCHITECTURE §6).
            const sample =
              error === null && source === "reported" && state.sentImages
                ? imageSample(
                    state.sentImages,
                    counts.inputUncached === null
                      ? null
                      : counts.inputUncached + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0),
                    state.capture.rawUsage
                  )
                : null
            if (sample)
              yield* writer
                .RecordImageTokenSample({
                  userId: request.userId,
                  connectionId: prepared.connection.id,
                  modelKey: model.key,
                  ...sample
                })
                .pipe(Effect.catch((e) => Effect.logWarning("could not record an image token sample", e)))
            const cost = costOf(
              registry.costs.list(),
              { kind: prepared.kind.id, api: prepared.api, model: model.key },
              { counts, pricing, capture: state.capture, price: model.upstream.price ?? null }
            )
            yield* writer
              .CloseLlmRequest({
                userId: request.userId,
                request: {
                  id: requestId,
                  status: error === null ? "complete" : error.reason === "aborted" ? "aborted" : "failed",
                  endedAt: Date.now(),
                  // Fixed caches keep their write's expiry; a read cannot start a new lifetime.
                  cacheIdentity:
                    state.cachePolicy?.fixed && !(counts.cacheRead === 0 || (counts.cacheWrite ?? 0) > 0)
                      ? null
                      : state.cacheIdentity,
                  firstTokenAt: state.firstTokenAt,
                  responseModel: metadata(
                    message.responseModel ?? (message.model !== model.key ? message.model : null)
                  ),
                  upstream: metadata(state.capture.upstream),
                  cacheStagger:
                    state.gate?.leader && state.release
                      ? {
                          leaderRequestId: state.gate.leader,
                          release: state.release,
                          hit: counts.cacheRead === null ? null : counts.cacheRead > 0
                        }
                      : null,
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

        // Admission uses the final transformed wire payload, immediately before dispatch.
        // UTF-8 bytes plus framing bound text tokens conservatively, without assuming cache hits.
        const open = (payload: Readonly<Record<string, unknown>>) =>
          Effect.gen(function* () {
            const hasImages = hasImageBlocks(payload)
            // Generations open their row before the payload exists; the final payload still says what was sent.
            if (hasImages) state.sentImages = payloadImages(payload)
            if (state.opened) return
            // Unknown image tokenization reserves the largest safe ledger value. Saturate
            // after adding framing/output too: MAX_SAFE_INTEGER + bytes is not a safe Int.
            const inputTokens = Math.min(
              Number.MAX_SAFE_INTEGER,
              Buffer.byteLength(JSON.stringify(payload), "utf8") +
                256 +
                (hasImages ? (knownContext ?? Number.MAX_SAFE_INTEGER) : 0)
            )
            const configurations = ["generationConfig", "config", "inferenceConfig", "inference_config"]
              .map((key) => payload[key])
              .filter(isPlain)
            const limits = [
              payload["max_tokens"],
              payload["max_completion_tokens"],
              payload["max_output_tokens"],
              payload["maxTokens"],
              payload["max_tokens_to_sample"],
              ...configurations.flatMap((c) => [c["maxOutputTokens"], c["maxTokens"], c["max_tokens"]])
            ].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
            const outputTokens = Math.max(
              ...(limits.length ? limits : [request.options?.maxTokens ?? piModel.maxTokens])
            )
            const target = { kind: prepared.kind.id, api: prepared.api, model: model.key }
            const formulas = [...registry.costs.list()]
              .reverse()
              .filter((f) => f.appliesTo(target) && f.id !== "reported")
            const formula = formulas.find(
              (f) =>
                f.reserves?.({ pricing }) ||
                f.cost({
                  pricing,
                  counts: {
                    inputUncached: inputTokens,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cacheWriteLong: 0,
                    output: outputTokens,
                    reasoning: null
                  },
                  capture: emptyCapture(),
                  price: model.upstream.price ?? null
                }) !== null
            )
            const bound =
              formula?.upperBound?.({ inputTokens, outputTokens, pricing, price: model.upstream.price ?? null }) ?? null
            const allowed = yield* fromStorage(
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
                  startedAt: Date.now(),
                  reservation: {
                    tokens: Math.min(Number.MAX_SAFE_INTEGER, inputTokens + outputTokens),
                    cost: bound?.amount ?? null,
                    currency: bound?.currency ?? null
                  }
                }
              })
            )
            if (!allowed) {
              state.held = true
              return yield* providerError("budget_held", "The backfill is held at its approved limit.")
            }
            state.opened = true
            offer({ type: "attempt", attempt: number, requestId })
          })

        const use = Effect.gen(function* () {
          const transcript = yield* Effect.try({
            try: () =>
              normalizeContext(
                limitImages(
                  request.context,
                  resolveModel(model.key, model.upstream, model.overrides, prepared.connection.compat).maxImages.value
                )
              ),
            catch: (error) => providerError("bad_request", `the request context is invalid: ${String(error)}`)
          })
          const onRoute = (description: string) => offer({ type: "route", description })
          if (!prepared.kind.acceptsFetch) {
            const route = yield* prepared.transport.route(new URL(prepared.baseUrl))
            onRoute(describeRoute(route, new URL(prepared.baseUrl)))
          }
          // pi-ai reports onResponse only for successful responses (the SDKs throw first on
          // errors), so the status and Retry-After are read here, on every response.
          const routed = fetchFor(prepared, onRoute)

          const message = yield* Effect.tryPromise({
            try: async (signal) => {
              let recordSent: (() => Promise<void>) | undefined
              // The sent context's write, under way beside the request (awaited before it ends).
              let recording: Promise<void> | undefined
              const observed: typeof fetch = async (input, init) => {
                if (state.pendingIdentity) {
                  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
                  const identity = routeCacheIdentity(state.pendingIdentity, headers)
                  state.pendingIdentity = undefined
                  const ttl = state.cachePolicy?.ttlS
                  state.cacheIdentity = {
                    prefixes: identity.prefixes,
                    expiresAt: ttl == null ? null : Date.now() + ttl * 1000
                  }
                  const key = identity.requested
                  if (key) {
                    const warm =
                      ttl != null &&
                      (await Effect.runPromise(
                        fromStorage(
                          reader.CachePrefixWarm({
                            userId: request.userId,
                            connectionId: prepared.connection.id,
                            modelId: model.id,
                            now: Date.now(),
                            prefix: key
                          })
                        ),
                        { signal }
                      ))
                    if (!warm) {
                      state.gate = stagger.join(key, requestId, prepared.kind.cacheRelease ?? defaultCacheRelease)
                      if (state.gate.leader) {
                        if (state.gate.waiting) offer({ type: "waiting-cache", waiting: true })
                        try {
                          state.release = await state.gate.wait(signal)
                        } finally {
                          offer({ type: "waiting-cache", waiting: false })
                        }
                      }
                    }
                  }
                }
                // Queued before any HTTP is sent, so it commits ahead of the rollout's later
                // writes, but not awaited: the request needn't wait on the writer.
                recording = recordSent?.()
                recordSent = undefined
                // SDK-created affinity headers are now available, before any HTTP is sent.
                // Preserve refused redirects instead of retrying the SDK's generic network error.
                const response = await routed(input, init).catch((error: unknown) => {
                  if (error instanceof RedirectRefused) state.refused = error.message
                  throw error
                })
                captureUsageHeaders(response.headers, state.capture)
                state.status = response.status
                state.retryAfterMs = parseRetryAfter(response.headers.get("retry-after") ?? undefined)
                return response
              }
              const options = request.options ?? {}
              const target: RequestTarget = { kind: prepared.kind.id, api: prepared.api }
              const transforms = registry.transforms.list().filter((t) => t.appliesTo(target))
              const observers = registry.observers.list().filter((o) => o.appliesTo(target))
              const breakpoints = options.breakpoints ?? []
              const overrides = options.payload
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
                  toolArguments.observe(data)
                  for (const observer of observers) observer.observe(data, state.capture)
                  if ((prepared.kind.cacheRelease ?? defaultCacheRelease).after === "first-chunk") {
                    state.gate?.release("first-chunk")
                  }
                },
                // The caller's fields, then the registered transforms, in registration order.
                onPayload: async (payload: unknown) => {
                  const sources = request.inspection
                    ? wireContext(request.inspection.request, {
                        ...request.inspection.model,
                        mapping: mappingCapabilities(
                          resolveModel(model.key, model.upstream, model.overrides, prepared.connection.compat)
                        )
                      })
                    : undefined
                  const initial =
                    overrides === undefined ? (payload as Record<string, unknown>) : merged(payload, overrides)
                  if (sources) markWireSources(initial, sources)
                  const transformed = transforms.reduce(
                    (current, t) => t.transform(current, { target, messages: request.context.messages, breakpoints }),
                    initial
                  )
                  const effective = resolveModel(model.key, model.upstream, model.overrides, prepared.connection.compat)
                  const final = limitImages(transformed, effective.maxImages.value)
                  await Effect.runPromise(open(final), { signal })
                  const policy = documentedCachePolicy(
                    { provider: prepared.kind.piProvider, api: prepared.api, model: model.key },
                    final
                  )
                  const selected = request.inspection?.model
                  state.cachePolicy = {
                    ttlS: selected?.cacheTtlOverride ? (selected.cacheTtlS ?? null) : (policy?.ttlS ?? null),
                    fixed: policy?.fixed ?? false,
                    source: selected?.cacheTtlOverride ? null : (policy?.source ?? null)
                  }
                  if (sources && request.inspection && state.gate === undefined) {
                    const input = request.inspection
                    const mappedModel = { ...input.model, mapping: sources.mapping }
                    const identity = cacheIdentity({
                      payload: final,
                      api: prepared.api,
                      mode: mappedModel.cacheBreakpoints,
                      retention: options.cacheRetention,
                      sources,
                      end: Math.max(-1, ...input.request.breakpoints.map((b) => b.message)),
                      scope: [
                        request.userId,
                        prepared.connection.id,
                        mappedModel.connectionRevision,
                        prepared.baseUrl,
                        prepared.headers,
                        model.id,
                        model.key,
                        prepared.api,
                        prepared.kind.id,
                        sources.mapping?.revision
                      ]
                    })
                    state.pendingIdentity = identity.prefixes.length > 0 ? identity : undefined
                  }
                  const rolloutId = request.attribution.rolloutId
                  if (sources && rolloutId) {
                    const wire = { ...sentWire(final, sources, prepared.scrub), cache: state.cachePolicy }
                    recordSent = () =>
                      Effect.runPromise(
                        fromStorage(
                          writer.RecordSentContext({
                            userId: request.userId,
                            rolloutId,
                            wire: JSON.stringify(
                              request.inspection?.display
                                ? inspectWire(
                                    wire,
                                    request.inspection.request,
                                    request.inspection.display,
                                    prepared.scrub
                                  )
                                : wire
                            )
                          })
                        )
                        // Not stopped with the request: what was sent stays on record.
                      ).catch((error: unknown) =>
                        Effect.runPromise(
                          Effect.logWarning(`recording the context sent for ${rolloutId} failed`, error)
                        )
                      )
                    if (!prepared.kind.acceptsFetch) {
                      recording = recordSent()
                      recordSent = undefined
                    }
                  }
                  return final
                }
              })
              try {
                for await (const event of events) {
                  if ("partial" in event) state.partial = event.partial
                  // Plugins may expose only normalized events, without a raw-event callback.
                  if (
                    event.type !== "start" &&
                    event.type !== "error" &&
                    (prepared.kind.cacheRelease ?? defaultCacheRelease).after === "first-chunk"
                  ) {
                    state.gate?.release("first-chunk")
                  }
                  if (
                    event.type === "text_delta" ||
                    event.type === "thinking_delta" ||
                    event.type === "toolcall_delta"
                  ) {
                    state.firstTokenAt ??= Date.now()
                    if (event.type === "text_delta") offer({ type: "text", delta: event.delta })
                    if (event.type === "thinking_delta") offer({ type: "thinking", delta: event.delta })
                    if (event.type === "toolcall_delta") {
                      const call = event.partial.content[event.contentIndex]
                      if (call?.type === "toolCall")
                        offer({ type: "toolcall", name: call.name, arguments: structuredClone(call.arguments) })
                    }
                  }
                }
                const result = await events.result()
                if (result.stopReason !== "error" && result.stopReason !== "aborted") state.gate?.release("complete")
                return result
              } finally {
                await recording
              }
            },
            catch: (error) => error
          }).pipe(
            // pi-ai reports request failures in the message, but a direct call can also
            // throw; either way the result is a failed message.
            Effect.catch((thrown) =>
              Effect.succeed(partialMessage("error", thrown instanceof Error ? thrown.message : String(thrown)))
            )
          )
          const classified = state.held
            ? providerError("budget_held", "The backfill is held at its approved limit.")
            : state.refused !== null
              ? providerError("unusable", state.refused)
              : classify(
                  message,
                  { status: state.status, retryAfterMs: state.retryAfterMs, category: state.capture.refusalCategory },
                  knownContext,
                  state.firstTokenAt !== null,
                  attribution.purpose !== "generation"
                )
          const error = classified === null ? null : scrubbed(prepared, withStatedLimit(classified))
          return { message, error }
        })

        // The row is opened before sending and closed on every exit: success, failure,
        // interruption at any point, or a defect (PROVIDERS §9.1).
        return Effect.acquireUseRelease(
          attribution.purpose === "summarize" ||
            attribution.purpose === "condense" ||
            (attribution.purpose === "decision" && attribution.rolloutId)
            ? Effect.void
            : open({}),
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
                error
                  ? { ok: false, error }
                  : {
                      ok: true,
                      event: {
                        type: "done",
                        requestId,
                        message,
                        toolArguments: toolArguments.argumentsById,
                        counts,
                        cost
                      }
                    }
              )
            )
          ),
          Effect.ensuring(Effect.sync(() => state.gate?.finish()))
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
            const pricing = {
              settings: yield* fromStorage(reader.GetCostSettings({ userId: request.userId })),
              kind: prepared.kind.id,
              connectionId: prepared.connection.id,
              model: model.key
            }
            const effective = resolveModel(model.key, model.upstream, model.overrides, prepared.connection.compat)
            const piModel = yield* Effect.tryPromise({
              try: () => buildPiModel(prepared, model, effective),
              catch: (error) =>
                scrubbed(prepared, providerError("unknown", `could not prepare the model: ${String(error)}`))
            })
            // An unknown context gets a default for the request, but overflow is only judged
            // against a context some source actually reported.
            const knownContext = effective.context.source === "unknown" ? undefined : effective.context.value
            const capped = yield* withCap(prepared.connection)

            for (let n = 0; ; n++) {
              const outcome = yield* capped(
                waitForPause(prepared.connection.id, offer).pipe(
                  Effect.andThen(attempt(prepared, model, piModel, knownContext, request, offer, n + 1, pricing))
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

      const estimateCost: ProvidersShape["estimateCost"] = (userId, connectionId, modelId, counts) =>
        Effect.gen(function* () {
          const connection = yield* fromStorage(reader.GetConnection({ userId, connectionId }))
          const model = yield* fromStorage(reader.GetModel({ userId, modelId }))
          if (model.connectionId !== connection.id) return null
          return costOf(
            registry.costs.list(),
            { kind: connection.kind, api: connection.api, model: model.key },
            {
              counts,
              pricing: {
                settings: yield* fromStorage(reader.GetCostSettings({ userId })),
                kind: connection.kind,
                connectionId,
                model: model.key
              },
              capture: emptyCapture(),
              price: model.upstream.price ?? null
            },
            true
          )
        })

      /**
       * Where a count goes: the chat's own connection, or the one the user chose to count with
       * (`via`), whose model of the same name is asked (`countingModel.ts`). Local counters
       * apply by the chat's connection and never send anything.
       */
      const countingTargets = (
        userId: UserId,
        connectionId: ConnectionId,
        modelKey: string,
        via: ConnectionId | null
      ) =>
        Effect.gen(function* () {
          const own = yield* prepare(userId, connectionId)
          const ownTarget = { kind: own.kind.id, api: own.api, model: modelKey, baseUrl: own.baseUrl }
          if (via === null || via === connectionId)
            return { own, ownTarget, remote: via === null ? null : { prepared: own, target: ownTarget } }
          const other = yield* prepare(userId, via)
          const listed = yield* fromStorage(reader.ListModels({ userId, connectionId: via, includeHidden: true }))
          const model = countingModelKey(
            modelKey,
            listed.map((m) => m.key)
          )
          return {
            own,
            ownTarget,
            remote: { prepared: other, target: { kind: other.kind.id, api: other.api, model, baseUrl: other.baseUrl } }
          }
        })

      const countImageTokens: ProvidersShape["countImageTokens"] = ({
        userId,
        connectionId,
        modelKey,
        image,
        detail,
        via
      }) =>
        Effect.gen(function* () {
          const { own, ownTarget, remote } = yield* countingTargets(userId, connectionId, modelKey, via)
          const counters = registry.imageCounters.list().toReversed()
          const local = counters.find((c) => !c.remote && c.appliesTo(ownTarget))
          const sent = remote ? counters.find((c) => c.remote && c.appliesTo(remote.target)) : undefined
          const chosen = local
            ? { counter: local, prepared: own, model: modelKey }
            : remote && sent
              ? { counter: sent, prepared: remote.prepared, model: remote.target.model }
              : null
          if (!chosen) return null
          const { counter, prepared, model } = chosen
          return yield* counter
            .count({
              baseUrl: prepared.baseUrl,
              apiKey: prepared.apiKey,
              headers: prepared.headers,
              fetch: fetchFor(prepared, () => {}),
              scrub: prepared.scrub,
              model,
              image,
              detail
            })
            .pipe(Effect.mapError((error) => providerError("unknown", prepared.scrub(error.message))))
        })

      const countTextTokens: ProvidersShape["countTextTokens"] = ({
        userId,
        connectionId,
        modelKey,
        texts,
        encode,
        via
      }) =>
        Effect.gen(function* () {
          const { own, ownTarget, remote } = yield* countingTargets(userId, connectionId, modelKey, via)
          const counters = registry.textCounters.list().toReversed()
          const onOwn = counters.filter((c) => c.appliesTo(ownTarget))
          const local = onOwn.find((c) => !c.remote)
          // The connection's own provider keeps the registry's order; another connection is
          // asked only where nothing local applies.
          const sent =
            remote && remote.prepared !== own ? counters.find((c) => c.remote && c.appliesTo(remote.target)) : undefined
          const chosen =
            remote && remote.prepared === own && onOwn[0]
              ? { counter: onOwn[0], prepared: own, model: modelKey }
              : local
                ? { counter: local, prepared: own, model: modelKey }
                : remote && sent
                  ? { counter: sent, prepared: remote.prepared, model: remote.target.model }
                  : null
          if (!chosen) return onOwn[0] ? { optIn: onOwn[0].label(modelKey) } : null
          const { counter, prepared, model } = chosen
          const counts = yield* counter
            .count({
              baseUrl: prepared.baseUrl,
              apiKey: prepared.apiKey,
              headers: prepared.headers,
              fetch: fetchFor(prepared, () => {}),
              scrub: prepared.scrub,
              model,
              texts,
              encode
            })
            .pipe(Effect.mapError((error) => providerError("unknown", prepared.scrub(error.message))))
          const label = counter.label(model)
          return {
            counts,
            id: counter.id,
            label: prepared === own ? label : `${label}, through ${prepared.connection.name}`
          }
        })

      return Providers.of({
        estimateCost,
        countImageTokens,
        countTextTokens,
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
        catalogUpstream,
        testConnection,
        stream
      })
    })
  )
