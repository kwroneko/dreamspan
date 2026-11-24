import { autoConfigurationStamp } from "../chat/autoConfiguration.ts"
import { AutoRequestGuard } from "../chat/Generator.ts"
import { summaryResponse } from "./summaryResponse.ts"
import { Formats } from "../importer/Formats.ts"
import { payloadText } from "./textPayload.ts"
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
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate"
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import {
  Connection,
  type ConnectionId,
  type ConnectionSettings,
  type Credential,
  type CredentialId,
  DEFAULT_IDLE_TIMEOUT_S,
  endpointsStale,
  modelPrice,
  pinnedRoute,
  type ModelEndpoints,
  type EffectiveModel,
  Model,
  type ModelId,
  type ModelUpstream,
  type PriceFeedState,
  type ProviderKind,
  ProviderInfo,
  ProviderKindInfo,
  type ProviderSettings,
  type ProxyMode,
  originOf,
  resolveModel
} from "@dreamspan/shared/providers.ts"
import {
  findProvider,
  type ProviderDefinition,
  providerBaseUrl,
  providerChanges,
  resolveProviderSettings
} from "@dreamspan/shared/providerDefinitions.ts"
import type { Cost, LlmRequestId, RequestPurpose, RequestRoute, TokenCounts } from "@dreamspan/shared/usage.ts"
import { createHash, timingSafeEqual } from "node:crypto"
import { ServerError, StaleWrite } from "@dreamspan/shared/errors.ts"
import { Cause, Context, Effect, Exit, Layer, Option, Queue, Semaphore, Stream } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { Network, type ProxyOverride, type RequestNetwork, RedirectRefused } from "../net/Network.ts"
import { describeRoute, proxyUrlProblem, requestRoute, type Route } from "../net/route.ts"
import { Secrets } from "../secrets.ts"
import { catalogEntry, withCatalog } from "./catalog.ts"
import { withCatalogs } from "./contextCatalog.ts"
import type { ListedModel } from "./modelLists.ts"
import { hasRetryShim, applyShims, providerRules, withShims } from "./shims.ts"
import { statedContextLimit } from "./contextLimits.ts"
import {
  classify,
  parseRetryAfter,
  ProviderError,
  type ProviderErrorReason,
  providerError,
  RETRYABLE
} from "./errors.ts"
import { TEST_MODEL_KEYS } from "@dreamspan/shared/providerApi.ts"
import { ConnectionForRequest } from "../db/ops.ts"
import { fetchEndpoints, ModelListError } from "./modelLists.ts"
import { type ProviderKindEntry, ProviderRegistry, type RequestTarget, type StableEndpoint } from "./registry.ts"
import {
  bindThinking,
  carriesHistoryReplay,
  carriesSigned,
  DROP_NOTES,
  HISTORY_DROP_NOTES,
  type RecordedAssistant,
  PROVIDER_RUN_DROP_NOTE,
  providerDropNote,
  providerDroppedThinking,
  refusesSigned,
  replayTerms,
  signsReasoning,
  stampHistoryReplay,
  type ThinkingBinding,
  thinkingRecord
} from "./thinkingBinding.ts"
import { TokenCountError, type TextCountRequest } from "./textCounters.ts"
import { countingModelKey } from "./countingModel.ts"
import { parseServiceAccount } from "./vertex.ts"
import {
  type Capture,
  captureUsageHeaders,
  costOf,
  emptyCapture,
  finalCounts,
  reasoningPlan,
  resolveReasoning
} from "./usage.ts"
import { firstPrice, priceSources } from "./priceSources.ts"
import { feedsFor, fetchPriceList, nextPriceFetch, PRICE_RETRY_MS } from "./priceEndpoint.ts"

/** A request's model prices by source, now, for its connection's kind and region (PRICES §5.1). */
const sourcesOf = (
  connection: { readonly kind: ProviderKindEntry; readonly settings: ProviderSettings },
  model: Model
) =>
  priceSources(
    {
      provider: connection.kind.piProvider,
      region: connection.settings.region,
      priceEndpoint: connection.settings.priceEndpoint
    },
    model,
    Date.now()
  )
import { readDecisionUsage, unwrapEnvelope } from "@dreamspan/shared/decisions.ts"

export { ProviderError } from "./errors.ts"

/** The last answer of a connection's price endpoint, for the connection as it was then (`key`). */
interface PriceProbeRecord extends PriceFeedState {
  readonly key: string
  /** The stored models the last full answer covered (named or absent), so a 304 is only asked for when it speaks for all. */
  readonly covered?: ReadonlySet<string>
}

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
    readonly outputBudget?: { remaining: number }
    /**
     * The chat sends earlier replies' reasoning back (assembler/reasoningReplay.ts): on a model
     * that binds it to its prefix, no mid-conversation effort messages, which a later request
     * couldn't repeat as they were; the effort goes as the request's own setting.
     */
    readonly replayReasoning?: boolean
    readonly temperature?: number
    readonly sampling?: Readonly<Record<string, unknown>>
    readonly sessionId?: string
    readonly cacheRetention?: "none" | "short" | "long"
    /**
     * Explicit cache breakpoints (PROVIDERS §8): indices into `context.messages`, most
     * important first. Applied for Anthropic Messages; pi-ai's own markers stay.
     */
    readonly breakpoints?: ReadonlyArray<number>
    readonly preserveBreakpoints?: boolean
    /** The automatic layout's reusable endpoint, for transforms that place markers there. */
    readonly stable?: StableEndpoint
    /** An agent run's deferred tools and their load points, for the tool loading transforms. */
    readonly toolLoading?: import("./toolLoading.ts").ToolLoadingRequest
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
      readonly notice?: string
    }
  | {
      readonly type: "done"
      readonly requestId: LlmRequestId
      readonly message: AssistantMessage
      readonly toolArguments: Readonly<Record<string, string>>
      readonly counts: TokenCounts
      readonly outputReported?: boolean
      readonly cost: Cost | null
    }

interface DecideRequest {
  readonly userId: UserId
  readonly connectionId: ConnectionId
  readonly modelId: ModelId
  readonly state: unknown
  readonly questions: Readonly<Record<string, import("@dreamspan/shared/decisions.ts").DecisionQuestion>>
  readonly attribution: {
    readonly chatId: ChatId | null
    readonly rolloutId: string | null
    readonly versionId?: VersionId | null
  }
}

interface DecideResult {
  readonly requestId: LlmRequestId
  /** The response's `answers`, unparsed: the caller checks them against its questions. */
  readonly answers: unknown
  /** The dated model id the provider served, when it says. */
  readonly servedModel: string | null
  readonly counts: TokenCounts
  readonly cost: Cost | null
}

/** The one short message a check sends, and what came back. */
export interface TestReply {
  readonly model: string
  readonly ok: boolean
  readonly text: string
  readonly ms: number
  readonly route: string | null
  readonly reason: ProviderErrorReason | null
  readonly status: number | null
  readonly detail: string | null
}

export interface TestResult {
  readonly ok: boolean
  readonly detail: string
  readonly route: string | null
  readonly models: number | null
  readonly reason: ProviderErrorReason | null
  readonly status: number | null
  readonly modelKeys: ReadonlyArray<string>
  readonly ms: number | null
  readonly catalog: boolean
  readonly reply: TestReply | null
}

/** A check's message: one word, answered in a few tokens. */
const TEST_PROMPT = "Hi"
const TEST_MAX_TOKENS = 16
const TEST_TIMEOUT_MS = 60_000
const TEST_REPLY_CHARS = 300

