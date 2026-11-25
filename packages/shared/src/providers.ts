// Connections and models (spec/PROVIDERS.md §2, §3). Shared so the client can show the
// same kinds, fields and merged model descriptions the server uses.
import { ASSUMED_CONTEXT, ModelSettings } from "./modelSettings.ts"
import { openAIStructuredTools } from "./modelFamilies.ts"
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
/** The most models one hide or show changes: a connection's whole list, with room to spare. */
export const MODELS_HIDDEN_LIMIT = 10_000
/** The models one hide or show changes (`SetModelsHidden`). */
export const ModelIds = Schema.Array(ModelId).check(Schema.isMinLength(1), Schema.isMaxLength(MODELS_HIDDEN_LIMIT))
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

const CacheBreakpoints = Schema.Literals(["auto", "explicit", "none"])

/**
 * What a provider sets up for its connections (`providerDefinitions.ts`), each a default the user
 * can change in the connection's advanced settings. A connection stores only what the user changed.
 */
export const ProviderSettings = Schema.Struct({
  /** Automatic follows measured profiles; dispatcher is an explicit untested override. */
  toolLoading: Schema.optionalKey(Schema.Literals(["auto", "every", "dispatcher"])),
  /** How the key signs requests: one of the provider's `auth` choices. */
  auth: Schema.optionalKey(Schema.String),
  /** Where cache markers go: the provider's default placement, at each reusable section, or none. */
  cacheBreakpoints: Schema.optionalKey(CacheBreakpoints),
  /** A later request reads a cached start before its own marker (Anthropic), or only at a repeated one (AWS Bedrock). */
  lookback: Schema.optionalKey(Schema.Boolean),
  /** Most cache markers in one request, the SDK's own included. */
  maxMarkers: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The smallest prompt start the provider caches, in tokens; unset: as each model documents. */
  minTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Sends the chat's id as `prompt_cache_key`, which OpenAI routes cache reads by. */
  promptCacheKey: Schema.optionalKey(Schema.Boolean),
  /** The cloud region: it sets the default address and what requests are signed for. Unset: read from the address. */
  region: Schema.optionalKey(Schema.String),
  /** The Google Cloud project requests are billed to (Vertex AI). Unset: the service account key's own. */
  project: Schema.optionalKey(Schema.String),
  /**
   * How a cache marker is written on the wire, where the provider's API takes another encoding than
   * the API type's own: `prompt_cache_breakpoint` for OpenAI's APIs on AWS Bedrock.
   */
  cacheMarker: Schema.optionalKey(Schema.Literal("prompt_cache_breakpoint")),
  /** Seconds without a byte from the provider before a request fails as "no response". Unset: DEFAULT_IDLE_TIMEOUT_S. */
  idleTimeoutS: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /**
   * Asks the connection's own server for its prices (`GET {base}/v1/prices`, spec/PRICES.md §4)
   * when models are refreshed. Off unless the user turns it on: nothing is sent otherwise.
   */
  priceEndpoint: Schema.optionalKey(Schema.Boolean)
})
export type ProviderSettings = typeof ProviderSettings.Type

/** How long a request may go without a byte from the provider: thinking models can be silent a long time. */
export const DEFAULT_IDLE_TIMEOUT_S = 300

/** A choice a provider offers (an API type, a way to sign in), as the client lists it. */
const ProviderChoice = Schema.Struct({ id: Schema.String, label: Schema.String, about: Schema.String })

/**
 * A provider as the client lists it, in picker order (the server's `providers` registry): the
 * first choice for a new connection, which sets the API type, address, key and caching defaults.
 */
