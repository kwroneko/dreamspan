// Connections and models (spec/PROVIDERS.md §2, §3). Shared so the client can show the
// same kinds, fields and merged model descriptions the server uses.
import { Schema } from "effect"
import { RefId } from "./library.ts"

/**
 * A provider kind names an upstream API as that upstream defines it, endpoints included;
 * the base URL moves the whole API (owner, 2026-10-10). In picker order: Chat Completions
 * is the default, then Anthropic (owner, 2026-10-10).
 */
export const ProviderKind = Schema.Literals([
  "openai-chat",
  "anthropic",
  "openai-responses",
  "openrouter",
  "deepseek",
  "google"
])
export type ProviderKind = typeof ProviderKind.Type

/** The wire APIs pi-ai implements that our kinds use. */
export const WireApi = Schema.Literals([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
  "google-generative-ai"
])
export type WireApi = typeof WireApi.Type

/** How a kind lists its models (PROVIDERS §3.3). */
export type ModelListFormat = "openai" | "anthropic" | "google"

export interface ProviderKindInfo {
  readonly label: string
  /** The provider string pi-ai uses to pick request dialects. */
  readonly piProvider: string
  readonly api: WireApi
  readonly defaultBaseUrl: string
  readonly modelList: ModelListFormat
  /** Whether a key is optional (local OpenAI-compatible servers often take none). */
  readonly keyOptional: boolean
}

export const providerKinds: Readonly<Record<ProviderKind, ProviderKindInfo>> = {
  "openai-chat": {
    label: "OpenAI Chat Completions",
    piProvider: "openai",
    api: "openai-completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelList: "openai",
    keyOptional: true
  },
  anthropic: {
    label: "Anthropic",
    piProvider: "anthropic",
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    modelList: "anthropic",
    keyOptional: false
  },
  "openai-responses": {
    label: "OpenAI Responses",
    piProvider: "openai",
    api: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelList: "openai",
    keyOptional: false
  },
  openrouter: {
    label: "OpenRouter",
    piProvider: "openrouter",
    api: "openai-completions",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    modelList: "openai",
    keyOptional: false
  },
  deepseek: {
    label: "DeepSeek",
    piProvider: "deepseek",
    api: "openai-completions",
    defaultBaseUrl: "https://api.deepseek.com",
    modelList: "openai",
    keyOptional: false
  },
  google: {
    label: "Google",
    piProvider: "google",
    api: "google-generative-ai",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelList: "google",
    keyOptional: false
  }
}

export const ConnectionId = Schema.String.pipe(Schema.brand("ConnectionId"))
export type ConnectionId = typeof ConnectionId.Type
export const ModelId = Schema.String.pipe(Schema.brand("ModelId"))
export type ModelId = typeof ModelId.Type

/** Raw pi-ai compat overrides: an escape hatch, passed through as given. */
export const Compat = Schema.Record(Schema.String, Schema.Unknown)
export type Compat = typeof Compat.Type

export const ProxyMode = Schema.Literals(["inherit", "direct", "custom"])
export type ProxyMode = typeof ProxyMode.Type

/** A connection as the user sees it. Secrets appear only as whether they're set. */
export class Connection extends Schema.Class<Connection>("Connection")({
  id: ConnectionId,
  name: Schema.String,
  kind: ProviderKind,
  api: WireApi,
  /** Null: the kind's default. */
  baseUrl: Schema.NullOr(Schema.String),
  hasKey: Schema.Boolean,
  /** The key's last 4 characters, so the user can tell which key is stored. */
  keyHint: Schema.NullOr(Schema.String),
  /** Header values often carry credentials, so only names are shown. */
  headerNames: Schema.Array(Schema.String),
  compat: Compat,
  cacheTtlS: Schema.NullOr(Schema.Int),
  maxConcurrent: Schema.NullOr(Schema.Int),
  proxyMode: ProxyMode,
  presetOverrideRefId: Schema.NullOr(RefId),
  rowVersion: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number
}) {}

/** The settings of a connection that aren't secrets. */
export const ConnectionSettings = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  compat: Compat,
  cacheTtlS: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  maxConcurrent: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  presetOverrideRefId: Schema.NullOr(RefId)
})
export type ConnectionSettings = typeof ConnectionSettings.Type

export const Prefill = Schema.Literals(["none", "assistant", "tool_schema"])
export const CacheBreakpoints = Schema.Literals(["auto", "explicit", "none"])

