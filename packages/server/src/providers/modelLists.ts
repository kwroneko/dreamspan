// Fetching a connection's model list from its upstream (spec/PROVIDERS.md §3.3). Each
// kind's API is used as that upstream defines it; the base URL moves the whole API.
// What a list reports beats pi-ai's catalog, because it describes the endpoint in use.
import type { ModelEndpoint, ModelUpstream, Price } from "@dreamspan/shared/providers.ts"
import { Effect, Schema } from "effect"

export class ModelListError extends Schema.TaggedError<ModelListError>()("ModelListError", {
  reason: Schema.Literals(["auth", "not_found", "http", "network", "parse"]),
  status: Schema.NullOr(Schema.Int),
  message: Schema.String
}) {}

export interface ListedModel {
  readonly key: string
  readonly upstream: ModelUpstream
}

// --- Response shapes. Only what we read; everything else is ignored. -----------------

const OptionalNumber = Schema.optionalKey(Schema.NullOr(Schema.Number))
/** OpenRouter reports prices as decimal strings in USD per token. */
const PerToken = Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number])))

const OpenAiModel = Schema.Struct({
  id: Schema.String,
  // OpenRouter
  name: Schema.optionalKey(Schema.String),
  context_length: OptionalNumber,
  top_provider: Schema.optionalKey(Schema.NullOr(Schema.Struct({ max_completion_tokens: OptionalNumber }))),
  architecture: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ input_modalities: Schema.optionalKey(Schema.Array(Schema.String)) }))
  ),
  supported_parameters: Schema.optionalKey(Schema.Array(Schema.String)),
  pricing: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ prompt: PerToken, completion: PerToken, input_cache_read: PerToken, input_cache_write: PerToken })
    )
  ),
  // vLLM: the context the server was started with.
  max_model_len: OptionalNumber,
  // Groq and Requesty (`context_window`), Requesty (`max_output_tokens`), xAI's language-models
  // list (`input_modalities`): each documents the field in its models-list response.
  context_window: OptionalNumber,
  max_output_tokens: OptionalNumber,
  input_modalities: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
})
const OpenAiList = Schema.Struct({ data: Schema.Array(OpenAiModel) })

// OpenRouter's `GET /models/{author}/{slug}/endpoints` (https://openrouter.ai/docs/api-reference):
// `data.endpoints[]`, each with `tag` (the routing slug), `provider_name`, `context_length` and
// `pricing` as decimal strings in USD per token, a fractional `discount`, and `overrides` that
// apply under conditions (a prompt length, a UTC window).
const EndpointPricing = Schema.Struct({
  prompt: PerToken,
  completion: PerToken,
  input_cache_read: PerToken,
  input_cache_write: PerToken,
  discount: OptionalNumber,
  overrides: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          prompt: PerToken,
          completion: PerToken,
          input_cache_read: PerToken,
          input_cache_write: PerToken,
          min_prompt_tokens: OptionalNumber,
          utc_days: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
          utc_start: OptionalNumber,
          utc_end: OptionalNumber
        })
      )
    )
  )
})
const EndpointsResponse = Schema.Struct({
  data: Schema.Struct({
    endpoints: Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        provider_name: Schema.optionalKey(Schema.String),
        tag: Schema.optionalKey(Schema.NullOr(Schema.String)),
        context_length: OptionalNumber,
        pricing: Schema.optionalKey(Schema.NullOr(EndpointPricing))
      })
    )
  })
})

const AnthropicModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
  max_input_tokens: OptionalNumber,
  max_tokens: OptionalNumber
})
const AnthropicList = Schema.Struct({
  data: Schema.Array(AnthropicModel),
  has_more: Schema.optionalKey(Schema.Boolean),
  last_id: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const GoogleModel = Schema.Struct({
  name: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  inputTokenLimit: OptionalNumber,
  outputTokenLimit: OptionalNumber,
  supportedGenerationMethods: Schema.optionalKey(Schema.Array(Schema.String)),
  thinking: Schema.optionalKey(Schema.Boolean)
})
const GoogleList = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(GoogleModel)),
  nextPageToken: Schema.optionalKey(Schema.String)
})

// --- Mapping to what users see ------------------------------------------------------