export class ProviderInfo extends Schema.Class<ProviderInfo>("ProviderInfo")({
  id: Schema.String,
  label: Schema.String,
  about: Schema.String,
  /** The API types it offers, as provider kinds; the first is the default. */
  apis: Schema.Array(ProviderChoice),
  /** Null: there's no default, so the address must be entered. */
  baseUrl: Schema.NullOr(Schema.String),
  /** An example address, for a provider without a default. */
  baseUrlExample: Schema.optionalKey(Schema.String),
  /** The address for a region, `{region}` replaced, for providers whose address names one. */
  regionUrl: Schema.optionalKey(Schema.String),
  /** Regions whose address doesn't follow `regionUrl` (Vertex's `global`, `us` and `eu`). */
  regionUrls: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** How its regions are written: the form's help, an example and the pattern a region must match. */
  regionFormat: Schema.optionalKey(
    Schema.Struct({ about: Schema.String, example: Schema.String, pattern: Schema.String })
  ),
  keyOptional: Schema.Boolean,
  /** The ways a key signs requests; the first is the default. */
  auth: Schema.Array(ProviderChoice),
  /** The defaults of every setting that applies to it. */
  defaults: ProviderSettings,
  /** The settings its connection forms show, in order. */
  settings: Schema.Array(Schema.String),
  /** How long its cache lasts, in the user's terms; null where no lifetime is documented. */
  cacheLifetime: Schema.NullOr(Schema.String),
  /** How it counts and bills tokens, in the user's terms. */
  accounting: Schema.Array(Schema.String),
  /** What it refuses or needs for some models (compatibility shims), in the user's terms. */
  rules: Schema.Array(Schema.String),
  /** The provider answers decision questions (spec/AGENTIC.md §7) and writes no replies. */
  decisions: Schema.optionalKey(Schema.Boolean)
}) {}

/** A connection as the user sees it. Secrets appear only as whether they're set. */
export class Connection extends Schema.Class<Connection>("Connection")({
  id: ConnectionId,
  name: Schema.String,
  /** The provider chosen when it was made (`anthropic-bedrock`): what sets its defaults. */
  provider: Schema.String,
  /** The provider's defaults the user changed; the rest follow the provider. */
  providerSettings: ProviderSettings,
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
  /** The provider's defaults the user changed, replacing the stored ones. Left out: unchanged. */
  providerSettings: Schema.optionalKey(ProviderSettings)
})
export type ConnectionSettings = typeof ConnectionSettings.Type

const Prefill = Schema.Literals(["none", "assistant", "tool_schema"])

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
  /** The (short-TTL) cache write rate. */
  cacheWrite: Schema.optionalKey(Schema.Number),
  /** The long-TTL cache write rate (Anthropic's 1 h, OpenAI's 12 h). Absent: twice `input`. */
  cacheWriteLong: Schema.optionalKey(Schema.Number),
  /** The rate for reasoning tokens when it differs from `output`. Absent: `output`. */
  reasoning: Schema.optionalKey(Schema.Number),
  /** A flat price per request, in `currency`, not per million tokens. */
  perRequest: Schema.optionalKey(Schema.Number),
  /** A label for the amounts; nothing converts. Absent: USD. */
  currency: Schema.optionalKey(Schema.String),
  /** Total input above this many tokens is billed at the tier's rates, for the whole request. */
  tiers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        inputTokensAbove: Schema.Number,
        input: Schema.Number,
        output: Schema.Number,
        cacheRead: Schema.optionalKey(Schema.Number),
        cacheWrite: Schema.optionalKey(Schema.Number),
        cacheWriteLong: Schema.optionalKey(Schema.Number),
        reasoning: Schema.optionalKey(Schema.Number),
        perRequest: Schema.optionalKey(Schema.Number)
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

/** An upstream behind a router (an OpenRouter provider): its slug in the routing, and its name. */
const RouteUpstream = Schema.Struct({ slug: Schema.String, name: Schema.String })

/**
 * A compatibility shim for some upstreams behind a router (DESIGN liveapi2): it applies when the
 * model's routing pins one of them (`pinnedRoute`), wherever the model is resolved, so the
 * assembly applies it at send and the model page shows it for the pinned route.
 */
