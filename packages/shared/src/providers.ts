// Connections and models (spec/PROVIDERS.md §2, §3). Shared so the client can show the
// same kinds, fields and merged model descriptions the server uses.
import { ASSUMED_CONTEXT, ModelSettings } from "./modelSettings.ts"
import { Schema } from "effect"
import { idSchema } from "./id.ts"
import { RefId } from "./library.ts"

/**
 * A provider kind names an upstream API as that upstream defines it, endpoints included;
 * the base URL moves the whole API (owner, 2026-10-10). Kinds come from the server's
 * provider registry, built-in or added by plugins (spec/PLUGINS.md §3.1), so this is an
 * open string checked against the registry where it's used.
 */
export const ProviderKind = Schema.NonEmptyString
export type ProviderKind = typeof ProviderKind.Type

/** A wire API id, as pi-ai names them ("openai-completions", "anthropic-messages", …). */
export const WireApi = Schema.NonEmptyString
export type WireApi = typeof WireApi.Type

/** A provider kind as the client lists it, in picker order. */
export class ProviderKindInfo extends Schema.Class<ProviderKindInfo>("ProviderKindInfo")({
  id: ProviderKind,
  label: Schema.String,
  api: WireApi,
  defaultBaseUrl: Schema.String,
  /** Whether a key is optional (local OpenAI-compatible servers often take none). */
  keyOptional: Schema.Boolean,
  /** The kind answers decision questions (spec/AGENTIC.md §7) and writes no replies. */
  decisions: Schema.optionalKey(Schema.Boolean)
}) {}

export const ConnectionId = idSchema("ConnectionId", "connection")
export type ConnectionId = typeof ConnectionId.Type
export const ModelId = idSchema("ModelId", "model")
export type ModelId = typeof ModelId.Type
export const CredentialId = idSchema("CredentialId", "credential")
export type CredentialId = typeof CredentialId.Type

/**
 * The origin a key is sent to: scheme, host and port, as the URL standard defines it.
 * A key is bound to origins, not full URLs, so changing a path never needs the key again.
 */
export const originOf = (url: string): string | null => {
  try {
    const origin = new URL(url).origin
    return origin === "null" ? null : origin
  } catch {
    return null
  }
}

/**
 * A stored key (spec/PROVIDERS.md §5). Stored once, used by any number of connections,
 * and sent only to the origins it was entered for. Only the last 4 characters show.
 */
export class Credential extends Schema.Class<Credential>("Credential")({
  id: CredentialId,
  name: Schema.String,
  keyHint: Schema.String,
  origins: Schema.Array(Schema.String),
  /** How many connections use it. */
  usedBy: Schema.Int,
  rowVersion: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number
}) {}

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
  /** The credential whose key the connection sends, if any. */
  credentialId: Schema.NullOr(CredentialId),
  credentialName: Schema.NullOr(Schema.String),
  hasKey: Schema.Boolean,
  /** The key's last 4 characters, so the user can tell which key is used. */
  keyHint: Schema.NullOr(Schema.String),
  /** Header values often carry credentials, so only names are shown. */
  headerNames: Schema.Array(Schema.String),
  compat: Compat,
  cacheTtlS: Schema.NullOr(Schema.Int),
  maxConcurrent: Schema.NullOr(Schema.Int),
  proxyMode: ProxyMode,
  presetOverrideRefId: Schema.NullOr(RefId),
  /**
   * A router's prefix on its model ids (`acme.`), left out when matching catalogs. Null until a
   * refresh sets what the list's ids share; empty means none.
   */
  modelIdPrefix: Schema.NullOr(Schema.String),
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
  presetOverrideRefId: Schema.NullOr(RefId),
  /** Left out: unchanged. Null: unset, so the next refresh fills it from the list. */
  modelIdPrefix: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export type ConnectionSettings = typeof ConnectionSettings.Type

const Prefill = Schema.Literals(["none", "assistant", "tool_schema"])
const CacheBreakpoints = Schema.Literals(["auto", "explicit", "none"])

/** Cache layout capabilities, independently overrideable for a serving provider/model. */
export const CacheLayout = Schema.Struct({
  marker: Schema.optionalKey(Schema.Literal("prompt_cache_breakpoint")),
  lookback: Schema.optionalKey(Schema.Boolean),
  summarySplit: Schema.optionalKey(Schema.Boolean),
  maxMarkers: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  minTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})
export type CacheLayout = typeof CacheLayout.Type

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
  settings: Schema.optionalKey(ModelSettings),
  name: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.Int),
  maxOutput: Schema.optionalKey(Schema.Int),
  vision: Schema.optionalKey(Schema.Boolean),
  maxImages: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  midChatSystem: Schema.optionalKey(Schema.Boolean),
  reasoning: Schema.optionalKey(Schema.Boolean),
  /** pi thinking level → provider value; null marks a level unsupported. */
  thinkingLevels: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  tools: Schema.optionalKey(Schema.Boolean),
  prefill: Schema.optionalKey(Prefill),
  cacheTtlS: Schema.optionalKey(Schema.Int),
  cacheBreakpoints: Schema.optionalKey(CacheBreakpoints),
  cacheLayout: Schema.optionalKey(CacheLayout),
  compat: Schema.optionalKey(Compat),
  sampling: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
}

/**
 * A context size the provider stated in a context-length error, saved by the user from that
 * error (never applied without them). Its own source: below the user's setting, above the list.
 */
const LearnedContext = Schema.Struct({
  context: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.Number
})

