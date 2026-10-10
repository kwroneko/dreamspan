// pi-ai's built-in model catalog, the lowest-precedence source of a model's description
// (spec/PROVIDERS.md §3.1). Each kind's catalog loads on first use, so a server that
// never uses a provider never holds its catalog in memory.
import type { Api, Model } from "@earendil-works/pi-ai"
import { type ModelUpstream, type ProviderKind, providerKinds } from "@rp/shared/providers.ts"

type Catalog = Readonly<Record<string, Model<Api>>>

const loaders: Record<string, () => Promise<Catalog>> = {
  anthropic: () => import("@earendil-works/pi-ai/providers/anthropic.models").then((m) => m.ANTHROPIC_MODELS),
  openai: () => import("@earendil-works/pi-ai/providers/openai.models").then((m) => m.OPENAI_MODELS),
  openrouter: () => import("@earendil-works/pi-ai/providers/openrouter.models").then((m) => m.OPENROUTER_MODELS),
  deepseek: () => import("@earendil-works/pi-ai/providers/deepseek.models").then((m) => m.DEEPSEEK_MODELS),
  google: () => import("@earendil-works/pi-ai/providers/google.models").then((m) => m.GOOGLE_MODELS)
}

const loaded = new Map<string, Promise<Catalog>>()

/** The pi provider's catalog for a kind, or an empty one. */
export const catalogFor = (kind: ProviderKind): Promise<Catalog> => {
  const provider = providerKinds[kind].piProvider
  let catalog = loaded.get(provider)
  if (!catalog) {
    catalog = (loaders[provider]?.() ?? Promise.resolve({})).catch(() => ({}))
    loaded.set(provider, catalog)
  }
  return catalog
}

/**
 * A catalog entry usable as the base of a request on this kind's connection. A
 * connection is one wire API (DESIGN §9), so an entry for another API (OpenRouter lists
 * some models under anthropic-messages) lends its facts but not its request settings.
 */
export const catalogEntry = async (kind: ProviderKind, key: string) => {
  const entry = (await catalogFor(kind))[key]
  if (!entry) return null
  return { entry, sameApi: entry.api === providerKinds[kind].api }
}

/** What the catalog knows about a model, in the shape users see and can override. */
export const upstreamFromCatalog = (entry: Model<Api>, sameApi: boolean): ModelUpstream => ({
  name: entry.name,
  context: entry.contextWindow,
  maxOutput: entry.maxTokens,
  vision: entry.input.includes("image"),
  reasoning: entry.reasoning,
  ...(entry.thinkingLevelMap ? { thinkingLevels: { ...entry.thinkingLevelMap } } : {}),
  ...(entry.promptCache?.short !== undefined ? { cacheTtlS: entry.promptCache.short } : {}),
  ...(sameApi && entry.compat ? { compat: { ...entry.compat } } : {}),
  price: {
    input: entry.cost.input,
    output: entry.cost.output,
    cacheRead: entry.cost.cacheRead,
    cacheWrite: entry.cost.cacheWrite,
    ...(entry.cost.tiers ? { tiers: entry.cost.tiers.map((tier) => ({ ...tier })) } : {})
  }
})