export const RouteRule = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  upstreams: Schema.Array(RouteUpstream),
  /** What goes wrong there, for a route that isn't pinned ("Prefill fails"). */
  fails: Schema.String,
  capabilities: Schema.optionalKey(Schema.Struct(capabilityFields)),
  fixed: Schema.optionalKey(Schema.Array(FixedCapability))
})
export type RouteRule = typeof RouteRule.Type

/**
 * One OpenRouter endpoint of a model, from its endpoint list (`/models/{author}/{slug}/endpoints`):
 * `tag` is the routing slug (`deepinfra/fp8`), `name` the provider's name, and `price` that
 * endpoint's own price per million tokens.
 */
export const ModelEndpoint = Schema.Struct({
  tag: Schema.String,
  name: Schema.String,
  context: Schema.optionalKey(Schema.Number),
  price: Schema.optionalKey(Price)
})
export type ModelEndpoint = typeof ModelEndpoint.Type

/** A model's endpoint list as fetched; `error` is why the fetch failed (the list is then empty). */
export const ModelEndpoints = Schema.Struct({
  fetchedAt: Schema.Number,
  error: Schema.optionalKey(Schema.String),
  list: Schema.Array(ModelEndpoint)
})
export type ModelEndpoints = typeof ModelEndpoints.Type

/** How long a fetched endpoint list is used before it is fetched again; a failure is retried sooner. */
const ENDPOINTS_TTL_MS = 24 * 60 * 60 * 1000
export const ENDPOINTS_RETRY_MS = 10 * 60 * 1000

export const endpointsStale = (endpoints: ModelEndpoints | undefined, now: number) =>
  endpoints === undefined ||
  now - endpoints.fetchedAt > (endpoints.error === undefined ? ENDPOINTS_TTL_MS : ENDPOINTS_RETRY_MS)

/**
 * A model's price from its connection's own price endpoint (spec/PRICES.md §4.7), when the user
 * opted in. `price` is null when the server lists the model without a known input or output rate.
 */
/**
 * One of the routes a price endpoint says it may send the model to (§4.4): its rates, the model's
 * filling what the route leaves unknown (null when neither knows input and output), and the
 * list prices it is compared with, for display.
 */
export const PriceFeedRoute = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
  upstream: Schema.optionalKey(Schema.String),
  price: Schema.NullOr(Price),
  listInput: Schema.optionalKey(Schema.Number),
  listOutput: Schema.optionalKey(Schema.Number),
  pctOfList: Schema.optionalKey(Schema.Number)
})
export type PriceFeedRoute = typeof PriceFeedRoute.Type

export const PriceFeed = Schema.Struct({
  fetchedAt: Schema.Number,
  validUntil: Schema.optionalKey(Schema.Number),
  etag: Schema.optionalKey(Schema.String),
  currency: Schema.String,
  price: Schema.NullOr(Price),
  available: Schema.optionalKey(Schema.Boolean),
  /** Display only (§4.4): who serves it, and its price as a percentage of the list price. */
  servedBy: Schema.optionalKey(Schema.String),
  pctOfList: Schema.optionalKey(Schema.Number),
  routes: Schema.optionalKey(Schema.Array(PriceFeedRoute))
})

/**
 * What the opt-in price endpoint answered last for a connection (§4.5), kept in memory:
 * `supported` (prices in use), `unsupported` (the server doesn't publish prices; not asked again
 * until the connection changes or models are refreshed), `denied` (the key isn't accepted for
 * prices) or `failed` (asked again after 10 minutes; the last good prices stay).
 */
export const PriceFeedState = Schema.Struct({
  state: Schema.Literals(["supported", "unsupported", "denied", "failed"]),
  /** When it was last asked. */
  at: Schema.Number,
  /** When it will be asked again by itself; null for never (only a refresh asks). */
  nextAt: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String)
})
export type PriceFeedState = typeof PriceFeedState.Type
export type PriceFeed = typeof PriceFeed.Type

