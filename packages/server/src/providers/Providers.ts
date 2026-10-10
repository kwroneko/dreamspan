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
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import {
  type Connection,
  type ConnectionId,
  type ConnectionSettings,
  type EffectiveModel,
  type Model,
  type ModelId,
  type ProviderKind,
  type ProxyMode,
  providerKinds,
  resolveModel,
  type WireApi
} from "@rp/shared/providers.ts"
import type { Cost, LlmRequestId, RequestPurpose, TokenCounts } from "@rp/shared/usage.ts"
import { Context, Effect, Layer, Queue, Semaphore, Stream } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { Network, type ProxyOverride } from "../net/Network.ts"
import { describeRoute, proxyUrlProblem } from "../net/route.ts"
import { Secrets } from "../secrets.ts"
import { applyAnthropicBreakpoints } from "./breakpoints.ts"
import { catalogEntry } from "./catalog.ts"
import { classify, parseRetryAfter, ProviderError, providerError, RETRYABLE } from "./errors.ts"
import { fetchModelList, type ModelListError } from "./modelLists.ts"
import { type Capture, captureEvent, emptyCapture, finalCounts, recordedCost } from "./usage.ts"

export { ProviderError } from "./errors.ts"

const apis: Record<WireApi, ReturnType<typeof openAICompletionsApi>> = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
  "google-generative-ai": googleGenerativeAIApi()
}

/** pi-ai's Google adapter rejects a custom fetch, so its traffic can't be routed through a proxy. */
const OWN_FETCH: ReadonlySet<WireApi> = new Set(["openai-completions", "openai-responses", "anthropic-messages"])

/** Retries before the first token (PROVIDERS §7.2). After output, a failure is the user's call. */
export interface RetryPolicy {
  readonly maxRetries: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}
export const defaultRetryPolicy: RetryPolicy = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 }

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
  readonly kind: ProviderKind
  readonly api: WireApi
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

const binding = (connectionId: string, field: "api_key" | "headers" | "proxy_url") =>
  `connection:${connectionId}:${field}`

export interface ProvidersShape {
  readonly createConnection: (input: {
    readonly userId: UserId
    readonly kind: ProviderKind
    readonly settings: ConnectionSettings
    readonly apiKey: string | null
  }) => Effect.Effect<Connection, ProviderError>
  readonly setKey: (
    userId: UserId,
    connectionId: ConnectionId,
    apiKey: string | null
  ) => Effect.Effect<Connection, ProviderError>
  readonly setHeaders: (
    userId: UserId,
    connectionId: ConnectionId,
    headers: Readonly<Record<string, string>> | null
  ) => Effect.Effect<Connection, ProviderError>
  readonly setProxy: (
    userId: UserId,
    connectionId: ConnectionId,
    mode: ProxyMode,
    url: string | null
  ) => Effect.Effect<Connection, ProviderError>
  /** Fetches the upstream's model list and applies it (PROVIDERS §3.3). */
  readonly refreshModels: (
    userId: UserId,
    connectionId: ConnectionId
  ) => Effect.Effect<
    { readonly added: number; readonly updated: number; readonly missing: number; readonly route: string | null },
    ProviderError
  >
  /** Checks a connection by fetching its model list; reports the route it took. */
  readonly testConnection: (userId: UserId, connectionId: ConnectionId) => Effect.Effect<TestResult, ProviderError>
  readonly stream: (request: StreamRequest) => Stream.Stream<ProviderEvent, ProviderError>
}

export class Providers extends Context.Service<Providers, ProvidersShape>()("rp/Providers") {}

