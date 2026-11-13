// The provider registry (spec/PLUGINS.md §3.1, §8): provider kinds, request transforms,
// response observers and cost formulas. The built-ins register through it like any plugin will, so a
// plugin can add a provider, change how requests are shaped (cache breakpoints), or
// replace or disable a built-in.
import type { Api, Message, Model, ProviderStreams } from "@earendil-works/pi-ai"
import { Context, Effect, Layer } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import type { ListedModel, ListRequest, ModelListError } from "./modelLists.ts"
import type { Price, ProviderSettings } from "@rp/shared/providers.ts"
import type { ProviderDefinition } from "@rp/shared/providerDefinitions.ts"
import type { Cost, TokenCounts } from "@rp/shared/usage.ts"
import type { UserPricing } from "./userCosts.ts"
import type { Capture } from "./usage.ts"
import type { ImageTokenCounter } from "./imageCounters.ts"
import type { TextTokenCounter } from "./textCounters.ts"
import type { ModelCatalog } from "./contextCatalog.ts"
import type { ContextLimitParser } from "./contextLimits.ts"
import type { CompatShim } from "./shims.ts"
import { ProviderDefinitions } from "./definitions.ts"

export type Catalog = Readonly<Record<string, Model<Api>>>

/** A provider kind: an upstream API as that upstream defines it (DESIGN §9). */
export interface ProviderKindEntry {
  readonly id: string
  readonly label: string
  /** The provider string pi-ai uses to pick request dialects. */
  readonly piProvider: string
  /** The wire API id. */
  readonly api: string
  /** The wire API implementation: one of pi-ai's, or the plugin's own. */
  readonly streams: ProviderStreams
  /** Whether the implementation takes our `fetch`. One that doesn't can't be routed through a proxy. */
  readonly acceptsFetch: boolean
  readonly defaultBaseUrl: string
  /** Whether a key is optional (local OpenAI-compatible servers often take none). */
  readonly keyOptional: boolean
  /** Fetches the upstream's model list. */
  readonly listModels: (request: ListRequest) => Effect.Effect<ReadonlyArray<ListedModel>, ModelListError>
  /** Known models' facts (pi-ai's catalog for built-ins), loaded on first use. */
  readonly catalog?: () => Promise<Catalog>
  /** When this provider makes a prefix write readable; defaults to first chunk, 10 s. */
  readonly cacheRelease?: import("./cacheStagger.ts").CacheReleasePolicy
  /**
   * A kind that answers decision questions (spec/AGENTIC.md §7) instead of writing replies: its
   * wire call. Such a kind's connections are refused for replies and left out of model pickers.
   */
  readonly decide?: DecisionWire
  /**
   * Wraps the request's `fetch` for a provider whose framing or signing differs from the wire API
   * the SDK speaks (Anthropic Messages on AWS Bedrock: `bedrock.ts`). It's given the controlled
   * fetch, so routing, redirects and the request's secrets stay ours. The SDK is then given a
   * placeholder key, never the stored one: the transport authorizes from `request.apiKey`.
   */
  readonly transport?: (fetch: typeof globalThis.fetch, request: KindTransportRequest) => typeof globalThis.fetch
  /** Parts of a key that are secrets on their own (an AWS access key ID and its secret). */
  readonly secretsOf?: (apiKey: string) => ReadonlyArray<string>
  /** Its model list is a catalog, fetched from nowhere: a test of the connection sends nothing. */
  readonly listsCatalog?: boolean
}

/** What a kind's transport is given besides the fetch it wraps. */
export interface KindTransportRequest {
  readonly apiKey: string | null
  readonly baseUrl: string
  readonly settings: ProviderSettings
  /**
   * The connection's fetch, routed as the provider request is but not observed as it: for a
   * kind's own requests that aren't the reply (Vertex's sign-in), so the ledger, the cache
   * identity and the usage capture see the provider request alone.
   */
  readonly aside?: typeof globalThis.fetch
}

/** One decision request on the wire (reference-harness's System-One body), sent with the connection's fetch. */
export interface DecisionWire {
  readonly decide: (request: {
    readonly baseUrl: string
    readonly apiKey: string | null
    readonly headers: Readonly<Record<string, string>>
    readonly fetch: typeof globalThis.fetch
    readonly body: {
      readonly model: string
      readonly state: unknown
      readonly questions: Readonly<Record<string, import("@rp/shared/decisions.ts").DecisionQuestion>>
    }
    readonly signal: AbortSignal
  }) => Promise<{
    readonly status: number
    /** The parsed JSON body; null when it wasn't JSON. */
    readonly body: unknown
    readonly retryAfterMs: number | null
    /** The start of a failed response's body, for its error. */
    readonly detail?: string
  }>
}

/** What a transform or observer is looking at: the kind and wire API of the request. */
export interface RequestTarget {
  readonly kind: string
  readonly api: string
  /** The connection's provider (providerDefinitions.ts), where one is known. */
  readonly provider?: string
  /** The model's key on its connection (`anthropic/claude-haiku-4.5`); absent where no model applies. */
  readonly model?: string
}