/** What pi-ai's catalog and the upstream list report. Rewritten by every refresh. */
export const ModelUpstream = Schema.Struct({
  ...capabilityFields,
  price: Schema.optionalKey(Price),
  catalog: Schema.optionalKey(CatalogMatch),
  /** The compatibility shims that apply, and the capabilities they fix over the user's edits. */
  shims: Schema.optionalKey(Schema.Array(ModelShim)),
  fixed: Schema.optionalKey(Schema.Array(FixedCapability)),
  /** Shims for some of the router's upstreams, applied when the routing pins one. */
  routes: Schema.optionalKey(Schema.Array(RouteRule)),
  /** OpenRouter's endpoint list for the model, fetched when its routing pins one provider. Kept across refreshes. */
  endpoints: Schema.optionalKey(ModelEndpoints),
  /**
   * Where `price` came from (spec/PRICES.md §3.1): the provider's model list, or the built-in table.
   * Absent on models stored before it was recorded: treated as built-in.
   */
  priceFrom: Schema.optionalKey(Schema.Literals(["list", "builtin"])),
  /** The connection's price endpoint's price for the model. Kept across refreshes; rewritten only by a price fetch. */
  priceFeed: Schema.optionalKey(PriceFeed)
})
export type ModelUpstream = typeof ModelUpstream.Type

/** A routing entry's provider: lower case, without a variant (`deepinfra/fp8` is DeepInfra). */
const upstreamSlug = (slug: string) => slug.trim().toLowerCase().split("/")[0]!

const slugsOf = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value)
    ? value.filter((slug): slug is string => typeof slug === "string").map((slug) => upstreamSlug(slug))
    : undefined

/**
 * The upstreams an OpenRouter routing (`provider`) lets serve a request: `only`, narrowed to
 * `order` when fallbacks are off, less `ignore`. Null means any of them, `ignore` aside.
 */
const routeCandidates = (routing: Readonly<Record<string, unknown>> | undefined) => {
  const only = slugsOf(routing?.only)
  const order = routing?.allow_fallbacks === false ? slugsOf(routing?.order) : undefined
  const ignore = new Set(slugsOf(routing?.ignore) ?? [])
  let candidates: ReadonlyArray<string> | null = only ?? order ?? null
  if (only && order) candidates = only.filter((slug) => order.includes(slug))
  return {
    candidates: candidates === null ? null : [...new Set(candidates.filter((slug) => !ignore.has(slug)))],
    ignore
  }
}

/**
 * The one upstream a routing pins (`only` with one entry, or `order` with one and fallbacks
 * off), or null when the router may choose among several.
 */
export const pinnedRoute = (routing: Readonly<Record<string, unknown>> | undefined): string | null => {
  const { candidates } = routeCandidates(routing)
  return candidates?.length === 1 ? candidates[0]! : null
}

/** A provider's name as a routing slug would write it: lower case, letters and digits only. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")

/** The full routing entry (`deepinfra/fp8`) behind the pinned upstream, or its base when entries differ. */
const pinnedEntry = (routing: Readonly<Record<string, unknown>> | undefined, base: string): string => {
  const entries = [routing?.only, routing?.order]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((slug): slug is string => typeof slug === "string")
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => upstreamSlug(slug) === base)
  const distinct = [...new Set(entries)]
  return distinct.length === 1 ? distinct[0]! : base
}

/**
 * The endpoints of the model's list the pinned route names: by tag (a base slug matches every
 * variant of that provider, a full slug that endpoint and the ones beneath it), else by the
 * provider's name written as a slug (`Together` / `together`, `Google Vertex` / `google-vertex`).
 */
export const matchEndpoints = (
  endpoints: ModelEndpoints | undefined,
  routing: Readonly<Record<string, unknown>> | undefined
): ReadonlyArray<ModelEndpoint> => {
  const base = pinnedRoute(routing)
  if (base === null || endpoints === undefined) return []
  const entry = pinnedEntry(routing, base)
  const byTag = endpoints.list.filter((e) => {
    const tag = e.tag.trim().toLowerCase()
    return tag === entry || tag.startsWith(`${entry}/`)
  })
  if (byTag.length > 0) return byTag
  return endpoints.list.filter((e) => squash(upstreamSlug(e.tag)) === squash(base) || squash(e.name) === squash(base))
}