/** Storage failures become provider errors: NotFound means unusable, anything else unknown. */
const fromStorage = <A, R>(effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error._tag === "NotFound"
        ? providerError("unusable", "connection or model not found")
        : error._tag === "StaleWrite"
          ? providerError("bad_request", "the connection changed in another tab; reload it")
          : providerError("unknown", `storage: ${error.message}`)
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
    provider: providerKinds[prepared.kind].piProvider,
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

export const layer = (policy: RetryPolicy = defaultRetryPolicy) =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      const reader = yield* Reader
      const writer = yield* Writer
      const secrets = yield* Secrets
      const network = yield* Network

      const prepare = (userId: UserId, connectionId: ConnectionId) =>
        Effect.gen(function* () {
          const resolved = yield* fromStorage(reader.ResolveConnection({ userId, connectionId }))
          const connection = resolved.connection
          const info = providerKinds[connection.kind]
          const decrypt = (blob: Uint8Array | null, field: "api_key" | "headers" | "proxy_url") =>
            blob === null
              ? Effect.succeed(null)
              : secrets
                  .decrypt(blob, binding(connectionId, field))
                  .pipe(Effect.mapError((error) => providerError("unusable", error.message)))
          const apiKey = yield* decrypt(resolved.apiKeyEnc, "api_key")
          if (apiKey === null && !info.keyOptional) {
            return yield* providerError("unusable", `${connection.name} has no API key`)
          }
          const headersJson = yield* decrypt(resolved.headersEnc, "headers")
          const proxyUrl = yield* decrypt(resolved.proxyUrlEnc, "proxy_url")
          const override: ProxyOverride =
            connection.proxyMode === "custom" && proxyUrl !== null
              ? { mode: "custom", url: proxyUrl }
              : connection.proxyMode === "direct"
                ? { mode: "direct" }
                : { mode: "inherit" }
          const headers = headersJson === null ? {} : (JSON.parse(headersJson) as Record<string, string>)
          const prepared: Prepared = {
            connection,
            kind: connection.kind,
            api: info.api,
            baseUrl: connection.baseUrl ?? info.defaultBaseUrl,
            apiKey,
            headers,
            override,
            scrub: makeScrub([apiKey, ...Object.values(headers), ...proxySecrets(proxyUrl)])
          }
          if (!OWN_FETCH.has(prepared.api)) {
            // Its traffic would bypass our fetch, so it may only go where we'd send it direct anyway.
            const route = yield* network.route(new URL(prepared.baseUrl), override)
            if (route.via === "proxy") {
              return yield* providerError(
                "unusable",
                `${info.label} connections can't go through a proxy yet (pi-ai's adapter doesn't take one); set this connection to direct or add the host to the bypass list`
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

      const encryptKey = (connectionId: string, apiKey: string) => ({
        enc: secrets.encrypt(apiKey, binding(connectionId, "api_key")),
        hint: apiKey.slice(-4)
      })

      const createConnection: ProvidersShape["createConnection"] = ({ userId, kind, settings, apiKey }) =>
        Effect.gen(function* () {
          const connectionId = uuidv7() as ConnectionId
          const created = yield* fromStorage(writer.CreateConnection({ userId, connectionId, kind, settings }))
          if (apiKey === null || apiKey === "") return created
          return yield* fromStorage(
            writer.SetConnectionKey({ userId, connectionId, key: encryptKey(connectionId, apiKey.trim()) })
          )
        })

      const setKey: ProvidersShape["setKey"] = (userId, connectionId, apiKey) =>
        fromStorage(
          writer.SetConnectionKey({
            userId,
            connectionId,
            key: apiKey === null || apiKey.trim() === "" ? null : encryptKey(connectionId, apiKey.trim())
          })
        )

      const setHeaders: ProvidersShape["setHeaders"] = (userId, connectionId, headers) =>
        fromStorage(
          writer.SetConnectionHeaders({
            userId,
            connectionId,
            headers:
              headers === null || Object.keys(headers).length === 0
                ? null
                : {
                    enc: secrets.encrypt(JSON.stringify(headers), binding(connectionId, "headers")),
                    names: Object.keys(headers)
                  }
          })
        )

      const setProxy: ProvidersShape["setProxy"] = (userId, connectionId, mode, url) =>
        Effect.gen(function* () {
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
        fetchModelList({
          kind: prepared.kind,
          baseUrl: prepared.baseUrl,
          apiKey: prepared.apiKey,
          headers: prepared.headers,
          fetch: fetchFor(prepared, onRoute)
        }).pipe(Effect.mapError((error) => scrubbed(prepared, fromList(error))))

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
      const withCap = (connection: Connection) => {
        if (connection.maxConcurrent === null) return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
        let cap = caps.get(connection.id)
        if (!cap) {
          cap = { semaphore: Semaphore.makeUnsafe(connection.maxConcurrent), permits: connection.maxConcurrent }
          caps.set(connection.id, cap)
        } else if (cap.permits !== connection.maxConcurrent) {
          Effect.runSync(cap.semaphore.resize(connection.maxConcurrent))
          cap.permits = connection.maxConcurrent
        }
        return cap.semaphore.withPermits(1)
      }
      const waitForPause = (connectionId: string) =>
        Effect.suspend(() => {
          const until = pausedUntil.get(connectionId) ?? 0
          const wait = until - Date.now()
          return wait > 0 ? Effect.sleep(wait) : Effect.void
        })

      type AttemptOutcome =
        | { readonly ok: true; readonly event: Extract<ProviderEvent, { type: "done" }> }
        | { readonly ok: false; readonly error: ProviderError }

      const attempt = (
        prepared: Prepared,
        model: Model,
        piModel: PiModel<Api>,
        request: StreamRequest,
        offer: (event: ProviderEvent) => void,
        number: number
      ) =>
        Effect.gen(function* () {
          const requestId = uuidv7() as LlmRequestId
          const attribution = request.attribution
          yield* fromStorage(
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
          offer({ type: "attempt", attempt: number, requestId })

          const transcript = normalizeContext(request.context)
          const state = {
            capture: emptyCapture() as Capture,
            status: null as number | null,
            retryAfterMs: null as number | null,
            firstTokenAt: null as number | null,
            partial: null as AssistantMessage | null,
            final: null as AssistantMessage | null
          }
          const onRoute = (description: string) => offer({ type: "route", description })
          if (!OWN_FETCH.has(prepared.api)) {
            const route = yield* network.route(new URL(prepared.baseUrl), prepared.override)
            onRoute(describeRoute(route, new URL(prepared.baseUrl)))
          }

          const run = Effect.tryPromise({
            try: async (signal) => {
              const options = request.options ?? {}
              const events = apis[prepared.api].streamSimple(piModel, transcript, {
                // A keyless local server still needs a value; pi's direct calls require one.
                apiKey: prepared.apiKey ?? "no-key",
                env: {},
                maxRetries: 0,
                signal,
                headers: prepared.headers,
                ...(OWN_FETCH.has(prepared.api) ? { fetch: fetchFor(prepared, onRoute) } : {}),
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
                onProviderStreamEvent: (data) => captureEvent(prepared.api, data, state.capture),
                ...(prepared.api === "anthropic-messages" && options.breakpoints?.length
                  ? {
                      onPayload: (payload: unknown) => {
                        applyAnthropicBreakpoints(
                          payload as Record<string, unknown>,
                          request.context.messages,
                          options.breakpoints!
                        )
                        return payload
                      }
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
            // throw; either way the result is a failed message, so the row still closes.
            Effect.catch((thrown) =>
              Effect.succeed<AssistantMessage>({
                ...aborted(),
                stopReason: "error",
                errorMessage: thrown instanceof Error ? thrown.message : String(thrown)
              })
            )
          )

          /** Closes the ledger row whatever happened, interruption included. */
          const close = (message: AssistantMessage, error: ProviderError | null) =>
            Effect.gen(function* () {
              const { counts, source } = finalCounts(message, state.capture, transcript.messages)
              const cost = recordedCost(counts, state.capture, model.upstream.price ?? null)
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
                    error:
                      error === null ? null : { reason: error.reason, message: error.message, status: error.status }
                  }
                })
                .pipe(Effect.catch((e) => Effect.logError(`could not close ledger row ${requestId}`, e)))
              return { counts, cost }
            })

          const aborted = (): AssistantMessage => ({
            ...(state.partial ?? {
              role: "assistant",
              content: [],
              api: prepared.api,
              provider: piModel.provider,
              model: model.key,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
              },
              timestamp: Date.now()
            }),
            stopReason: "aborted"
          })

          const message = yield* run.pipe(
            Effect.tap((final) => Effect.sync(() => (state.final = final))),
            Effect.onInterrupt(() => close(aborted(), providerError("aborted", "stopped", { afterTokens: true })))
          )
          const classified = classify(
            message,
            { status: state.status, retryAfterMs: state.retryAfterMs, category: state.capture.refusalCategory },
            piModel.contextWindow,
            state.firstTokenAt !== null
          )
          const error = classified === null ? null : scrubbed(prepared, classified)
          const { counts, cost } = yield* close(message, error)
          if (error) return { ok: false, error } satisfies AttemptOutcome
          return { ok: true, event: { type: "done", requestId, message, counts, cost } } satisfies AttemptOutcome
        })

      const stream: ProvidersShape["stream"] = (request) =>
        Stream.callback<ProviderEvent, ProviderError>((queue) =>
          Effect.gen(function* () {
            const offer = (event: ProviderEvent) => void Queue.offerUnsafe(queue, event)
            const prepared = yield* prepare(request.userId, request.connectionId)
            const model = yield* fromStorage(reader.GetModel({ userId: request.userId, modelId: request.modelId }))
            if (model.connectionId !== prepared.connection.id) {
              return yield* providerError("unusable", "that model belongs to another connection")
            }
            const effective = resolveModel(model.key, model.upstream, model.overrides, prepared.connection.compat)
            const piModel = yield* Effect.promise(() => buildPiModel(prepared, model, effective))
            const capped = withCap(prepared.connection)

            for (let n = 0; ; n++) {
              yield* waitForPause(prepared.connection.id)
              const outcome = yield* capped(attempt(prepared, model, piModel, request, offer, n + 1))
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
              yield* Effect.sleep(delayMs)
            }
          }).pipe(
            // A failing callback doesn't end the stream by itself; the queue carries the failure.
            Effect.catch((error: ProviderError) => Queue.fail(queue, error))
          )
        )

      return Providers.of({
        createConnection,
        setKey,
        setHeaders,
        setProxy,
        refreshModels,
        testConnection,
        stream
      })
    })
  )