/** Everything a request on a connection needs, secrets decrypted. Lives for one request. */
interface Prepared {
  readonly connection: Connection
  /** The connection's provider (providerDefinitions.ts) and its settings in effect. */
  readonly provider: string
  readonly settings: ProviderSettings
  /** Whose documented cache contract applies (cachePolicy.ts); null where none is known. */
  readonly cacheContract: string | null
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

/** What the SDK is given as the key when the kind's transport authorizes the request (it drops it). */
const TRANSPORT_AUTH = "authorized-by-transport"

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

/**
 * The shortest credential scrubbed: a value that is a credential by where it came from (a key,
 * a credential header, a proxy's password) always is, short or a plain word, but a 1–3 letter
 * fragment would blank pieces of ordinary words.
 */
const MIN_CREDENTIAL_LENGTH = 4
/** The shortest value scrubbed that isn't a credential by where it came from (a path segment). */
const MIN_INCIDENTAL_LENGTH = 12

/** A host name (`api.acme.example`): addresses are shown, never secrets. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\.?$/i
/** Words, alone or joined by `-`, `_`, `.` or spaces (`openai-compatible`), as public route names are. */
const WORDS = /^[a-z]+(?:[-_ .][a-z]+)*$/i
/** A word as written: lower case, capitalized or all capitals, under 20 letters. */
const PLAIN_WORD = /^(?:[A-Z]?[a-z]{1,18}|[A-Z]{1,19})$/
/**
 * Plain words: a letters-only run of 20 or more, or one with capitals inside it
 * (`AbCdEfGhIjKlMnOpQrStUvWx`), is a generated key, not a word.
 */
const plainWords = (value: string) => WORDS.test(value) && value.split(/[-_ .]/).every((word) => PLAIN_WORD.test(word))

/** Whether a credential (by where it came from) is long enough to scrub. */
const credentialLike = (value: string) => value.trim().length >= MIN_CREDENTIAL_LENGTH

/**
 * Whether a value that isn't a credential by where it came from (an address's path segment, a
 * query value not named like a credential, a variable not named like one) may still be one: at
 * least 12 characters, not a host name and not plain words, so scrubbing it can't blank a
 * provider's own link or an ordinary word in its message.
 */
export const incidentalSecret = (value: string) => {
  const trimmed = value.trim()
  return trimmed.length >= MIN_INCIDENTAL_LENGTH && !HOSTNAME.test(trimmed) && !plainWords(trimmed)
}

/** A name's parts, split at `_`, `-`, `.` and camelCase (`maxTokens`, `X-Api-Key`), lower case. */
const nameParts = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter(Boolean)
/** A name part that names a credential: `key`, `apikey`, `access_token`'s `token`, `passwd`. */
const CREDENTIAL_PART =
  /^(?:[a-z]*(?:key|token|secret|password|passwd|passphrase|cookie|signature|credentials?)|auth[a-z]*|pass|sig)$/
/**
 * A first or last part that makes the name a setting about credentials, not one
 * (`max_tokens`, `AUTH_MODE`, `token_url`, `key_count`).
 */
const SETTING_PART = new Set([
  "max",
  "min",
  "num",
  "mode",
  "type",
  "scheme",
  "method",
  "enabled",
  "disabled",
  "required",
  "url",
  "uri",
  "endpoint",
  "host",
  "header",
  "version",
  "count",
  "limit",
  "length",
  "size",
  "timeout",
  "ttl",
  "provider",
  "parallelism"
])
/** Names that look like credentials but are a model's or a tool's parameters (`tokenizer`, `keyboard`). */
const NOT_CREDENTIAL_NAMES = new Set(["tokenizer", "tokenizers", "keyboard", "keyboards", "monkey"])

/** Whether a name is a setting's (`X-Auth-Mode`, `max_tokens`, `X-Timeout`) by its first or last part. */
const settingName = (name: string) => {
  const parts = nameParts(name)
  return parts.length > 0 && (SETTING_PART.has(parts[0]!) || SETTING_PART.has(parts[parts.length - 1]!))
}

/** Whether a name (of a header, query parameter or variable) is one that carries a credential. */
const credentialName = (name: string) => {
  const parts = nameParts(name)
  if (parts.length === 0 || settingName(name)) return false
  return parts.some((part) => !NOT_CREDENTIAL_NAMES.has(part) && CREDENTIAL_PART.test(part))
}

/** A switch (`true`, `off`): never a credential, whatever its name says. */
const SWITCH_VALUE = /^(?:true|false|yes|no|on|off|null|none|enabled|disabled)$/i
/**
 * A switch or a small count (`4096`): a custom header's value or a variable not named like a
 * credential that is one of these is a setting. Under a credential's name a number may be a PIN.
 */
const SETTING_VALUE = /^(?:true|false|yes|no|on|off|null|none|enabled|disabled|\d{1,11})$/i

/**
 * Headers that are public by definition (an app's name and link, the client, what it accepts),
 * shown as they are.
 */
const PUBLIC_HEADERS = new Set([
  "user-agent",
  "referer",
  "http-referer",
  "x-title",
  "accept",
  "accept-language",
  "accept-encoding",
  "content-type",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta"
])

/** A scrubber for the given credentials: every occurrence of each (4+ characters) becomes "[redacted]". */
export const makeScrub = (secrets: ReadonlyArray<string | null | undefined>) => {
  const values = [...new Set(secrets.filter((v): v is string => typeof v === "string" && credentialLike(v)))].sort(
    (a, b) => b.length - a.length
  )
  const pattern = values.length
    ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : null
  return (text: string) => (pattern ? text.replace(pattern, "[redacted]") : text)
}

/**
 * One request-local inventory, populated as secrets resolve, before any payload is captured.
 * Credentials by origin are kept from 4 characters; anything else only if `incidentalSecret`.
 */
export const requestSecrets = () => {
  const values = new Set<string>()
  let cached: ((text: string) => string) | undefined
  const keep = (value: string, credential = true) => {
    if (!(credential ? credentialLike(value) : incidentalSecret(value))) return
    cached = undefined
    values.add(value)
  }
  /** A URL's credentials, which may be echoed independently, percent encoded, or as Basic auth. */
  const userinfo = (url: URL) => {
    const username = decodeURIComponent(url.username)
    const password = decodeURIComponent(url.password)
    // A username is often a plain word (`user`): alone it is kept only if it could be a secret,
    // but where it stands as a credential (`//user:`, `//user@`, `user:password`) it always is.
    for (const part of [url.username, username]) {
      if (!part) continue
      keep(part, false)
      keep(`//${part}:`)
      keep(`//${part}@`)
    }
    for (const part of [url.password, password]) if (part) keep(part)
    if (username && password) {
      keep(`${username}:${password}`)
      keep(`${url.username}:${url.password}`)
    }
    if (username || password) keep(Buffer.from(`${username}:${password}`).toString("base64"))
  }
  /** A credential: a key, a token, a proxy URL (with its credentials), a decrypted secret. */
  const add = (value: string) => {
    if (value) keep(value)
    try {
      const url = new URL(value)
      keep(url.href)
      userinfo(url)
    } catch {
      /* Most secrets aren't URLs. */
    }
    return value
  }
  /** A value named like a credential is one, unless it's a switch. */
  const named = (name: string, value: string) => {
    if (credentialName(name) && !SWITCH_VALUE.test(value.trim())) add(value)
    else keep(value, false)
  }
  /**
   * A connection's configured headers. Their values are credentials whatever the name
   * (`X-Session: s3ss`), and a `Bearer`/`Basic` credential's parts too. Public headers
   * (`User-Agent`, `Referer`, `X-Title`), switches and counts (`X-Retries: 3`) are shown; a
   * setting's value (`X-Auth-Mode: basic`) only goes if it could be a secret, and a link in a
   * header not named like a credential is judged as an address.
   */
  const headers = (headers: Readonly<Record<string, string | undefined>> | undefined) => {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (typeof value !== "string") continue
      const auth = /^(Bearer|Basic)\s+(.+)$/i.exec(value.trim())
      if (!auth) {
        if (PUBLIC_HEADERS.has(name.toLowerCase())) continue
        if (credentialName(name)) named(name, value)
        else if (/^https?:\/\//i.test(value.trim()) && URL.canParse(value.trim())) route(value.trim())
        else if (!SETTING_VALUE.test(value.trim())) keep(value, !settingName(name))
        continue
      }
      keep(value)
      add(auth[2]!)
      if (auth[1]!.toLowerCase() === "basic") {
        const decoded = Buffer.from(auth[2]!, "base64").toString("utf8")
        keep(decoded)
        const colon = decoded.indexOf(":")
        if (colon >= 0) {
          keep(decoded.slice(0, colon), false)
          keep(decoded.slice(colon + 1))
        }
      }
    }
  }
  /** A program's variables: one named like a credential is one; any other only if it looks like one. */
  const variables = (env: Readonly<Record<string, string>>) => {
    for (const [name, value] of Object.entries(env)) named(name, value)
  }
  /**
   * An address. Its host and plain route names (`v1`, `openai-compatible`) are shown, but a
   * gateway may carry a key in its path or query, so every other long segment and value is
   * protected, and a query value named like a credential (`access_token=…`) always is.
   */
  const route = (value: string) => {
    const url = new URL(value)
    userinfo(url)
    const queryCredential = (name: string, value: string) => {
      let decoded = name
      try {
        decoded = decodeURIComponent(name)
      } catch {
        /* Judged as written. */
      }
      return credentialName(decoded) && !SWITCH_VALUE.test(value.trim())
    }
    const both = (part: string, credential: boolean) => {
      keep(part, credential)
      try {
        keep(decodeURIComponent(part), credential)
      } catch {
        /* Malformed encodings remain covered verbatim. */
      }
    }
    for (const part of url.pathname.split("/")) if (part) both(part, false)
    for (const pair of url.search.slice(1).split("&")) {
      const equals = pair.indexOf("=")
      if (equals < 0) both(pair, false)
      else both(pair.slice(equals + 1), queryCredential(pair.slice(0, equals), pair.slice(equals + 1)))
    }
    for (const [name, part] of url.searchParams) keep(part, queryCredential(name, part))
  }
  return { add, headers, variables, route, scrub: (text: string) => (cached ??= makeScrub([...values]))(text) }
}

const binding = (connectionId: string, field: "headers" | "proxy_url") => `connection:${connectionId}:${field}`
export const credentialBinding = (credentialId: string) => `credential:${credentialId}:key`

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
  /** How long an endpoint-list fetch may take before it counts as failed (default 10 s). */
  readonly endpointsTimeoutMs?: number
  /**
   * How often the price timer looks for opted-in connections whose prices are due (PRICES §4.6;
   * default a minute). Zero turns the timer off.
   */
  readonly priceTimerMs?: number
  /** The clock the price timer and probe state read (tests move it). */
  readonly now?: () => number
}