/** What the pinned upstream's price came from, for the model page. */
export type PriceSource =
  | { readonly state: "pinned"; readonly name: string; readonly several: boolean }
  | { readonly state: "fallback"; readonly name: string; readonly reason: "failed" | "unlisted" }

/**
 * A model's price for its routing: when the routing pins one provider and the endpoint list has a
 * priced endpoint for it, that endpoint's price (the dearest if several variants match);
 * otherwise the model's general price, with `source` saying why when a provider is pinned.
 */
export const routedPrice = (
  upstream: ModelUpstream,
  routing: Readonly<Record<string, unknown>> | undefined
): { readonly price: Price | null; readonly source: PriceSource | null } => {
  const general = upstream.price ?? null
  const base = pinnedRoute(routing)
  if (base === null || upstream.endpoints === undefined) return { price: general, source: null }
  const name = upstream.routes?.flatMap((r) => r.upstreams).find((u) => u.slug === base)?.name
  const matches = matchEndpoints(upstream.endpoints, routing).filter((e) => e.price !== undefined)
  if (matches.length === 0) {
    const label = name ?? `${base.charAt(0).toUpperCase()}${base.slice(1)}`
    return {
      price: general,
      source: { state: "fallback", name: label, reason: upstream.endpoints.error !== undefined ? "failed" : "unlisted" }
    }
  }
  const dearest = matches.reduce((a, b) =>
    b.price!.input + b.price!.output > a.price!.input + a.price!.output ? b : a
  )
  return { price: dearest.price!, source: { state: "pinned", name: dearest.name, several: matches.length > 1 } }
}

/** A stored model's price for its routing as saved (user edits over the list's settings). */
export const modelPrice = (model: {
  readonly upstream: ModelUpstream
  readonly overrides: { readonly settings?: typeof ModelSettings.Type | undefined }
}): Price | null =>
  routedPrice(model.upstream, { ...model.upstream.settings, ...model.overrides.settings }.routing).price

const listNames = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

/** A model's upstream with the route rules for its routing's pinned upstream applied. */
export interface RoutedUpstream {
  readonly upstream: ModelUpstream
  /** The pinned upstream's slug, or null. */
  readonly route: string | null
  /** The route rules that apply: the pinned upstream's. */
  readonly applied: ReadonlyArray<RouteRule>
  /** For a route that isn't pinned: what fails on which upstreams it may go to. */
  readonly unpinned: ReadonlyArray<string>
}

/** What a route rule says fails, on the upstream named (`Prefill fails on Together`). */
export const routeFailure = (rule: RouteRule, slug: string | null) =>
  `${rule.fails} on ${rule.upstreams.find((u) => u.slug === slug)?.name ?? listNames(rule.upstreams.map((u) => u.name))}`

/**
 * Applies the route rules of the upstream the routing pins: their capabilities over the list's,
 * their fixed fields, and their names among the shims. Unpinned, none apply, and the notes say
 * what fails where the router may send it ("Prefill fails on Together and StreamLake").
 */