/**
 * The automatic layout's reusable endpoint: the last message the next request repeats (the
 * assembly's last breakpoint), and how many messages the assembly built. Messages from `end` on
 * are a tool loop's, which its next request repeats too.
 */
export interface StableEndpoint {
  readonly message: number
  readonly end: number
}

/** Rewrites the payload pi-ai built, before it's sent (pi-ai's `onPayload`). */
export interface RequestTransform {
  readonly id: string
  readonly appliesTo: (target: RequestTarget) => boolean
  /** Returns the payload to send: the same object changed in place, or a new one.
   * Retain message objects (or spread them) to preserve inspector provenance symbols.
   * Freshly constructed messages are unassigned; symbols never enter serialized HTTP.
   */
  readonly transform: (
    payload: Record<string, unknown>,
    request: {
      readonly target: RequestTarget
      readonly messages: ReadonlyArray<Message>
      readonly breakpoints: ReadonlyArray<number>
      readonly preserveBreakpoints?: boolean
      readonly cacheLayout?: import("@rp/shared/providers.ts").CacheLayout
      /** Set for the automatic layout (no explicit breakpoints) when the assembly has an endpoint. */
      readonly stable?: StableEndpoint
      readonly cacheRetention?: "none" | "short" | "long"
      readonly sessionId?: string
      /** The connection's provider settings in effect: its defaults with the user's changes. */
      readonly settings?: ProviderSettings
      /** An agent run's deferred tools and where they were loaded (spec/TOOL-LOADING.md §4). */
      readonly toolLoading?: import("./toolLoading.ts").ToolLoadingRequest
    }
  ) => Record<string, unknown>
}

/** Reads the provider's raw stream events (pi-ai's `onProviderStreamEvent`), e.g. for usage. */
export interface ResponseObserver {
  readonly id: string
  readonly appliesTo: (target: RequestTarget) => boolean
  readonly observe: (data: unknown, capture: Capture) => void
}

/**
 * Prices a finished request for the ledger (PROVIDERS §9.3). Formulas are tried newest
 * registration first, and the first that returns a cost wins: a user's or a plugin's
 * formula goes before the built-ins. Returning null passes to the next.
 */
export interface CostFormula {
  readonly id: string
  readonly appliesTo: (target: RequestTarget & { readonly model: string }) => boolean
  /** Claims admission even when upstream-only pricing cannot produce a point estimate. */
  readonly reserves?: (input: { readonly pricing?: UserPricing }) => boolean
  readonly upperBound?: (input: {
    readonly pricing?: UserPricing
    readonly inputTokens: number
    readonly outputTokens: number
    readonly price: Price | null
  }) => Omit<Cost, "formula"> | null
  /** Undefined passes through; null means no single-currency estimate is possible. */
  readonly estimate?: (input: {
    readonly pricing?: UserPricing
    readonly counts: TokenCounts
    readonly capture: Capture
    readonly price: Price | null
  }) => (Omit<Cost, "formula"> & { readonly formula?: string }) | null | undefined
  readonly cost: (input: {
    readonly pricing?: UserPricing
    readonly counts: TokenCounts
    readonly capture: Capture
    readonly price: Price | null
  }) => (Omit<Cost, "formula"> & { readonly formula?: string }) | null
}

export interface ProviderRegistryShape {
  /** The first choice for a connection: its API types, address, key and caching defaults. */
  readonly providers: Registry<ProviderDefinition>
  readonly kinds: Registry<ProviderKindEntry>
  readonly transforms: Registry<RequestTransform>
  readonly observers: Registry<ResponseObserver>
  readonly costs: Registry<CostFormula>
  /** Exact image token counting endpoints (ARCHITECTURE §6). */
  readonly imageCounters: Registry<ImageTokenCounter>
  /** The model's own text tokenizer, local or its provider's endpoint (ARCHITECTURE §6). */
  readonly textCounters: Registry<TextTokenCounter>
  /** Catalogs matched by model id, for a window the list doesn't report; newest asked first. */
  readonly catalogs: Registry<ModelCatalog>
  /** Readers of the limit a context-length error states; newest asked first. */
  readonly contextLimits: Registry<ContextLimitParser>
  /** Per provider kind and model pattern: what a provider refuses or needs (shims.ts). */
  readonly shims: Registry<CompatShim>
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "rp/ProviderRegistry"
) {}

/** An empty registry; `builtins.ts` provides the layer that fills it. */
export const empty = Layer.effect(
  ProviderRegistry,
  Effect.map(ProviderDefinitions, (providers) =>
    ProviderRegistry.of({
      providers,
      kinds: makeRegistry<ProviderKindEntry>(),
      transforms: makeRegistry<RequestTransform>(),
      observers: makeRegistry<ResponseObserver>(),
      costs: makeRegistry<CostFormula>(),
      imageCounters: makeRegistry<ImageTokenCounter>(),
      textCounters: makeRegistry<TextTokenCounter>(),
      catalogs: makeRegistry<ModelCatalog>(),
      contextLimits: makeRegistry<ContextLimitParser>(),
      shims: makeRegistry<CompatShim>()
    })
  )
).pipe(Layer.provideMerge(ProviderDefinitions.layer))
