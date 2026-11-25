// pi-ai's built-in model catalog, the lowest-precedence source of a model's description
// (spec/PROVIDERS.md §3.1). A kind's catalog loads on first use, so a server that never
// uses a provider never holds its catalog in memory.
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelUpstream } from "@dreamspan/shared/providers.ts"
import { Effect } from "effect"
import { documentedCachePolicy } from "./cachePolicy.ts"
import type { ListedModel } from "./modelLists.ts"
import { supplementPrice } from "./prices/index.ts"
import type { Catalog, ProviderKindEntry } from "./registry.ts"

/** Loaders for pi-ai's per-provider catalogs, by pi provider id. */
export const piCatalogs: Record<string, () => Promise<Catalog>> = {
  anthropic: () => import("@earendil-works/pi-ai/providers/anthropic.models").then((m) => m.ANTHROPIC_MODELS),
  "amazon-bedrock": () =>
    import("@earendil-works/pi-ai/providers/amazon-bedrock.models").then((m) => m.AMAZON_BEDROCK_MODELS),
  openai: () => import("@earendil-works/pi-ai/providers/openai.models").then((m) => m.OPENAI_MODELS),
  openrouter: () => import("@earendil-works/pi-ai/providers/openrouter.models").then((m) => m.OPENROUTER_MODELS),
  deepseek: () => import("@earendil-works/pi-ai/providers/deepseek.models").then((m) => m.DEEPSEEK_MODELS),
  google: () => import("@earendil-works/pi-ai/providers/google.models").then((m) => m.GOOGLE_MODELS)
}

const loaded = new WeakMap<() => Promise<Catalog>, Promise<Catalog>>()

const catalogOf = (kind: ProviderKindEntry): Promise<Catalog> => {
  const load = kind.catalog
  if (!load) return Promise.resolve({})
  let catalog = loaded.get(load)
  if (!catalog) {
    catalog = load().catch(() => ({}))
    loaded.set(load, catalog)
  }
  return catalog
}

/**
 * A catalog entry for a model of this kind. A connection is one wire API (DESIGN §9), so
 * an entry for another API (OpenRouter lists some models under anthropic-messages) lends
 * its facts but not its request settings.
 */
export const catalogEntry = async (kind: ProviderKindEntry, key: string) => {
  const catalog = await catalogOf(kind)
  // Model ids come from upstream: "constructor" or "__proto__" mustn't read the prototype.
  const entry = Object.hasOwn(catalog, key) ? catalog[key] : undefined
  if (!entry) return null
  return { entry, sameApi: entry.api === kind.api }
}

/** What the catalog knows about a model, in the shape users see and can override. */
const upstreamFromCatalog = (entry: Model<Api>, sameApi: boolean): ModelUpstream => {
  const cache = documentedCachePolicy({ provider: entry.provider, api: entry.api, model: entry.id })
  return {
    name: entry.name,
    context: entry.contextWindow,
    maxOutput: entry.maxTokens,
    vision: entry.input.includes("image"),
    reasoning: entry.reasoning,
    ...(entry.thinkingLevelMap ? { thinkingLevels: { ...entry.thinkingLevelMap } } : {}),
    ...(cache ? { cacheTtlS: cache.ttlS } : {}),
    ...(sameApi && entry.compat ? { compat: { ...entry.compat } } : {}),
    price: {
      input: entry.cost.input,
      output: entry.cost.output,
      cacheRead: entry.cost.cacheRead,
      cacheWrite: entry.cost.cacheWrite,
      ...(entry.cost.tiers ? { tiers: entry.cost.tiers.map((tier) => ({ ...tier })) } : {})
    }
  }
}

/**
 * A listed model's price and where it came from (PRICES §3.1): the list's own price, else the
 * built-in table (our supplement replacing pi-ai's entry whole, else pi-ai's catalog).
 */
const pricedFrom = (
  kind: ProviderKindEntry,
  model: ListedModel,
  catalog: ModelUpstream["price"]
): Pick<ModelUpstream, "price" | "priceFrom"> => {
  // A model already described once (a kind's lister applies this too) keeps the built-in mark.
  if (model.upstream.price !== undefined && model.upstream.priceFrom !== "builtin")
    return { price: model.upstream.price, priceFrom: "list" }
  const table = supplementPrice({ provider: kind.piProvider }, model.key, Date.now()) ?? catalog
  return table === undefined ? {} : { price: table, priceFrom: "builtin" }
}

/**
 * Listed models merged over what the kind's catalog knows: the list's own fields win,
 * and the catalog fills the rest (price, thinking levels, compat).
 */
export const withCatalog = (kind: ProviderKindEntry, listed: ReadonlyArray<ListedModel>) =>
  Effect.forEach(listed, (model) =>
    Effect.promise(() => catalogEntry(kind, model.key)).pipe(
      Effect.map((found): ListedModel => {
        if (!found) return { key: model.key, upstream: { ...model.upstream, ...pricedFrom(kind, model, undefined) } }
        const fromCatalog = upstreamFromCatalog(found.entry, found.sameApi)
        const fields = Object.keys(fromCatalog).filter(
          (field) => field !== "price" && model.upstream[field as keyof ModelUpstream] === undefined
        )
        return {
          key: model.key,
          upstream: {
            ...fromCatalog,
            ...model.upstream,
            ...(model.upstream.compat && fromCatalog.compat
              ? { compat: { ...fromCatalog.compat, ...model.upstream.compat } }
              : {}),
            ...pricedFrom(kind, model, fromCatalog.price),
            ...(fields.length
              ? { catalog: { catalog: "pi-ai", label: "pi-ai's catalog", match: found.entry.id, fields } }
              : {})
          }
        }
      })
    )
  )