export const routedUpstream = (
  upstream: ModelUpstream,
  routing: Readonly<Record<string, unknown>> | undefined
): RoutedUpstream => {
  const rules = upstream.routes ?? []
  if (rules.length === 0) return { upstream, route: null, applied: [], unpinned: [] }
  const route = pinnedRoute(routing)
  if (route === null) {
    const { candidates, ignore } = routeCandidates(routing)
    const reachable = (slug: string) => (candidates === null ? !ignore.has(slug) : candidates.includes(slug))
    const byFailure = new Map<string, Array<string>>()
    for (const rule of rules) {
      const names = rule.upstreams.filter((u) => reachable(u.slug)).map((u) => u.name)
      if (names.length > 0) byFailure.set(rule.fails, [...(byFailure.get(rule.fails) ?? []), ...names])
    }
    return {
      upstream,
      route,
      applied: [],
      unpinned: [...byFailure].map(([fails, names]) => `${fails} on ${listNames(names)}; pin a provider to be sure.`)
    }
  }
  const applied = rules.filter((rule) => rule.upstreams.some((u) => u.slug === route))
  if (applied.length === 0) return { upstream, route, applied, unpinned: [] }
  const capabilities = Object.assign({}, ...applied.map((rule) => rule.capabilities ?? {})) as ModelUpstream
  const fixed = [...new Set([...(upstream.fixed ?? []), ...applied.flatMap((rule) => rule.fixed ?? [])])]
  return {
    upstream: {
      ...upstream,
      ...capabilities,
      shims: [...(upstream.shims ?? []), ...applied.map((rule) => ({ id: rule.id, label: rule.label }))],
      ...(fixed.length > 0 ? { fixed } : {})
    },
    route,
    applied,
    unpinned: []
  }
}

/**
 * Where a field's value came from: the user's setting, a limit learned from a provider's error,
 * the provider's list, a catalog matched by the model's id, the connection's provider (its
 * default or the user's change to it, for caching), or `unknown`: no source knows it and a
 * default is used (for the context window, `ASSUMED_CONTEXT`, shown as assumed).
 */
export type FieldSource = "user" | "learned" | "upstream" | "catalog" | "provider" | "unknown"

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
  /** Where the price came from when the routing pins a provider: its own price, or why not. */
  readonly priceSource: PriceSource | null
  /** The catalog entry behind `catalog` sources. */
  readonly catalog: CatalogMatch | null
  /** The router upstream the routing pins, its route rules applied (`routedUpstream`). */
  readonly route: Omit<RoutedUpstream, "upstream">
}

type ModelConnection = {
  readonly kind: string
  readonly api: string
  readonly provider?: string | null
}

const claudeAssistantPrefill =
  /(?:^|[./])claude-(?:(?:sonnet|opus|haiku)-4(?:[.-][0-5](?!\d)|(?![.-]\d{1,2}(?:$|[-@:])))|3(?:[.-]\d+)?-(?:sonnet|opus|haiku)|(?:sonnet|opus|haiku)-3(?:[.-]\d+)?)(?:$|[-@:])/

const providerPrefill = (connection: ModelConnection | undefined, key: string): typeof Prefill.Type | undefined => {
  if (!connection) return
  const { kind, api, provider } = connection
  if (
    claudeAssistantPrefill.test(key) &&
    (api === "anthropic-messages" || (kind === "openrouter" && key.startsWith("anthropic/")))
  )
    return "assistant"
  if (kind === "deepseek") return "assistant"
  if (
    (api === "openai-completions" || api === "openai-responses") &&
    openAIStructuredTools.test(key) &&
    (provider === "openai" || (kind === "openrouter" && key.startsWith("openai/")))
  )
    return "tool_schema"
  if (kind === "openrouter" && /^(?:deepseek\/|xiaomi\/mimo)/.test(key)) return "assistant"
}

/** A versioned family can declare vision even when a list supplies only its ID. */
const providerVision = (connection: ModelConnection | undefined, key: string): boolean =>
  !!connection &&
  ((connection.kind === "deepseek" && /(?:^|[./])deepseek-(?:flash|v4-flash(?:-vision-exp)?)(?:$|-)/i.test(key)) ||
    (connection.api === "anthropic-messages" &&
      /(?:^|[./])claude-(?:(?:sonnet|opus|haiku|fable|mythos)-)?[3-9](?:$|[-.@])/i.test(key)) ||
    (connection.kind === "google" &&
      /(?:^|[./])gemini-(?:2\.5|[3-9](?:\.\d+)?)-(?:flash|pro|argon|carbon|hydrogen|neon)(?:$|-)/i.test(key)) ||
    ((connection.provider === "openai" || connection.provider === "openai-bedrock") &&
      (connection.api === "openai-completions" || connection.api === "openai-responses") &&
      openAIStructuredTools.test(key)))