const perMillion = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return undefined
  const n = typeof value === "number" ? value : Number(value)
  // OpenRouter uses -1 for "varies" (its router models).
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : undefined
}

const defined = <A extends Record<string, unknown>>(record: A) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null)) as {
    [K in keyof A]?: NonNullable<A[K]>
  }

const fromOpenAi = (model: typeof OpenAiModel.Type): ModelUpstream => {
  const input = perMillion(model.pricing?.prompt)
  const output = perMillion(model.pricing?.completion)
  const modalities = model.architecture?.input_modalities ?? model.input_modalities ?? undefined
  const parameters = model.supported_parameters
  return defined({
    name: model.name,
    context: model.context_length ?? model.context_window ?? model.max_model_len ?? undefined,
    maxOutput: model.top_provider?.max_completion_tokens ?? model.max_output_tokens ?? undefined,
    vision: modalities ? modalities.includes("image") : undefined,
    tools: parameters ? parameters.includes("tools") : undefined,
    reasoning: parameters ? parameters.includes("reasoning") : undefined,
    compat: parameters?.includes("verbosity") ? { supportsVerbosity: true } : undefined,
    price:
      input !== undefined && output !== undefined
        ? defined({
            input,
            output,
            cacheRead: perMillion(model.pricing?.input_cache_read),
            cacheWrite: perMillion(model.pricing?.input_cache_write)
          })
        : undefined
  }) as ModelUpstream
}

/** An endpoint's price per million tokens, its discount applied; conditional overrides on prompt length become tiers. */
const endpointPrice = (pricing: typeof EndpointPricing.Type | null | undefined): Price | undefined => {
  const keep = 1 - Math.min(Math.max(pricing?.discount ?? 0, 0), 1)
  const scaled = (value: string | number | null | undefined) => {
    const n = perMillion(value)
    // Rounded: 0.0000002 per token times a million is not 0.19999999999999998.
    return n === undefined ? undefined : Number((n * keep).toPrecision(12))
  }
  const input = scaled(pricing?.prompt)
  const output = scaled(pricing?.completion)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = scaled(pricing?.input_cache_read)
  const cacheWrite = scaled(pricing?.input_cache_write)
  const tiers = (pricing?.overrides ?? [])
    .filter(
      (o) =>
        typeof o.min_prompt_tokens === "number" &&
        o.min_prompt_tokens >= 0 &&
        (o.utc_days === undefined || o.utc_days === null) &&
        o.utc_start == null &&
        o.utc_end == null
    )
    .map((o) =>
      defined({
        inputTokensAbove: o.min_prompt_tokens,
        input: scaled(o.prompt) ?? input,
        output: scaled(o.completion) ?? output,
        cacheRead: scaled(o.input_cache_read) ?? cacheRead,
        cacheWrite: scaled(o.input_cache_write) ?? cacheWrite
      })
    )
    .sort((a, b) => a.inputTokensAbove! - b.inputTokensAbove!) as NonNullable<Price["tiers"]>
  return defined({ input, output, cacheRead, cacheWrite, tiers: tiers.length > 0 ? tiers : undefined }) as Price
}

/** The endpoints a decoded response lists; one without a tag or a name is left out. */
const endpointsOf = (response: typeof EndpointsResponse.Type): Array<ModelEndpoint> =>
  response.data.endpoints.flatMap((e) => {
    const tag = e.tag?.trim()
    const name = (e.provider_name ?? e.name)?.trim()
    if (!tag && !name) return []
    const price = endpointPrice(e.pricing)
    return [
      {
        tag: tag || name!,
        name: name || tag!,
        ...(typeof e.context_length === "number" ? { context: e.context_length } : {}),
        ...(price ? { price } : {})
      }
    ]
  })

const fromAnthropic = (model: typeof AnthropicModel.Type): ModelUpstream =>
  defined({
    name: model.display_name,
    context: model.max_input_tokens ?? undefined,
    maxOutput: model.max_tokens ?? undefined
  }) as ModelUpstream

const fromGoogle = (model: typeof GoogleModel.Type): ModelUpstream =>
  defined({
    name: model.displayName,
    context: model.inputTokenLimit ?? undefined,
    maxOutput: model.outputTokenLimit ?? undefined,
    reasoning: model.thinking
  }) as ModelUpstream

// --- Fetching -----------------------------------------------------------------------