/** Prices per million tokens, as a source reports them; the input to built-in cost formulas. */
export const Price = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.optionalKey(Schema.Number),
  cacheWrite: Schema.optionalKey(Schema.Number),
  /** Total input above this many tokens is billed at the tier's rates, for the whole request. */
  tiers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        inputTokensAbove: Schema.Number,
        input: Schema.Number,
        output: Schema.Number,
        cacheRead: Schema.optionalKey(Schema.Number),
        cacheWrite: Schema.optionalKey(Schema.Number)
      })
    )
  )
})
export type Price = typeof Price.Type

/** The capability fields a user can edit (PROVIDERS §3.2). Every field may be unknown. */
const capabilityFields = {
  name: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.Int),
  maxOutput: Schema.optionalKey(Schema.Int),
  vision: Schema.optionalKey(Schema.Boolean),
  reasoning: Schema.optionalKey(Schema.Boolean),
  /** pi thinking level → provider value; null marks a level unsupported. */
  thinkingLevels: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  tools: Schema.optionalKey(Schema.Boolean),
  prefill: Schema.optionalKey(Prefill),
  cacheTtlS: Schema.optionalKey(Schema.Int),
  cacheBreakpoints: Schema.optionalKey(CacheBreakpoints),
  compat: Schema.optionalKey(Compat),
  sampling: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
}

/** What the user changed. Always wins over the upstream (DATA-MODEL §11). */
export const ModelOverrides = Schema.Struct(capabilityFields)
export type ModelOverrides = typeof ModelOverrides.Type

/** What pi-ai's catalog and the upstream list report. Rewritten by every refresh. */
export const ModelUpstream = Schema.Struct({ ...capabilityFields, price: Schema.optionalKey(Price) })
export type ModelUpstream = typeof ModelUpstream.Type

/** A field's value and where it came from; `unknown` means no source knows it. */
export type Resolved<A> = { readonly value: A; readonly source: "user" | "upstream" | "unknown" }

export interface EffectiveModel {
  readonly name: Resolved<string>
  readonly context: Resolved<number>
  readonly maxOutput: Resolved<number>
  readonly vision: Resolved<boolean>
  readonly reasoning: Resolved<boolean>
  readonly thinkingLevels: Resolved<Readonly<Record<string, string | null>> | null>
  readonly tools: Resolved<boolean>
  readonly prefill: Resolved<typeof Prefill.Type>
  readonly cacheTtlS: Resolved<number | null>
  readonly cacheBreakpoints: Resolved<typeof CacheBreakpoints.Type>
  readonly compat: Readonly<Record<string, unknown>>
  readonly sampling: Readonly<Record<string, unknown>>
  readonly price: ModelUpstream["price"] | null
}

/** Defaults for fields no source knows: the safe choice, shown as unknown, never as "no". */
const DEFAULT_CONTEXT = 8192
const DEFAULT_MAX_OUTPUT = 4096

/**
 * Merges a model's sources, user edits first (PROVIDERS §3.1). `connectionCompat` sits
 * under the model's own compat overrides.
 */
export const resolveModel = (
  key: string,
  upstream: ModelUpstream,
  overrides: ModelOverrides,
  connectionCompat: Compat = {}
): EffectiveModel => {
  const pick = <K extends keyof ModelOverrides, A>(
    field: K,
    fallback: A
  ): Resolved<NonNullable<ModelOverrides[K]> | A> => {
    if (overrides[field] !== undefined) return { value: overrides[field]!, source: "user" }
    if (upstream[field] !== undefined) return { value: upstream[field]!, source: "upstream" }
    return { value: fallback, source: "unknown" }
  }
  return {
    name: pick("name", key),
    context: pick("context", DEFAULT_CONTEXT),
    maxOutput: pick("maxOutput", DEFAULT_MAX_OUTPUT),
    vision: pick("vision", false),
    reasoning: pick("reasoning", false),
    thinkingLevels: pick("thinkingLevels", null),
    tools: pick("tools", false),
    prefill: pick("prefill", "none" as const),
    cacheTtlS: pick("cacheTtlS", null),
    cacheBreakpoints: pick("cacheBreakpoints", "auto" as const),
    compat: { ...connectionCompat, ...upstream.compat, ...overrides.compat },
    sampling: { ...upstream.sampling, ...overrides.sampling },
    price: upstream.price ?? null
  }
}

export class Model extends Schema.Class<Model>("Model")({
  id: ModelId,
  connectionId: ConnectionId,
  key: Schema.String,
  source: Schema.Literals(["fetched", "user"]),
  upstream: ModelUpstream,
  overrides: ModelOverrides,
  hidden: Schema.Boolean,
  fetchedAt: Schema.NullOr(Schema.Number),
  /** Set when the upstream list stopped reporting it. Kept, never deleted. */
  missingSince: Schema.NullOr(Schema.Number),
  rowVersion: Schema.Int
}) {}