/** Defaults for fields no source knows, shown as unknown, never as "no". Vision is on unless a source says no (owner, 2026-11-25). */
const DEFAULT_MAX_OUTPUT = 4096

/**
 * Merges a model's sources, user edits first (PROVIDERS §3.1): the user's value, for the context
 * window a limit learned from the provider's error, what the provider's list reports, what a
 * catalog matched by id reports, then a default. `connectionCompat` sits
 * under the model's own compat overrides. `provider` is the connection's provider settings
 * (`resolveProviderSettings`): its cache layout sits under the model's own edits, over the list.
 * The route rules of an upstream the model's routing pins apply over the list (`routedUpstream`).
 */
export const resolveModel = (
  key: string,
  listed: ModelUpstream,
  overrides: ModelOverrides,
  connectionCompat: Compat = {},
  provider: ProviderSettings = {},
  connection?: ModelConnection
): EffectiveModel => {
  const routing = { ...listed.settings, ...overrides.settings }.routing
  const { upstream, ...route } = routedUpstream(listed, routing)
  const priced = routedPrice(upstream, routing)
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
  const layout: CacheLayout = {
    ...(provider.cacheMarker !== undefined ? { marker: provider.cacheMarker } : {}),
    ...(provider.lookback !== undefined ? { lookback: provider.lookback } : {}),
    ...(provider.maxMarkers !== undefined ? { maxMarkers: provider.maxMarkers } : {}),
    ...(provider.minTokens !== undefined ? { minTokens: provider.minTokens } : {})
  }
  const breakpoints = pick("cacheBreakpoints", "auto" as const)
  const cacheLayout = pick("cacheLayout", {})
  // Reasoning nobody reports is assumed on (owner, 2026-11-23: "Every model today has thinking"),
  // so a chosen effort is sent. Assumed, it changes nothing else: no effort sends no "off" value
  // (the model's own default stands), and system messages keep the system role.
  const reasoning = pick("reasoning", true)
  const assumed = reasoning.source === "unknown"
  const levels = pick("thinkingLevels", null)
  const vision = pick("vision", true)
  const prefill = pick("prefill", "none" as const)
  const defaultPrefill = prefill.source === "unknown" ? providerPrefill(connection, key) : undefined
  return {
    name: pick("name", key),
    context: pick("context", ASSUMED_CONTEXT),
    maxOutput: pick("maxOutput", DEFAULT_MAX_OUTPUT),
    vision:
      vision.source === "unknown" && providerVision(connection, key) ? { value: true, source: "provider" } : vision,
    maxImages: pick("maxImages", 4),
    midChatSystem: pick("midChatSystem", false),
    reasoning,
    thinkingLevels:
      assumed && levels.value?.off === undefined ? { ...levels, value: { ...levels.value, off: null } } : levels,
    tools: pick("tools", false),
    prefill: defaultPrefill === undefined ? prefill : { value: defaultPrefill, source: "provider" },
    cacheTtlS: pick("cacheTtlS", null),
    cacheBreakpoints:
      breakpoints.source === "user" || provider.cacheBreakpoints === undefined
        ? breakpoints
        : { value: provider.cacheBreakpoints, source: "provider" },
    cacheLayout:
      cacheLayout.source === "user"
        ? { value: { ...upstream.cacheLayout, ...layout, ...cacheLayout.value }, source: "user" }
        : Object.keys(layout).length === 0
          ? cacheLayout
          : { value: { ...cacheLayout.value, ...layout }, source: "provider" },
    compat: {
      ...(assumed ? { supportsDeveloperRole: false } : {}),
      ...connectionCompat,
      ...upstream.compat,
      ...overrides.compat
    },
    sampling: { ...upstream.sampling, ...overrides.sampling },
    settings: { ...upstream.settings, ...overrides.settings },
    price: priced.price,
    priceSource: priced.source,
    catalog: upstream.catalog ?? null,
    route
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
