// The provider registry (spec/PLUGINS.md §3.1, §8): provider kinds, request transforms,
// response observers and cost formulas. The built-ins register through it like any plugin will, so a
// plugin can add a provider, change how requests are shaped (cache breakpoints), or
// replace or disable a built-in.
import type { Api, Message, Model, ProviderStreams } from "@earendil-works/pi-ai"
import type { Effect } from "effect"
import { Context, Layer } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import type { ListedModel, ListRequest, ModelListError } from "./modelLists.ts"
import type { Price } from "@rp/shared/providers.ts"
import type { Cost, TokenCounts } from "@rp/shared/usage.ts"
import type { Capture } from "./usage.ts"

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
}

/** What a transform or observer is looking at: the kind and wire API of the request. */
export interface RequestTarget {
  readonly kind: string
  readonly api: string
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
  readonly upperBound?: (input: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly price: Price | null
  }) => Omit<Cost, "formula"> | null
  readonly cost: (input: {
    readonly counts: TokenCounts
    readonly capture: Capture
    readonly price: Price | null
  }) => Omit<Cost, "formula"> | null
}

export interface ProviderRegistryShape {
  readonly kinds: Registry<ProviderKindEntry>
  readonly transforms: Registry<RequestTransform>
  readonly observers: Registry<ResponseObserver>
  readonly costs: Registry<CostFormula>
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "rp/ProviderRegistry"
) {}

/** An empty registry; `builtins.ts` provides the layer that fills it. */
export const empty = Layer.sync(ProviderRegistry, () =>
  ProviderRegistry.of({
    kinds: makeRegistry<ProviderKindEntry>(),
    transforms: makeRegistry<RequestTransform>(),
    observers: makeRegistry<ResponseObserver>(),
    costs: makeRegistry<CostFormula>()
  })
)