/** What the user changed. Always wins over the upstream (DATA-MODEL §11). */
export const ModelOverrides = Schema.Struct({ ...capabilityFields, learned: Schema.optionalKey(LearnedContext) })
export type ModelOverrides = typeof ModelOverrides.Type

/**
 * The catalog entry that filled fields the list didn't report: which registered catalog, the
 * entry's id there (a router's or a dated id matches its family's), and the fields it gave.
 */
export const CatalogMatch = Schema.Struct({
  catalog: Schema.String,
  label: Schema.String,
  match: Schema.String,
  fields: Schema.Array(Schema.String)
})
export type CatalogMatch = typeof CatalogMatch.Type

/** The capabilities a compatibility shim fixes: the provider refuses anything else. */
export const FixedCapability = Schema.Literals(["prefill", "thinkingLevels", "tools", "vision", "reasoning"])
export type FixedCapability = typeof FixedCapability.Type

/** A compatibility shim that applies to a model (the server's registered shims), as the user reads it. */
const ModelShim = Schema.Struct({ id: Schema.String, label: Schema.String })

/** What pi-ai's catalog and the upstream list report. Rewritten by every refresh. */
export const ModelUpstream = Schema.Struct({
  ...capabilityFields,
  price: Schema.optionalKey(Price),
  catalog: Schema.optionalKey(CatalogMatch),
  /** The compatibility shims that apply, and the capabilities they fix over the user's edits. */
  shims: Schema.optionalKey(Schema.Array(ModelShim)),
  fixed: Schema.optionalKey(Schema.Array(FixedCapability))
})
export type ModelUpstream = typeof ModelUpstream.Type

/**
 * Where a field's value came from: the user's setting, a limit learned from a provider's error,
 * the provider's list, a catalog matched by the model's id, or `unknown`: no source knows it and
 * a default is used (for the context window, `ASSUMED_CONTEXT`, shown as assumed).
 */
export type FieldSource = "user" | "learned" | "upstream" | "catalog" | "unknown"

/** A field's value and where it came from; `unknown` means no source knows it. */
type Resolved<A> = { readonly value: A; readonly source: FieldSource }

export interface EffectiveModel {
  readonly name: Resolved<string>
  readonly context: Resolved<number>
  readonly maxOutput: Resolved<number>
  readonly vision: Resolved<boolean>
  readonly maxImages: Resolved<number>
  readonly midChatSystem: Resolved<boolean>
  readonly reasoning: Resolved<boolean>
  readonly thinkingLevels: Resolved<Readonly<Record<string, string | null>> | null>
  readonly tools: Resolved<boolean>
  readonly prefill: Resolved<typeof Prefill.Type>
  readonly cacheTtlS: Resolved<number | null>
  readonly cacheBreakpoints: Resolved<typeof CacheBreakpoints.Type>
  readonly cacheLayout: Resolved<CacheLayout>
  readonly compat: Readonly<Record<string, unknown>>
  readonly sampling: Readonly<Record<string, unknown>>
  readonly settings: ModelSettings
  readonly price: ModelUpstream["price"] | null
  /** The catalog entry behind `catalog` sources. */
  readonly catalog: CatalogMatch | null
}

/** Defaults for fields no source knows: the safe choice, shown as unknown, never as "no". */
const DEFAULT_MAX_OUTPUT = 4096

/**
 * Merges a model's sources, user edits first (PROVIDERS §3.1): the user's value, for the context
 * window a limit learned from the provider's error, what the provider's list reports, what a
 * catalog matched by id reports, then a default. `connectionCompat` sits
 * under the model's own compat overrides.
 */
export const resolveModel = (
  key: string,
  upstream: ModelUpstream,
  overrides: ModelOverrides,
  connectionCompat: Compat = {}
): EffectiveModel => {
  const pick = <K extends Exclude<keyof ModelOverrides, "learned">, A>(
    field: K,
    fallback: A
  ): Resolved<NonNullable<ModelOverrides[K]> | A> => {
    const fixed = upstream.fixed?.includes(field as FixedCapability) ?? false
    if (overrides[field] !== undefined && !fixed) return { value: overrides[field]!, source: "user" }
    if (field === "context" && overrides.learned) return { value: overrides.learned.context as A, source: "learned" }
    if (upstream[field] !== undefined)
      return { value: upstream[field]!, source: upstream.catalog?.fields.includes(field) ? "catalog" : "upstream" }
    return { value: fallback, source: "unknown" }
  }
  return {
    name: pick("name", key),
    context: pick("context", ASSUMED_CONTEXT),
    maxOutput: pick("maxOutput", DEFAULT_MAX_OUTPUT),
    vision: pick("vision", false),
    maxImages: pick("maxImages", 4),
    midChatSystem: pick("midChatSystem", false),
    reasoning: pick("reasoning", false),
    thinkingLevels: pick("thinkingLevels", null),
    tools: pick("tools", false),
    prefill: pick("prefill", "none" as const),
    cacheTtlS: pick("cacheTtlS", null),
    cacheBreakpoints: pick("cacheBreakpoints", "auto" as const),
    cacheLayout: pick("cacheLayout", {}),
    compat: { ...connectionCompat, ...upstream.compat, ...overrides.compat },
    sampling: { ...upstream.sampling, ...overrides.sampling },
    settings: { ...upstream.settings, ...overrides.settings },
    price: upstream.price ?? null,
    catalog: upstream.catalog ?? null
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

/** When a model last wrote a reply for the user (their generation requests' latest start). */
export class ModelUse extends Schema.Class<ModelUse>("ModelUse")({
  connectionId: ConnectionId,
  modelId: ModelId,
  lastUsedAt: Schema.Number
}) {}