export interface ListRequest {
  readonly baseUrl: string
  readonly apiKey: string | null
  readonly headers: Readonly<Record<string, string>>
  readonly fetch: typeof fetch
  /** Removes the connection's secrets; applied before error bodies are shortened. */
  readonly scrub: (text: string) => string
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`

const getJson = (request: ListRequest, url: string, auth: Record<string, string>) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        request.fetch(url, { headers: { accept: "application/json", ...auth, ...request.headers }, signal }),
      catch: (error) => new ModelListError({ reason: "network", status: null, message: String(error) })
    })
    if (!response.ok) {
      const body = yield* Effect.promise(() => response.text().catch(() => ""))
      return yield* new ModelListError({
        reason:
          response.status === 401 || response.status === 403 ? "auth" : response.status === 404 ? "not_found" : "http",
        status: response.status,
        // Scrub first: a key straddling the cut would otherwise survive in part.
        message: `${response.status} ${response.statusText}${body ? `: ${request.scrub(body).slice(0, 300)}` : ""}`
      })
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new ModelListError({ reason: "parse", status: response.status, message: "the list isn't JSON" })
    })
  })

const decode =
  <S extends Schema.Top>(schema: S) =>
  (raw: unknown) =>
    Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError(
        (error) =>
          new ModelListError({ reason: "parse", status: null, message: `unexpected list format: ${error.message}` })
      )
    ) as Effect.Effect<S["Type"], ModelListError>

/** OpenRouter's `author/slug` for a model key; a variant (`:free`, `:nitro`) has its own prices, which the list doesn't give. */
export const endpointsPath = (key: string) => {
  const [author, slug, ...rest] = key.split("/")
  return author && slug && rest.length === 0 && !slug.includes(":") && !author.includes(":")
    ? `models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`
    : null
}

/** Fetches OpenRouter's endpoint list for a model, with the models list's authentication and transport. */
export const fetchEndpoints = (request: ListRequest, key: string) =>
  Effect.gen(function* () {
    const path = endpointsPath(key)
    if (path === null)
      return yield* new ModelListError({ reason: "not_found", status: null, message: "no endpoint list for this id" })
    const raw = yield* getJson(
      request,
      joinUrl(request.baseUrl, path),
      request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}
    )
    return endpointsOf(yield* decode(EndpointsResponse)(raw))
  })

const MAX_PAGES = 20

/** The list formats the built-in kinds use; a plugin kind brings its own lister. */
export const modelListers: Record<
  "openai" | "anthropic" | "google",
  (request: ListRequest) => Effect.Effect<Array<ListedModel>, ModelListError>
> = {
  openai: (request) =>
    getJson(
      request,
      joinUrl(request.baseUrl, "models"),
      request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}
    ).pipe(
      Effect.flatMap(decode(OpenAiList)),
      Effect.map((list) => list.data.map((model) => ({ key: model.id, upstream: fromOpenAi(model) })))
    ),

  anthropic: (request) =>
    Effect.gen(function* () {
      const auth = { "x-api-key": request.apiKey ?? "", "anthropic-version": "2023-06-01" }
      const models: Array<ListedModel> = []
      let after: string | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = joinUrl(
          request.baseUrl,
          `v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`
        )
        const list = yield* getJson(request, url, auth).pipe(Effect.flatMap(decode(AnthropicList)))
        models.push(...list.data.map((model) => ({ key: model.id, upstream: fromAnthropic(model) })))
        if (!list.has_more || !list.last_id) break
        after = list.last_id
      }
      return models
    }),

  google: (request) =>
    Effect.gen(function* () {
      const auth = request.apiKey ? { "x-goog-api-key": request.apiKey } : {}
      const models: Array<ListedModel> = []
      let token: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = joinUrl(
          request.baseUrl,
          `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`
        )
        const list = yield* getJson(request, url, auth).pipe(Effect.flatMap(decode(GoogleList)))
        for (const model of list.models ?? []) {
          // Embedding and other non-chat models can't be used for generation.
          if (model.supportedGenerationMethods && !model.supportedGenerationMethods.includes("generateContent"))
            continue
          models.push({ key: model.name.replace(/^models\//, ""), upstream: fromGoogle(model) })
        }
        token = list.nextPageToken
        if (!token) break
      }
      return models
    })
}