export interface ProvidersShape {
  /**
   * A new connection, using an existing credential or a key typed for it. A typed key
   * becomes a credential named after the connection, bound to its origin.
   */
  readonly createConnection: (input: {
    readonly userId: UserId
    /** The provider chosen; left out, the kind's default provider. */
    readonly provider?: string | undefined
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
   * Fetches OpenRouter's endpoint list for a model (a price per provider) and stores it with the
   * model; a failed fetch is stored too, as the reason, so the model page can say why the
   * model's general price applies. Other kinds' models are returned unchanged.
   */
  readonly refreshEndpoints: (userId: UserId, modelId: ModelId) => Effect.Effect<Model, ProviderError | ServerError>
  /** What the connection's price endpoint answered last (PRICES §4.5); null when not asked since start. */
  readonly priceFeedState: (
    userId: UserId,
    connectionId: ConnectionId
  ) => Effect.Effect<PriceFeedState | null, ProviderError | ServerError>
  /**
   * One round of the price timer (PRICES §4.6): asks every opted-in connection used in the last
   * day whose prices are due. The layer runs it every `priceTimerMs`; tests call it.
   */
  readonly priceTimerRound: Effect.Effect<void>
  /**
   * The model with a fresh endpoint list when its routing pins one provider and the stored list
   * is missing or stale; never fails (a failed fetch is stored, and the model comes back as it was).
   */
  readonly ensureEndpoints: (userId: UserId, model: Model) => Effect.Effect<Model>
  /**
   * What the registered catalogs know of a model id on this connection (its window, its output
   * limit), for a model the user adds by id; empty when nothing matches or the connection is gone.
   */
  readonly catalogUpstream: (userId: UserId, connectionId: ConnectionId, key: string) => Effect.Effect<ModelUpstream>
  /**
   * Checks a connection by fetching its model list, and, given a model, by sending it one short
   * message through the real request path (recorded as a "test" request). Reports the routes.
   */
  readonly testConnection: (
    userId: UserId,
    connectionId: ConnectionId,
    modelId?: ModelId | null
  ) => Effect.Effect<TestResult, ProviderError | ServerError>
  /**
   * The same check for a connection not yet created, as `createConnection` would make it: a
   * typed key or a saved one, no headers, the inherited route. Nothing is stored.
   */
  readonly testDraft: (input: {
    readonly userId: UserId
    readonly role: "admin" | "user"
    readonly provider?: string | undefined
    readonly kind: ProviderKind
    readonly settings: ConnectionSettings
    readonly apiKey?: string | null | undefined
    readonly credentialId?: CredentialId | null | undefined
    readonly model?: string | null | undefined
  }) => Effect.Effect<TestResult, ProviderError | ServerError>
  readonly stream: (request: StreamRequest) => Stream.Stream<ProviderEvent, ProviderError | ServerError>
  /**
   * One decision request (spec/AGENTIC.md §7) on a connection whose kind answers decisions:
   * sent once, with the connection's key, headers and route, and recorded in the ledger whether
   * or not its answers parse (every billed attempt counts, as in reference-harness). Never retried.
   */
  readonly decide: (request: DecideRequest) => Effect.Effect<DecideResult, ProviderError | ServerError>
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
  /** The providers a new connection starts from, with an API type in effect, in picker order. */
  readonly providers: () => ReadonlyArray<ProviderInfo>
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
const buildPiModel = async (
  prepared: Prepared,
  model: Model,
  effective: EffectiveModel,
  bindings: ReadonlyArray<ThinkingBinding>,
  hasEffort: boolean
): Promise<PiModel<Api>> => {
  const found = await catalogEntry(prepared.kind, model.key)
  const base = found?.sameApi ? found.entry : null
  prepared.registerHeaders(base?.headers)
  const price = effective.price
  // A Claude model's thinking form (claudeThinking.ts), under what the model's settings and the
  // catalog say: an unlisted adaptive-only model must not be sent budgets or `disabled`.
  const family =
    base && model.upstream?.compat
      ? null
      : bindings
          .find((binding) => binding.appliesTo({ kind: prepared.kind.id, api: prepared.api, model: model.key }))
          ?.modelDefaults?.(model.key)
  const levels = { ...family?.thinkingLevelMap, ...effective.thinkingLevels.value }
  return {
    ...base,
    id: model.key,
    name: effective.name.value,
    api: prepared.api,
    provider: prepared.kind.piProvider,
    baseUrl: prepared.baseUrl,
    // Some serializers explicitly disable thinking on Auto if the model is flagged as reasoning.
    reasoning: effective.reasoning.value && (effective.reasoning.source !== "unknown" || hasEffort),
    ...(Object.keys(levels).length > 0 ? { thinkingLevelMap: levels } : {}),
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
    compat: { ...family?.compat, ...effective.compat } as never,
    ...(Object.keys(effective.sampling).length > 0 ? { samplingParams: { ...effective.sampling } as never } : {})
  } as PiModel<Api>
}

export const layer = (options: ProvidersOptions = {}) =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      const formats = yield* Effect.serviceOption(Formats)
      const reader = yield* Reader
      const writer = yield* Writer
      const autoChanged = () =>
        providerError("unusable", "Not sent: auto replies ended because the chat, settings or server changed.")
      const authorizeAuto = (userId: UserId, token: string | null) =>
        Effect.gen(function* () {
          if (token === null) return null
          const configuration = autoConfigurationStamp()
          yield* writer.AuthorizeAutoRequest({ userId, token, configuration }).pipe(Effect.mapError(autoChanged))
          if (configuration !== autoConfigurationStamp()) return yield* autoChanged()
          return configuration
        })
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

      /** A connection's provider: the one it names, or its kind's default (providerDefinitions.ts). */
      const providerOf = (connection: Pick<Connection, "provider" | "kind" | "baseUrl">) =>
        findProvider(registry.providers.list(), connection.provider, connection.kind, connection.baseUrl)
      /**
       * The address a connection without its own uses: the provider's (its region's, where one is
       * set), else the kind's; null when none.
       */
      const defaultBaseUrl = (
        provider: ProviderDefinition | undefined,
        kind: ProviderKindEntry,
        settings: ProviderSettings | undefined
      ) => (provider ? providerBaseUrl(provider, settings ?? {}) : kind.defaultBaseUrl)

      const prepare = (userId: UserId, connectionId: ConnectionId) =>
        fromStorage(reader.ResolveConnection({ userId, connectionId })).pipe(
          Effect.flatMap((resolved) => prepareResolved(resolved, null))
        )

      /**
       * A connection with its stored secrets, ready for a request. `typed` is a key typed for a
       * connection not yet created (a check of the new-connection form): used as it is, never stored.
       */
      const prepareResolved = (resolved: ConnectionForRequest, typed: string | null) =>
        Effect.gen(function* () {
          const connection = resolved.connection
          const connectionId = connection.id
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
          const provider = providerOf(connection)
          const baseUrl = connection.baseUrl ?? defaultBaseUrl(provider, info, connection.providerSettings)
          if (baseUrl === null) {
            return yield* providerError("unusable", `${connection.name} has no address; enter the server's base URL`)
          }
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
            typed !== null
              ? inventory.add(typed)
              : credential === null
                ? null
                : yield* decryptWith(credential.keyEnc, credentialBinding(credential.id))
          if (apiKey !== null) for (const part of info.secretsOf?.(apiKey) ?? []) inventory.add(part)
          // Keyless where the API type or the provider allows it: a custom server's Responses API,
          // say, or a kind a plugin registered for a keyless server.
          if (apiKey === null && !(provider?.keyOptional || info.keyOptional)) {
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
            provider: provider?.id ?? connection.provider,
            settings: resolveProviderSettings(provider, connection.providerSettings),
            cacheContract: provider ? provider.cacheContract : info.piProvider,
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
      const fetchFor = (prepared: Prepared, onRoute: (description: string, route: Route) => void) =>
        prepared.transport.fetchFor((route, target) => onRoute(describeRoute(route, target), route))

      // --- Connection operations that need the secret ------------------------------

      /** A key as entered: surrounding whitespace dropped, and nothing left means no key. */
      const typedKey = (apiKey: string | null | undefined) => {
        const trimmed = apiKey?.trim() ?? ""
        return trimmed === "" ? null : trimmed
      }

      /**
       * Short keys get no hint: four characters would be most of the key. A service account's
       * key file ends in the same characters as every other, so its hint is its key ID's end.
       */
      const encryptKey = (key: string, credentialId: CredentialId) => {
        const account = parseServiceAccount(key)
        return {
          enc: secrets.encrypt(key, credentialBinding(credentialId)),
          hint: account ? (account.privateKeyId?.slice(-4) ?? "") : key.length >= 12 ? key.slice(-4) : ""
        }
      }

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

      const createConnection: ProvidersShape["createConnection"] = ({
        userId,
        provider: providerId,
        kind,
        settings,
        apiKey,
        credentialId
      }) =>
        Effect.gen(function* () {
          const entry = registry.kinds.get(kind)
          if (!entry) return yield* providerError("bad_request", `unknown provider kind "${kind}"`)
          const named = providerId === undefined ? undefined : registry.providers.get(providerId)
          if (providerId !== undefined && !named)
            return yield* providerError("bad_request", `unknown provider "${providerId}"`)
          const provider = named ?? findProvider(registry.providers.list(), null, kind, settings.baseUrl)
          if (named && !named.apis.some((api) => api.id === kind)) {
            return yield* providerError("bad_request", `${named.label} doesn't offer the API type "${kind}"`)
          }
          const baseUrl = settings.baseUrl ?? defaultBaseUrl(provider, entry, settings.providerSettings)
          if (baseUrl === null) return yield* providerError("bad_request", "enter the server's base URL")
          const key = typedKey(apiKey)
          const credential =
            key === null
              ? { existing: credentialId ?? null }
              : { typed: yield* typedCredential(settings.name, key, baseUrl) }
          return yield* fromStorage(
            writer.CreateConnection({
              userId,
              connectionId: uuidv7() as ConnectionId,
              ...(provider ? { provider: provider.id } : {}),
              kind,
              api: entry.api,
              // Only what differs from the provider's defaults is stored.
              settings: {
                ...settings,
                ...(settings.providerSettings
                  ? { providerSettings: providerChanges(provider, settings.providerSettings) }
                  : {})
              },
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
          const baseUrl =
            connection.baseUrl ?? defaultBaseUrl(providerOf(connection), entry, connection.providerSettings)
          if (baseUrl === null) return yield* providerError("unusable", `${connection.name} has no address`)
          return { connection, baseUrl }
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

      /**
       * What the catalogs know of listed (or added) models (liveapi F1, F2): the kind's own
       * catalog (price, reasoning, vision, thinking levels), then the registered ones for a
       * window; then the compatibility shims.
       */
      const describeModels = (kind: ProviderKindEntry, provider: string, listed: ReadonlyArray<ListedModel>) =>
        Effect.gen(function* () {
          const fromKind = yield* withCatalog(kind, listed)
          const filled = yield* withCatalogs(registry.catalogs.list(), kind.id, fromKind)
          const shims = registry.shims.list()
          const on = { provider, api: kind.api }
          return filled.map((model, i) => withShims(shims, on, { key: listed[i]!.key, upstream: model.upstream }))
        })

      const refreshModels: ProvidersShape["refreshModels"] = (userId, connectionId) =>
        Effect.gen(function* () {
          const prepared = yield* prepare(userId, connectionId)
          let route: string | null = null
          const listed = yield* listModels(prepared, (d) => (route = d))
          const models = yield* describeModels(prepared.kind, prepared.provider, listed)
          const result = yield* fromStorage(
            writer.SyncFetchedModels({ userId, connectionId, models, fetchedAt: Date.now() })
          )
          yield* refreshPriceFeeds(userId, prepared, true)
          return { ...result, route }
        })

      /**
       * The connection's own price list (PRICES §4), asked only when its user turned on
       * `priceEndpoint`, with the same credentials as its model list. A failure keeps the last
       * good prices; it never fails the refresh. `manual` is Refresh models: it asks whatever the
       * last answer was. The timer (`manual` false) asks only when the last answer is due again
       * and never a server that said it doesn't publish prices, until the connection changes.
       */
      const probes = new Map<ConnectionId, PriceProbeRecord>()
      const now = options.now ?? Date.now
      const probeKey = (prepared: Prepared) =>
        createHash("sha256")
          .update(
            JSON.stringify([
              prepared.connection.rowVersion,
              prepared.baseUrl,
              prepared.apiKey,
              prepared.headers,
              prepared.connection.proxyMode
            ])
          )
          .digest("hex")
      const refreshPriceFeeds = (userId: UserId, prepared: Prepared, manual: boolean) =>
        Effect.gen(function* () {
          const connectionId = prepared.connection.id
          if (prepared.settings.priceEndpoint !== true) {
            probes.delete(connectionId)
            return
          }
          const key = probeKey(prepared)
          const before = probes.get(connectionId)
          const last = before?.key === key ? before : undefined
          if (!manual && last && (last.nextAt === null || now() < last.nextAt)) return
          const stored = yield* fromStorage(reader.ListModels({ userId, connectionId, includeHidden: true }))
          // A 304 says only that the answer is unchanged, so it is asked for only when that answer
          // already covered every stored model (a model added by Refresh models needs a full one).
          const covered = last?.covered
          const allCovered = stored.every((m) => m.upstream.priceFeed !== undefined || covered?.has(m.key) === true)
          const etag = allCovered
            ? (stored.find((m) => m.upstream.priceFeed?.etag !== undefined)?.upstream.priceFeed?.etag ?? null)
            : null
          const auth: Record<string, string> =
            prepared.apiKey === null
              ? {}
              : prepared.api === "anthropic-messages"
                ? { "x-api-key": prepared.apiKey, "anthropic-version": "2023-06-01" }
                : { authorization: `Bearer ${prepared.apiKey}` }
          const probe = yield* Effect.tryPromise((signal) =>
            fetchPriceList(
              fetchFor(prepared, () => {}),
              prepared.baseUrl,
              { ...auth, ...prepared.headers },
              // A 304 only says the stored feeds are current, so ask conditionally only with feeds.
              last?.state === "supported" || before === undefined ? etag : null,
              signal
            )
          ).pipe(
            Effect.timeoutOrElse({ duration: endpointsTimeoutMs, orElse: () => Effect.succeed(null) }),
            Effect.orElseSucceed(() => null)
          )
          const at = now()
          const record = (
            state: PriceProbeRecord["state"],
            nextAt: number | null,
            detail: string | null,
            coveredNow: ReadonlySet<string> | undefined = covered
          ) =>
            probes.set(connectionId, { key, state, at, nextAt, detail, ...(coveredNow ? { covered: coveredNow } : {}) })
          if (probe === null || probe.state === "failed") {
            const detail = probe === null ? "No answer in time." : prepared.scrub(probe.detail)
            yield* Effect.logInfo(`price list of ${connectionId}: ${detail}`)
            record("failed", at + PRICE_RETRY_MS, detail)
            return
          }
          if (probe.state === "unsupported" || probe.state === "denied") {
            yield* Effect.logInfo(`price list of ${connectionId}: ${prepared.scrub(probe.detail)}`)
            // Unsupported: asked again only when the connection changes or models are refreshed.
            record(
              probe.state,
              probe.state === "unsupported" ? null : nextPriceFetch(at, null),
              prepared.scrub(probe.detail)
            )
            return
          }
          const fresh = probe.state === "supported" ? probe : null
          const maxAge = probe.state === "supported" || probe.state === "unchanged" ? probe.maxAgeMs : null
          const feeds =
            fresh === null
              ? // A 304 only moves `fetchedAt` (and the time it's good until, from `max-age`).
                stored.flatMap((m) => {
                  const feed = m.upstream.priceFeed
                  if (!feed) return []
                  const validUntil = maxAge === null ? feed.validUntil : at + maxAge
                  return [
                    {
                      key: m.key,
                      feed: {
                        ...feed,
                        fetchedAt: at,
                        ...(validUntil === undefined ? {} : { validUntil })
                      }
                    }
                  ]
                })
              : feedsFor(
                  stored.map((m) => m.key),
                  fresh,
                  at
                )
          const validUntil =
            fresh === null
              ? (feeds[0]?.feed?.validUntil ?? null)
              : (fresh.list.validUntil ?? (fresh.maxAgeMs === null ? null : at + fresh.maxAgeMs))
          const coveredNow = fresh === null ? covered : new Set(stored.map((m) => m.key))
          const stored_ = yield* fromStorage(writer.SetModelPriceFeeds({ userId, connectionId, feeds })).pipe(
            Effect.as(true),
            Effect.catch((e) => Effect.as(Effect.logWarning("could not store a price list", e), false))
          )
          // A failed store is asked about again at the failure interval, not an hour later.
          if (stored_) record("supported", nextPriceFetch(at, validUntil), null, coveredNow)
          else record("failed", at + PRICE_RETRY_MS, "Could not store the price list.", covered)
        })

      const priceFeedState: ProvidersShape["priceFeedState"] = (userId, connectionId) =>
        Effect.gen(function* () {
          const prepared = yield* prepare(userId, connectionId)
          if (prepared.settings.priceEndpoint !== true) return null
          const record = probes.get(connectionId)
          if (!record || record.key !== probeKey(prepared)) return null
          return { state: record.state, at: record.at, nextAt: record.nextAt, detail: record.detail }
        })

      const DAY_MS = 24 * 60 * 60 * 1000
      const priceTimerRound: ProvidersShape["priceTimerRound"] = Effect.gen(function* () {
        const due = yield* reader.ListPriceFeedConnections({ usedSince: now() - DAY_MS })
        for (const { userId, connectionId } of due) {
          const record = probes.get(connectionId)
          if (record && (record.nextAt === null || now() < record.nextAt)) continue
          yield* prepare(userId, connectionId).pipe(
            Effect.flatMap((prepared) => refreshPriceFeeds(userId, prepared, false)),
            Effect.catch((error) => {
              // No credentials to ask with: back off like any failure, and say so once per backoff.
              const at = now()
              probes.set(connectionId, {
                key: "prepare-failed",
                state: "failed",
                at,
                nextAt: at + PRICE_RETRY_MS,
                detail: "The connection could not be prepared."
              })
              return Effect.logInfo(`price timer skipped ${connectionId}`, error)
            })
          )
        }
      }).pipe(Effect.catch((error) => Effect.logWarning("price timer", error)))
      const priceTimerMs = options.priceTimerMs ?? 60_000
      if (priceTimerMs > 0)
        yield* Effect.forkIn(
          Effect.forever(Effect.sleep(priceTimerMs).pipe(Effect.andThen(priceTimerRound))),
          yield* Effect.scope
        )

      const endpointsTimeoutMs = options.endpointsTimeoutMs ?? 10_000
      const refreshEndpoints: ProvidersShape["refreshEndpoints"] = (userId, modelId) =>
        Effect.gen(function* () {
          const model = yield* fromStorage(reader.GetModel({ userId, modelId }))
          const prepared = yield* prepare(userId, model.connectionId)
          if (prepared.kind.id !== "openrouter") return model
          const stored = (endpoints: ModelEndpoints) =>
            fromStorage(writer.SetModelEndpoints({ userId, modelId, endpoints }))
          return yield* fetchEndpoints(
            {
              baseUrl: prepared.baseUrl,
              apiKey: prepared.apiKey,
              headers: prepared.headers,
              fetch: fetchFor(prepared, () => {}),
              scrub: prepared.scrub
            },
            model.key
          ).pipe(
            // A hung fetch is a failure like any other: stored, so it's retried later, not on every reply.
            Effect.timeoutOrElse({
              duration: endpointsTimeoutMs,
              orElse: () =>
                Effect.fail(
                  new ModelListError({
                    reason: "network",
                    status: null,
                    message: `no answer in ${endpointsTimeoutMs / 1000} s`
                  })
                )
            }),
            Effect.flatMap((list) => stored({ fetchedAt: Date.now(), list })),
            Effect.catchTag("ModelListError", (error) =>
              stored({
                fetchedAt: Date.now(),
                error: prepared.scrub(`${error.reason}: ${error.message}`).slice(0, 200),
                // A list fetched before still prices the route better than the model's headline price.
                list: model.upstream.endpoints?.list ?? []
              })
            )
          )
        })

      /** Models whose endpoint list is being fetched, so concurrent replies (a backfill) ask once. */
      const endpointsInFlight = new Set<ModelId>()
      const ensureEndpoints: ProvidersShape["ensureEndpoints"] = (userId, model) =>
        // Checked and marked in one step, so two replies starting together ask once.
        Effect.suspend(() => {
          if (
            pinnedRoute({ ...model.upstream.settings, ...model.overrides.settings }.routing) === null ||
            !endpointsStale(model.upstream.endpoints, Date.now()) ||
            endpointsInFlight.has(model.id)
          )
            return Effect.succeed(model)
          endpointsInFlight.add(model.id)
          return refreshEndpoints(userId, model.id).pipe(
            Effect.catch(() => Effect.succeed(model)),
            Effect.ensuring(Effect.sync(() => endpointsInFlight.delete(model.id)))
          )
        })

      const catalogUpstream: ProvidersShape["catalogUpstream"] = (userId, connectionId, key) =>
        reader.GetConnection({ userId, connectionId }).pipe(
          Effect.flatMap((connection) => {
            const kind = registry.kinds.get(connection.kind)
            const provider = providerOf(connection)?.id ?? connection.provider
            return kind
              ? describeModels(kind, provider, [{ key, upstream: {} }])
              : Effect.succeed<ReadonlyArray<ListedModel>>([{ key, upstream: {} }])
          }),
          Effect.map(([model]) => model!.upstream),
          Effect.catch(() => Effect.succeed<ModelUpstream>({}))
        )

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
        | {
            readonly ok: false
            readonly error: ProviderError
            /** Whether the request still sent signed thinking, and whether it left some out (thinkingBinding.ts). */
            readonly signed?: { readonly sent: boolean; readonly dropped: boolean }
          }

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
        incoming: StreamRequest,
        offer: (event: ProviderEvent) => void,
        number: number,
        pricing: import("./userCosts.ts").UserPricing,
        /** The model with the newest endpoint list that has arrived (fetched alongside the reply). */
        latest: { current: Model },
        retryError?: ProviderError,
        /** Signed thinking: checked against what it was written after, all left out, or all sent. */
        bindingMode: "check" | "strip" | "keep" = "check"
      ) => {
        // A plain chat's earlier replies sending their reasoning back are this model's turns
        // (thinkingBinding.ts HISTORY_REPLAY); the binding below decides whether they may go.
        const history = carriesHistoryReplay(incoming.context.messages)
        // What this provider checks of signed blocks sent back (thinkingBinding.ts `replayTerms`):
        // with `prefix`, everything before each and the unbroken run, in tool runs too.
        const terms = replayTerms({
          api: prepared.api,
          key: model.key,
          ...(model.upstream.catalog ? { catalogKey: model.upstream.catalog.match } : {})
        })
        const replay = history ? terms : undefined
        const request: StreamRequest = history
          ? {
              ...incoming,
              context: { ...incoming.context, messages: stampHistoryReplay(incoming.context.messages, piModel) }
            }
          : incoming
        const connectionStamp = createHash("sha256")
          .update(
            JSON.stringify([
              prepared.kind.id,
              prepared.provider,
              prepared.api,
              prepared.baseUrl,
              prepared.apiKey,
              prepared.headers,
              prepared.settings
            ])
          )
          .digest("hex")
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
          /** When the first streamed reasoning, and the first reply text or tool call, came. */
          firstReasoningAt: null as number | null,
          firstReplyAt: null as number | null,
          partial: null as AssistantMessage | null,
          refused: null as string | null,
          /** The idle limit in seconds when the provider sent nothing that long (spec/AGENTIC.md §12.5). */
          silentFor: null as number | null,
          gate: undefined as ReturnType<typeof stagger.join> | undefined,
          release: undefined as "first-chunk" | "complete" | "timeout" | "leader-ended" | undefined,
          /** Sent earlier replies' thinking blocks the provider reports it dropped. */
          providerDropped: 0,
          /** The images the final payload sent, for image token calibration. */
          textPayload: null as ReturnType<typeof payloadText> | null,
          sentImages: null as ReturnType<typeof payloadImages> | null,
          /** The wire's signed-thinking binding, and the payload as it went out (thinkingBinding.ts). */
          binding: undefined as ThinkingBinding | undefined,
          sent: null as Record<string, unknown> | null,
          signed: { sent: false, dropped: false },
          /** The network route the request took, once one was chosen. */
          route: null as RequestRoute | null
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

        /**
         * A turn with signed thinking records what it answered, so a later request sends it
         * back only while nothing before it changed (thinkingBinding.ts). Computed only then.
         */
        const recordThinking = (message: AssistantMessage): RecordedAssistant =>
          state.binding && state.sent && signsReasoning(state.binding, message)
            ? {
                ...message,
                thinkingRecord: thinkingRecord(
                  state.binding,
                  state.sent,
                  {
                    connectionId: prepared.connection.id,
                    modelId: model.id,
                    connectionStamp
                  },
                  state.binding.reply?.(message, piModel)
                )
              }
            : message

        const writeClose = (message: AssistantMessage, error: ProviderError | null, context: PiContext["messages"]) =>
          Effect.gen(function* () {
            const final = finalCounts(message, state.capture, context, request.options?.replyTool)
            const { source } = final
            if (!state.opened) return { counts: final.counts, cost: null }
            const tokenFormats = Option.getOrNull(formats)
            const baseline = state.textPayload
            const localCounter = registry.textCounters
              .list()
              .toReversed()
              .find(
                (counter) =>
                  !counter.remote &&
                  counter.appliesTo({
                    kind: prepared.kind.id,
                    api: prepared.api,
                    model: model.key,
                    baseUrl: prepared.baseUrl
                  })
              )
            const textEstimate =
              baseline && tokenFormats
                ? yield* Effect.gen(function* () {
                    const encode: TextCountRequest["encode"] = (encoding, texts) =>
                      tokenFormats
                        .countTokens(encoding, texts)
                        .pipe(Effect.mapError(() => new TokenCountError({ message: "The local tokenizer failed." })))
                    const counts = yield* localCounter
                      ? localCounter.count({
                          model: model.key,
                          texts: baseline.texts,
                          encode,
                          baseUrl: prepared.baseUrl,
                          apiKey: null,
                          headers: {},
                          fetch: (() => {
                            throw new Error("Calibration cannot contact providers")
                          }) as typeof globalThis.fetch,
                          scrub: (s) => s
                        })
                      : encode("o200k_base", baseline.texts)
                    return {
                      tokens: counts.reduce((n, c) => n + c, baseline.framing),
                      tokenizer: localCounter?.id ?? "approximate"
                    }
                  }).pipe(Effect.orElseSucceed(() => undefined))
                : undefined
            // The reasoning count: the provider's, or counted here from the thinking that came
            // (with the model's tokenizer where one is registered), marked as an estimate.
            const plan = reasoningPlan(message, state.capture, source, request.options?.replyTool)
            const countText = (text: string): Effect.Effect<number> => {
              if (text.length === 0) return Effect.succeed(0)
              if (!tokenFormats) return Effect.succeed(estimateTextTokens(text))
              const encode: TextCountRequest["encode"] = (encoding, texts) =>
                tokenFormats
                  .countTokens(encoding, texts)
                  .pipe(Effect.mapError(() => new TokenCountError({ message: "The local tokenizer failed." })))
              const tokens: Effect.Effect<ReadonlyArray<number>, unknown> = localCounter
                ? localCounter.count({
                    model: model.key,
                    texts: [text],
                    encode,
                    baseUrl: prepared.baseUrl,
                    apiKey: null,
                    headers: {},
                    fetch: (() => {
                      throw new Error("Reasoning counts cannot contact providers")
                    }) as typeof globalThis.fetch,
                    scrub: (s) => s
                  })
                : encode("o200k_base", [text])
              return tokens.pipe(
                Effect.map((counted) => counted.reduce((n, c) => n + c, 0)),
                Effect.orElseSucceed(() => estimateTextTokens(text))
              )
            }
            const counted =
              plan === null || plan.kind === "reported" || plan.kind === "none"
                ? null
                : yield* countText(plan.kind === "thinking" ? plan.text : plan.reply)
            const thought = resolveReasoning(plan, final.counts.output, counted)
            const counts = { ...final.counts, reasoning: thought.reasoning }
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
                  autoToken: yield* AutoRequestGuard,
                  userId: request.userId,
                  connectionId: prepared.connection.id,
                  modelKey: model.key,
                  ...sample
                })
                .pipe(Effect.catch((e) => Effect.logWarning("could not record an image token sample", e)))
            // A pinned route is priced by its own endpoint list: the one fetched alongside the reply
            // if it has arrived, else the stored one. The close never waits for the fetch.
            const sources = sourcesOf(prepared, latest.current)
            const cost = costOf(
              registry.costs.list(),
              { kind: prepared.kind.id, api: prepared.api, model: model.key },
              { counts, pricing, capture: state.capture, price: firstPrice(sources), sources }
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
                  firstReasoningAt: state.firstReasoningAt,
                  firstReplyAt: state.firstReplyAt,
                  reasoningEstimated: thought.estimated,
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
                  ...(textEstimate ? { textEstimate } : {}),
                  usageSource: source,
                  rawUsage: state.capture.rawUsage,
                  ...(request.attribution.purpose === "summarize" || request.attribution.purpose === "condense"
                    ? {
                        summaryResponse: summaryResponse(message, prepared.scrub)
                      }
                    : {}),
                  reportedCost: state.capture.reportedCost,
                  cost,
                  route: state.route,
                  error: error === null ? null : { reason: error.reason, message: error.message, status: error.status }
                }
              })
              .pipe(Effect.catch((e) => Effect.logError(`could not close ledger row ${requestId}`, e)))
            const raw = state.capture.rawUsage
            const outputReported =
              source === "reported" &&
              raw !== null &&
              [
                raw["completion_tokens"],
                raw["output_tokens"],
                raw["candidatesTokenCount"],
                raw["outputTokenCount"]
              ].some((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
            return { counts, cost, outputReported }
          })

        // Admission uses the final transformed wire payload, immediately before dispatch.
        // UTF-8 bytes plus framing bound text tokens conservatively, without assuming cache hits.
        const open = (payload: Readonly<Record<string, unknown>>) =>
          Effect.gen(function* () {
            const hasImages = hasImageBlocks(payload)
            state.textPayload = hasImages ? null : payloadText(payload)
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
            const sources = sourcesOf(prepared, model)
            const price = firstPrice(sources)
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
                  price,
                  sources
                }) !== null
            )
            const bound = formula?.upperBound?.({ inputTokens, outputTokens, pricing, price, sources }) ?? null
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
          const auto =
            attribution.purpose === "generation" || attribution.purpose === "decision" ? yield* AutoRequestGuard : null
          const transcript = yield* Effect.try({
            try: () =>
              normalizeContext(
                limitImages(
                  request.context,
                  resolveModel(
                    model.key,
                    model.upstream,
                    model.overrides,
                    prepared.connection.compat,
                    prepared.settings
                  ).maxImages.value
                )
              ),
            catch: (error) => providerError("bad_request", `the request context is invalid: ${String(error)}`)
          })
          const onRoute = (description: string, route: Route) => {
            // The ledger keeps the route (the proxy by scheme, host and port only).
            state.route = requestRoute(route)
            offer({ type: "route", description })
          }
          if (!prepared.kind.acceptsFetch) {
            const route = yield* prepared.transport.route(new URL(prepared.baseUrl))
            onRoute(describeRoute(route, new URL(prepared.baseUrl)), route)
          }
          // pi-ai reports onResponse only for successful responses (the SDKs throw first on
          // errors), so the status and Retry-After are read here, on every response.
          const routed = fetchFor(prepared, onRoute)

          const message = yield* Effect.tryPromise({
            try: async (signal) => {
              let recordSent: (() => Promise<void>) | undefined
              // The sent context's write, under way beside the request (awaited before it ends).
              let recording: Promise<void> | undefined
              // A request with no byte from the provider for the connection's idle limit fails
              // as "no response" (spec/AGENTIC.md §12.5). The clock runs from when the request
              // is sent, not while it waits its turn for the cache; any byte counts, keep-alive
              // comments included.
              const idleS = prepared.settings.idleTimeoutS ?? DEFAULT_IDLE_TIMEOUT_S
              const idle = new AbortController()
              let heardAt: number | null = prepared.kind.acceptsFetch ? null : Date.now()
              const heard = () => {
                if (heardAt !== null) heardAt = Date.now()
              }
              const watch = setInterval(
                () => {
                  if (heardAt === null || Date.now() - heardAt < idleS * 1000) return
                  state.silentFor = idleS
                  idle.abort()
                },
                Math.min(1000, idleS * 250)
              )
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
                // All live reads and cache waits are over. A later tool round has the same
                // authorization; a changed run cannot send new bytes.
                const configuration = await Effect.runPromise(authorizeAuto(request.userId, auto), { signal }).catch(
                  (error: unknown) => {
                    state.refused = "Not sent: auto replies ended because the chat, settings or server changed."
                    throw error
                  }
                )
                // Queued before any HTTP is sent, so it commits ahead of the rollout's later
                // writes, but not awaited: the request needn't wait on the writer.
                recording = recordSent?.()
                recordSent = undefined
                heardAt = Date.now()
                // SDK-created affinity headers are now available, before any HTTP is sent.
                // Preserve refused redirects instead of retrying the SDK's generic network error.
                if (configuration !== null && configuration !== autoConfigurationStamp()) {
                  state.refused = autoChanged().message
                  throw new Error(state.refused)
                }
                const response = await routed(input, init).catch((error: unknown) => {
                  if (error instanceof RedirectRefused) state.refused = error.message
                  throw error
                })
                captureUsageHeaders(response.headers, state.capture)
                state.status = response.status
                state.retryAfterMs = parseRetryAfter(response.headers.get("retry-after") ?? undefined)
                heard()
                if (!response.body) return response
                const body = response.body.pipeThrough(
                  new TransformStream<Uint8Array, Uint8Array>({
                    transform: (chunk, controller) => {
                      heard()
                      controller.enqueue(chunk)
                    }
                  })
                )
                return new Response(body, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                })
              }
              const cacheMode = resolveModel(
                model.key,
                model.upstream,
                model.overrides,
                prepared.connection.compat,
                prepared.settings
              ).cacheBreakpoints.value
              // An empty breakpoint list alone leaves the SDK's automatic markers enabled.
              const options =
                cacheMode === "none" ? { ...request.options, cacheRetention: "none" as const } : (request.options ?? {})
              const target: RequestTarget = {
                kind: prepared.kind.id,
                api: prepared.api,
                provider: prepared.provider,
                model: model.key
              }
              const transforms = registry.transforms.list().filter((t) => t.appliesTo(target))
              const observers = registry.observers.list().filter((o) => o.appliesTo(target))
              const breakpoints = options.cacheRetention === "none" ? [] : (options.breakpoints ?? [])
              const overrides = options.payload
              await Effect.runPromise(authorizeAuto(request.userId, auto), { signal }).catch((error: unknown) => {
                state.refused = "Not sent: auto replies ended because the chat, settings or server changed."
                throw error
              })
              // pi-ai's managed effort puts a system message before the reply and before each
              // earlier reply it knows the effort of; those are part of a bound block's prefix.
              const streamModel =
                options.replayReasoning &&
                (piModel.compat as { readonly supportsMidConvoEffort?: boolean } | undefined)
                  ?.supportsMidConvoEffort === true &&
                terms.prefix
                  ? ({ ...piModel, compat: { ...piModel.compat, supportsMidConvoEffort: false } } as PiModel<Api>)
                  : piModel
              const events = prepared.kind.streams.streamSimple(streamModel, transcript, {
                // A keyless local server still needs a value; pi's direct calls require one. A
                // kind with its own transport authorizes the request itself from the stored key,
                // so the SDK never holds it: a service account's key file has line breaks, which
                // no header can carry, and the SDK would put it in one (and in its error).
                apiKey: prepared.kind.transport ? TRANSPORT_AUTH : (prepared.apiKey ?? "no-key"),
                env: {},
                maxRetries: 0,
                signal: AbortSignal.any([signal, idle.signal]),
                headers: prepared.headers,
                ...(prepared.kind.acceptsFetch
                  ? {
                      fetch: prepared.kind.transport
                        ? prepared.kind.transport(observed, {
                            apiKey: prepared.apiKey,
                            baseUrl: prepared.baseUrl,
                            settings: prepared.settings,
                            aside: routed
                          })
                        : observed
                    }
                  : {}),
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
                  // Sent thinking the provider says it left out (the binding beta's report).
                  if (terms.prefix) state.providerDropped = providerDroppedThinking(data) ?? state.providerDropped
                  for (const observer of observers) observer.observe(data, state.capture)
                  if ((prepared.kind.cacheRelease ?? defaultCacheRelease).after === "first-chunk") {
                    state.gate?.release("first-chunk")
                  }
                },
                // The caller's fields, then the registered transforms, in registration order.
                onPayload: async (payload: unknown) => {
                  // Adapters without injected fetch must still authorize their dispatch.
                  let configuration: string | null = null
                  if (!prepared.kind.acceptsFetch)
                    configuration = await Effect.runPromise(authorizeAuto(request.userId, auto)).catch(
                      (error: unknown) => {
                        state.refused = "Not sent: auto replies ended because the chat, settings or server changed."
                        throw error
                      }
                    )
                  const sources = request.inspection
                    ? wireContext(request.inspection.request, {
                        ...request.inspection.model,
                        mapping: mappingCapabilities(
                          resolveModel(
                            model.key,
                            model.upstream,
                            model.overrides,
                            prepared.connection.compat,
                            prepared.settings
                          )
                        )
                      })
                    : undefined
                  const initial =
                    overrides === undefined ? (payload as Record<string, unknown>) : merged(payload, overrides)
                  if (sources) markWireSources(initial, sources)
                  const effective = resolveModel(
                    model.key,
                    model.upstream,
                    model.overrides,
                    prepared.connection.compat,
                    prepared.settings
                  )
                  const transformed = transforms.reduce(
                    (current, t) =>
                      t.transform(current, {
                        target,
                        messages: request.context.messages,
                        breakpoints,
                        ...(options.preserveBreakpoints ? { preserveBreakpoints: true } : {}),
                        cacheLayout: effective.cacheLayout.value,
                        ...(options.stable && options.cacheRetention !== "none" ? { stable: options.stable } : {}),
                        ...(options.cacheRetention !== undefined ? { cacheRetention: options.cacheRetention } : {}),
                        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
                        ...(options.toolLoading ? { toolLoading: options.toolLoading } : {}),
                        settings: prepared.settings
                      }),
                    initial
                  )
                  // Then what the provider refuses or needs for this model (compatibility shims).
                  const shimmed = applyShims(registry.shims.list(), transformed, target, retryError)
                  const limited = limitImages(shimmed.payload, effective.maxImages.value)
                  // Last: signed thinking the provider would refuse is left out (thinkingBinding.ts).
                  const binding = registry.thinkingBindings.list().find((b) => b.appliesTo(target))
                  const bound = binding
                    ? bindThinking(binding, limited, {
                        context: request.context.messages,
                        connectionId: prepared.connection.id,
                        modelId: model.id,
                        connectionStamp,
                        mode: bindingMode,
                        ...(replay ? { history: replay } : {}),
                        ...(terms.prefix ? { run: true } : {})
                      })
                    : { payload: limited, dropped: 0, reason: null }
                  // Sending signed thinking to a bound-thinking model (earlier replies' reasoning,
                  // or a tool run's own) opts into the provider's own check, whatever the account's
                  // age: a block the check above let through wrongly is dropped (and reported), not
                  // refused or read stale.
                  const netted =
                    terms.prefix && binding?.dropOnMismatch && carriesSigned(binding, bound.payload)
                      ? binding.dropOnMismatch(bound.payload)
                      : bound.payload
                  const budget = options.outputBudget
                  if (budget && (!prepared.kind.limitOutput || budget.remaining < 1))
                    throw new Error("The reply's token limit is exhausted or this provider cannot enforce it.")
                  const final = budget ? prepared.kind.limitOutput!(netted, budget.remaining) : netted
                  state.binding = binding
                  state.sent = final
                  state.signed = {
                    sent: binding !== undefined && carriesSigned(binding, final),
                    dropped: bound.dropped > 0
                  }
                  // Earlier replies' reasoning left out is the request inspector's to show only.
                  const thinkingNotes =
                    bound.reason === null
                      ? []
                      : history
                        ? [{ kind: "reasoning_left_out" as const, message: HISTORY_DROP_NOTES[bound.reason] }]
                        : [{ kind: "thinking_left_out" as const, message: DROP_NOTES[bound.reason] }]
                  await Effect.runPromise(open(final), { signal })
                  const policy = documentedCachePolicy(
                    { provider: prepared.cacheContract ?? "", api: prepared.api, model: model.key },
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
                                    {
                                      ...request.inspection.display,
                                      issues: [
                                        ...request.inspection.display.issues,
                                        ...shimmed.notices.map((message) => ({
                                          kind: "compatibility" as const,
                                          message
                                        })),
                                        ...thinkingNotes
                                      ]
                                    },
                                    prepared.scrub
                                  )
                                : wire
                            ),
                            // Also among the reply's notes, so the message says it (thinkingBinding.ts).
                            ...(thinkingNotes.length ? { issues: thinkingNotes } : {})
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
                  if (configuration !== null && configuration !== autoConfigurationStamp()) {
                    state.refused = autoChanged().message
                    throw new Error(state.refused)
                  }
                  return final
                }
              })
              try {
                for await (const event of events) {
                  heard()
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
                    const now = Date.now()
                    state.firstTokenAt ??= now
                    if (event.type === "thinking_delta") {
                      if (event.delta.length > 0) state.firstReasoningAt ??= now
                    } else state.firstReplyAt ??= now
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
                clearInterval(watch)
                await recording
                // For the request inspector only, as what the check above left out.
                const rolloutId = request.attribution.rolloutId
                if (state.providerDropped > 0 && rolloutId)
                  await Effect.runPromise(
                    fromStorage(
                      writer.RecordSentContext({
                        userId: request.userId,
                        rolloutId,
                        issues: [
                          {
                            kind: "reasoning_left_out",
                            message: history ? providerDropNote(state.providerDropped) : PROVIDER_RUN_DROP_NOTE
                          }
                        ]
                      })
                    )
                  ).catch((error: unknown) =>
                    Effect.runPromise(Effect.logWarning(`recording ${rolloutId}'s dropped reasoning failed`, error))
                  )
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
            : state.silentFor !== null
              ? providerError("no_response", `The provider sent nothing for ${state.silentFor} s.`, {
                  afterTokens: state.firstTokenAt !== null
                })
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
              Effect.map(({ counts, cost, outputReported }): AttemptOutcome =>
                error
                  ? { ok: false, error, signed: state.signed }
                  : {
                      ok: true,
                      event: {
                        type: "done",
                        requestId,
                        message: recordThinking(message),
                        toolArguments: toolArguments.argumentsById,
                        counts,
                        outputReported: outputReported === true,
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
            if (prepared.kind.decide)
              return yield* providerError(
                "unusable",
                `${prepared.connection.name} answers decision questions only; choose another connection for replies`
              )
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
            const effective = resolveModel(
              model.key,
              model.upstream,
              model.overrides,
              prepared.connection.compat,
              prepared.settings
            )
            const piModel = yield* Effect.tryPromise({
              try: () =>
                buildPiModel(
                  prepared,
                  model,
                  effective,
                  registry.thinkingBindings.list(),
                  request.options?.reasoning !== undefined
                ),
              catch: (error) =>
                scrubbed(prepared, providerError("unknown", `could not prepare the model: ${String(error)}`))
            })
            // An unknown context gets a default for the request, but overflow is only judged
            // against a context some source actually reported.
            const knownContext = effective.context.source === "unknown" ? undefined : effective.context.value
            const capped = yield* withCap(prepared.connection)
            // A pinned route's own prices, when none are stored or they're stale: fetched alongside
            // the reply, off its path, so the close can price with them if they've arrived.
            const latest = { current: model }
            if (prepared.kind.id === "openrouter")
              yield* Effect.forkDetach(
                ensureEndpoints(request.userId, model).pipe(
                  Effect.tap((fresh) =>
                    Effect.sync(() => {
                      latest.current = fresh
                    })
                  )
                )
              )

            let compatibilityError: ProviderError | undefined
            let bindingMode: "check" | "strip" | "keep" = "check"
            for (let n = 0; ; n++) {
              const outcome = yield* capped(
                waitForPause(prepared.connection.id, offer).pipe(
                  Effect.andThen(
                    attempt(
                      prepared,
                      model,
                      piModel,
                      knownContext,
                      request,
                      offer,
                      n + 1,
                      pricing,
                      latest,
                      compatibilityError,
                      bindingMode
                    )
                  )
                )
              )
              if (outcome.ok) {
                if (request.options?.outputBudget) {
                  const budget = request.options.outputBudget
                  budget.remaining =
                    !outcome.event.outputReported || outcome.event.counts.output === null
                      ? 0
                      : Math.max(0, budget.remaining - outcome.event.counts.output)
                }
                offer(outcome.event)
                yield* Queue.end(queue)
                return
              }
              const error = outcome.error
              // Bounded Auto requests must never retry automatically.
              if (request.options?.outputBudget) return yield* error
              // Once: a refusal of signed thinking is sent again without any (the provider's
              // check is stricter than ours), and a model that needs the thinking of the turn
              // being continued gets what was left out (thinkingBinding.ts).
              if (bindingMode === "check" && outcome.signed?.sent && refusesSigned(error)) {
                bindingMode = "strip"
                offer({
                  type: "retrying",
                  attempt: n + 1,
                  maxRetries: 1,
                  delayMs: 0,
                  error,
                  notice: "Earlier thinking was refused. Trying once without it."
                })
                continue
              }
              if (
                !compatibilityError &&
                request.context.tools?.length &&
                hasRetryShim(
                  registry.shims.list(),
                  { kind: prepared.kind.id, provider: prepared.provider, api: prepared.api, model: model.key },
                  error
                )
              ) {
                compatibilityError = error
                continue
              }
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

      // --- Connection checks ----------------------------------------------------------

      /** The model list part of a check, with the route it took and how long it took. */
      const checkList = (prepared: Prepared) =>
        Effect.gen(function* () {
          let route: string | null = null
          const started = Date.now()
          const catalog = prepared.kind.listsCatalog === true
          return yield* listModels(prepared, (d) => (route = d)).pipe(
            Effect.timeoutOrElse({
              duration: TEST_TIMEOUT_MS,
              orElse: () => Effect.fail(providerError("network", `no answer in ${TEST_TIMEOUT_MS / 1000} s`))
            }),
            Effect.map((listed) => ({
              ok: true,
              // A catalog is built in: nothing was sent to list it.
              detail: `${listed.length} ${listed.length === 1 ? "model" : "models"} ${catalog ? "in the built-in list" : "listed"}`,
              route,
              models: listed.length as number | null,
              reason: null as ProviderErrorReason | null,
              status: null as number | null,
              modelKeys: listed.slice(0, TEST_MODEL_KEYS).map((model) => model.key) as ReadonlyArray<string>,
              ms: Date.now() - started,
              catalog,
              listed
            })),
            Effect.catch((error: ProviderError) =>
              Effect.succeed({
                ok: false,
                detail: error.message,
                route,
                models: null,
                reason: error.reason,
                status: error.status,
                modelKeys: [],
                ms: Date.now() - started,
                catalog,
                listed: [] as ReadonlyArray<ListedModel>
              })
            )
          )
        })

      const testResult = (
        { listed: _listed, ...list }: Effect.Success<ReturnType<typeof checkList>>,
        reply: TestReply | null
      ): TestResult => ({ ...list, ok: list.ok && (reply?.ok ?? true), reply })

      const replyOf = (
        prepared: Prepared,
        model: string,
        started: number,
        route: string | null,
        text: string,
        error: ProviderError | null
      ): TestReply => {
        // A reply cut off at the tiny limit still answered.
        const failed = error !== null && error.reason !== "length_cutoff" ? error : null
        return {
          model,
          ok: failed === null,
          text: prepared.scrub(text).trim().slice(0, TEST_REPLY_CHARS),
          ms: Date.now() - started,
          route,
          reason: failed?.reason ?? null,
          status: failed?.status ?? null,
          detail: failed === null ? null : prepared.scrub(failed.message).slice(0, 500)
        }
      }

      const testContext = (): PiContext => ({
        messages: [{ role: "user", content: TEST_PROMPT, timestamp: Date.now() }]
      })

      const testConnection: ProvidersShape["testConnection"] = (userId, connectionId, modelId = null) =>
        Effect.gen(function* () {
          const prepared = yield* prepare(userId, connectionId)
          const list = yield* checkList(prepared)
          if (modelId === null) return testResult(list, null)
          const model = yield* fromStorage(reader.GetModel({ userId, modelId }))
          if (model.connectionId !== connectionId)
            return yield* providerError("unusable", "that model belongs to another connection")
          // The real request path, recorded like any other request on the connection.
          const started = Date.now()
          let route: string | null = null
          let text = ""
          const error = yield* stream({
            userId,
            connectionId,
            modelId,
            context: testContext(),
            options: { maxTokens: TEST_MAX_TOKENS, cacheRetention: "none" },
            attribution: { purpose: "test" }
          }).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "text") text += event.delta
                if (event.type === "route") route = event.description
              })
            ),
            Effect.timeoutOrElse({
              duration: TEST_TIMEOUT_MS,
              orElse: () => Effect.fail(providerError("no_response", `no answer in ${TEST_TIMEOUT_MS / 1000} s`))
            }),
            Effect.as<ProviderError | null>(null),
            Effect.catch((failure) =>
              Effect.succeed(
                failure instanceof ProviderError ? failure : providerError("unknown", "the request failed")
              )
            )
          )
          return testResult(list, replyOf(prepared, model.key, started, route, text, error))
        })

      /** Where a connection as `createConnection` would make it points, or why it can't be made. */
      const draftTarget = (
        providerId: string | undefined,
        kind: ProviderKind,
        settings: Pick<ConnectionSettings, "baseUrl" | "providerSettings">
      ) =>
        Effect.gen(function* () {
          const entry = registry.kinds.get(kind)
          if (!entry) return yield* providerError("bad_request", `unknown provider kind "${kind}"`)
          const named = providerId === undefined ? undefined : registry.providers.get(providerId)
          if (providerId !== undefined && !named)
            return yield* providerError("bad_request", `unknown provider "${providerId}"`)
          const provider = named ?? findProvider(registry.providers.list(), null, kind, settings.baseUrl)
          if (named && !named.apis.some((api) => api.id === kind)) {
            return yield* providerError("bad_request", `${named.label} doesn't offer the API type "${kind}"`)
          }
          const baseUrl = settings.baseUrl ?? defaultBaseUrl(provider, entry, settings.providerSettings)
          if (baseUrl === null) return yield* providerError("bad_request", "enter the server's base URL")
          return { entry, provider, baseUrl }
        })

      /**
       * One short message on a draft connection: pi-ai's adapter with the registered transforms
       * and shims, as a reply would be sent, but with no retries and nothing recorded (there is
       * no connection to record it on).
       */
      const draftReply = (prepared: Prepared, key: string, listed: ReadonlyArray<ListedModel>) =>
        Effect.gen(function* () {
          const started = Date.now()
          let route: string | null = null
          let text = ""
          const seen = { status: null as number | null, retryAfterMs: null as number | null }
          const done = (error: ProviderError | null) => replyOf(prepared, key, started, route, text, error)
          if (prepared.kind.decide)
            return done(providerError("unusable", "this API type answers decision questions only"))
          const [described] = yield* describeModels(prepared.kind, prepared.provider, [
            listed.find((model) => model.key === key) ?? { key, upstream: {} }
          ])
          const model = new Model({
            id: uuidv7() as ModelId,
            connectionId: prepared.connection.id,
            key,
            source: "fetched",
            upstream: described?.upstream ?? {},
            overrides: {},
            hidden: false,
            fetchedAt: started,
            missingSince: null,
            rowVersion: 0
          })
          const effective = resolveModel(key, model.upstream, {}, prepared.connection.compat, prepared.settings)
          const built = yield* Effect.tryPromise({
            try: () => buildPiModel(prepared, model, effective, registry.thinkingBindings.list(), false),
            catch: (error) => providerError("unknown", `could not prepare the model: ${String(error)}`)
          }).pipe(Effect.result)
          if (built._tag === "Failure") return done(built.failure)
          const piModel = built.success
          const context = testContext()
          const target: RequestTarget = {
            kind: prepared.kind.id,
            api: prepared.api,
            provider: prepared.provider,
            model: key
          }
          const transforms = registry.transforms.list().filter((t) => t.appliesTo(target))
          const routed = fetchFor(prepared, (description) => (route = description))
          const failed = (errorMessage: string): AssistantMessage => ({
            role: "assistant",
            content: [],
            api: prepared.api,
            provider: piModel.provider,
            model: key,
            usage: emptyUsage(),
            stopReason: "error",
            errorMessage,
            timestamp: Date.now()
          })
          const message = yield* Effect.tryPromise({
            try: async (signal) => {
              const events = prepared.kind.streams.streamSimple(piModel, normalizeContext(context), {
                apiKey: prepared.kind.transport ? TRANSPORT_AUTH : (prepared.apiKey ?? "no-key"),
                env: {},
                maxRetries: 0,
                signal,
                headers: prepared.headers,
                maxTokens: TEST_MAX_TOKENS,
                cacheRetention: "none",
                ...(prepared.kind.acceptsFetch
                  ? {
                      fetch: prepared.kind.transport
                        ? prepared.kind.transport(routed, {
                            apiKey: prepared.apiKey,
                            baseUrl: prepared.baseUrl,
                            settings: prepared.settings,
                            aside: routed
                          })
                        : routed
                    }
                  : {}),
                onResponse: (response) => {
                  seen.status = response.status
                  seen.retryAfterMs = parseRetryAfter(response.headers["retry-after"])
                },
                onPayload: (payload: unknown) => {
                  const transformed = transforms.reduce(
                    (current, t) =>
                      t.transform(current, {
                        target,
                        messages: context.messages,
                        breakpoints: [],
                        cacheLayout: effective.cacheLayout.value,
                        cacheRetention: "none",
                        settings: prepared.settings
                      }),
                    payload as Record<string, unknown>
                  )
                  return Promise.resolve(applyShims(registry.shims.list(), transformed, target).payload)
                }
              })
              for await (const event of events) if (event.type === "text_delta") text += event.delta
              return await events.result()
            },
            catch: (thrown) => thrown
          }).pipe(
            Effect.catch((thrown) => Effect.succeed(failed(thrown instanceof Error ? thrown.message : String(thrown)))),
            Effect.timeoutOrElse({
              duration: TEST_TIMEOUT_MS,
              orElse: () => Effect.succeed(failed(`no answer in ${TEST_TIMEOUT_MS / 1000} s`))
            })
          )
          return done(classify(message, { ...seen, category: null }, undefined, text !== "", true))
        })

      const testDraft: ProvidersShape["testDraft"] = (input) =>
        Effect.gen(function* () {
          const { entry, provider } = yield* draftTarget(input.provider, input.kind, input.settings)
          const key = typedKey(input.apiKey)
          let credential: ConnectionForRequest["credential"] = null
          let credentialName: string | null = null
          if (key === null && input.credentialId) {
            const saved = (yield* fromStorage(reader.ListCredentials({ userId: input.userId }))).find(
              (entry) => entry.id === input.credentialId
            )
            if (!saved) return yield* providerError("unusable", "that saved key no longer exists")
            const { keyEnc } = yield* fromStorage(
              reader.ResolveCredential({ userId: input.userId, credentialId: saved.id })
            )
            credential = { id: saved.id, keyEnc, origins: saved.origins }
            credentialName = saved.name
          }
          const now = Date.now()
          // The connection `createConnection` would store, held only for this check.
          const connection = new Connection({
            id: uuidv7() as ConnectionId,
            name: input.settings.name.trim() || "New connection",
            provider: provider?.id ?? "",
            providerSettings: input.settings.providerSettings
              ? providerChanges(provider, input.settings.providerSettings)
              : {},
            kind: input.kind,
            api: entry.api,
            baseUrl: input.settings.baseUrl,
            credentialId: credential?.id ?? null,
            credentialName,
            hasKey: key !== null || credential !== null,
            keyHint: null,
            headerNames: [],
            compat: input.settings.compat,
            cacheTtlS: input.settings.cacheTtlS,
            maxConcurrent: input.settings.maxConcurrent,
            proxyMode: "inherit",
            presetOverrideRefId: null,
            rowVersion: 0,
            createdAt: now,
            updatedAt: now
          })
          const prepared = yield* prepareResolved(
            new ConnectionForRequest({
              connection,
              credential,
              headersEnc: null,
              headersOrigin: null,
              proxyUrlEnc: null,
              ownerRole: input.role
            }),
            key
          )
          const list = yield* checkList(prepared)
          const model = input.model?.trim() || null
          return testResult(list, model === null ? null : yield* draftReply(prepared, model, list.listed))
        })

      const decide: ProvidersShape["decide"] = (request) =>
        Effect.gen(function* () {
          const auto = yield* AutoRequestGuard
          const prepared = yield* prepare(request.userId, request.connectionId)
          const wire = prepared.kind.decide
          if (!wire)
            return yield* providerError("unusable", `${prepared.connection.name} doesn't answer decision questions`)
          const model = yield* fromStorage(reader.GetModel({ userId: request.userId, modelId: request.modelId }))
          if (model.connectionId !== prepared.connection.id)
            return yield* providerError("unusable", "that model belongs to another connection")
          const pricing = {
            settings: yield* fromStorage(reader.GetCostSettings({ userId: request.userId })),
            kind: prepared.kind.id,
            connectionId: prepared.connection.id,
            model: model.key
          }
          const body = { model: model.key, state: request.state, questions: request.questions }
          const requestId = uuidv7() as LlmRequestId
          const target = { kind: prepared.kind.id, api: prepared.api, model: model.key }
          yield* authorizeAuto(request.userId, auto)
          const allowed = yield* fromStorage(
            writer.OpenLlmRequest({
              userId: request.userId,
              request: {
                id: requestId,
                connectionId: prepared.connection.id,
                modelId: model.id,
                chatId: request.attribution.chatId,
                rolloutId: request.attribution.rolloutId,
                versionId: request.attribution.versionId ?? null,
                purpose: "decision",
                api: prepared.api,
                provider: prepared.kind.piProvider,
                modelKey: model.key,
                startedAt: Date.now(),
                reservation: {
                  tokens: Buffer.byteLength(JSON.stringify(body), "utf8") + 256,
                  cost: null,
                  currency: null
                }
              }
            })
          )
          if (!allowed)
            return yield* providerError("budget_held", "The decision request is held at its approved limit.")
          const close = (
            outcome: { readonly status: "complete" | "failed" | "aborted"; readonly error: ProviderError | null },
            usage: ReturnType<typeof readDecisionUsage>,
            servedModel: string | null,
            rawUsage: unknown
          ) =>
            Effect.gen(function* () {
              const counts: TokenCounts = {
                inputUncached: usage.inputTokens,
                cacheRead: usage.inputTokens === null ? null : 0,
                cacheWrite: usage.inputTokens === null ? null : 0,
                cacheWriteLong: usage.inputTokens === null ? null : 0,
                output: usage.outputTokens,
                reasoning: null
              }
              const capture: Capture = { ...emptyCapture(), reportedCost: usage.cost, rawUsage: rawUsage as never }
              const sources = sourcesOf(prepared, model)
              const cost = costOf(registry.costs.list(), target, {
                counts,
                pricing,
                capture,
                price: firstPrice(sources),
                sources
              })
              yield* writer
                .CloseLlmRequest({
                  userId: request.userId,
                  request: {
                    id: requestId,
                    status: outcome.status,
                    endedAt: Date.now(),
                    firstTokenAt: null,
                    responseModel: servedModel === null ? null : prepared.scrub(servedModel).slice(0, 256),
                    upstream: null,
                    counts,
                    usageSource: usage.inputTokens === null && usage.outputTokens === null ? "none" : "reported",
                    rawUsage: rawUsage ?? null,
                    reportedCost: usage.cost,
                    cost,
                    error:
                      outcome.error === null
                        ? null
                        : { reason: outcome.error.reason, message: outcome.error.message, status: outcome.error.status }
                  }
                })
                .pipe(Effect.catch((e) => Effect.logError(`could not close ledger row ${requestId}`, e)))
              return { counts, cost }
            })
          const none = readDecisionUsage(null)
          const sent = yield* Effect.tryPromise({
            try: (signal) =>
              wire.decide({
                baseUrl: prepared.baseUrl,
                apiKey: prepared.apiKey,
                headers: prepared.headers,
                fetch: async (input, init) => {
                  const configuration = await Effect.runPromise(authorizeAuto(request.userId, auto), { signal })
                  if (configuration !== null && configuration !== autoConfigurationStamp())
                    throw new Error(autoChanged().message)
                  return fetchFor(prepared, () => {})(input, init)
                },
                body,
                signal
              }),
            catch: (error) =>
              scrubbed(
                prepared,
                error instanceof RedirectRefused
                  ? providerError("unusable", error.message)
                  : providerError("network", error instanceof Error ? error.message : String(error))
              )
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : close(
                    Cause.hasInterruptsOnly(exit.cause)
                      ? { status: "aborted", error: providerError("aborted", "stopped") }
                      : {
                          status: "failed",
                          error: Option.getOrElse(Cause.findErrorOption(exit.cause), () =>
                            providerError("unknown", "the request failed")
                          )
                        },
                    none,
                    null,
                    null
                  ).pipe(Effect.asVoid)
            )
          )
          const envelope = unwrapEnvelope(sent.body)
          const usage = readDecisionUsage(envelope["usage"])
          const servedModel = typeof envelope["model"] === "string" ? envelope["model"] : null
          if (sent.status < 200 || sent.status >= 300) {
            const reason =
              sent.status === 401 || sent.status === 403
                ? "auth"
                : sent.status === 429
                  ? "rate_limited"
                  : sent.status === 503 || sent.status === 529
                    ? "overloaded"
                    : sent.status >= 400 && sent.status < 500
                      ? "bad_request"
                      : "unknown"
            const error = scrubbed(
              prepared,
              providerError(reason, `HTTP ${sent.status}${sent.detail ? `: ${sent.detail}` : ""}`, {
                status: sent.status,
                retryAfterMs: sent.retryAfterMs
              })
            )
            yield* close({ status: "failed", error }, usage, servedModel, envelope["usage"] ?? null)
            return yield* error
          }
          // A 2xx was billed whatever its answers say: the ledger matches the provider's invoice.
          const { counts, cost } = yield* close(
            { status: "complete", error: null },
            usage,
            servedModel,
            envelope["usage"] ?? null
          )
          return { requestId, answers: envelope["answers"], servedModel, counts, cost }
        })

      const estimateCost: ProvidersShape["estimateCost"] = (userId, connectionId, modelId, counts) =>
        Effect.gen(function* () {
          const connection = yield* fromStorage(reader.GetConnection({ userId, connectionId }))
          const model = yield* fromStorage(reader.GetModel({ userId, modelId }))
          if (model.connectionId !== connection.id) return null
          const kind = registry.kinds.get(connection.kind)
          const sources = kind
            ? sourcesOf(
                { kind, settings: resolveProviderSettings(providerOf(connection), connection.providerSettings) },
                model
              )
            : null
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
              price: sources ? firstPrice(sources) : modelPrice(model),
              ...(sources ? { sources } : {})
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
        decide,
        kinds: () =>
          registry.kinds.list().map(
            (entry) =>
              new ProviderKindInfo({
                id: entry.id,
                label: entry.label,
                api: entry.api,
                defaultBaseUrl: entry.defaultBaseUrl,
                keyOptional: entry.keyOptional,
                ...(entry.decide ? { decisions: true } : {})
              })
          ),
        providers: () =>
          registry.providers
            .list()
            .filter((provider) => provider.apis.some((api) => registry.kinds.get(api.id) !== undefined))
            .map(
              (provider) =>
                new ProviderInfo({
                  id: provider.id,
                  label: provider.label,
                  about: provider.about,
                  // Only the API types whose kinds are in effect (a plugin's may be gone).
                  apis: provider.apis.filter((api) => registry.kinds.get(api.id) !== undefined),
                  baseUrl: provider.baseUrl,
                  ...(provider.baseUrlExample ? { baseUrlExample: provider.baseUrlExample } : {}),
                  ...(provider.regionUrl ? { regionUrl: provider.regionUrl } : {}),
                  ...(provider.regionUrls ? { regionUrls: provider.regionUrls } : {}),
                  ...(provider.regionFormat ? { regionFormat: provider.regionFormat } : {}),
                  keyOptional: provider.keyOptional,
                  auth: provider.auth,
                  defaults: provider.defaults,
                  settings: provider.settings,
                  cacheLifetime: provider.cacheLifetime,
                  accounting: provider.accounting,
                  rules: providerRules(registry.shims.list(), provider.id),
                  ...(provider.decisions ? { decisions: true } : {})
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
        refreshEndpoints,
        ensureEndpoints,
        priceFeedState,
        priceTimerRound,
        catalogUpstream,
        testConnection,
        testDraft,
        stream
      })
    })
  )
