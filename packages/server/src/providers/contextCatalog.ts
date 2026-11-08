// Catalogs matched by model id: a model's window and output limit when the provider's list
// doesn't report them (an OpenAI-compatible /models, a proxy in front of Claude, GPT or Gemini,
// a model the user added by id). Each is a registered part (spec/PLUGINS.md §3.1): a plugin can
// add one, override a built-in or disable it. The newest registration is asked first.
import type { Api, Model } from "@earendil-works/pi-ai"
import type { CatalogMatch, ModelUpstream } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import type { ListedModel } from "./modelLists.ts"

/** What a catalog knows of a model: the id of the entry it matched, and its limits. */
interface CatalogFacts {
  readonly match: string
  readonly context?: number
  readonly maxOutput?: number
}

export interface ModelCatalog {
  readonly id: string
  /** How the source is named to the user ("pi-ai's catalog"). */
  readonly label: string
  /** The model's facts, by its id as the connection's upstream names it; null when unknown. */
  readonly lookup: (key: string, kind: string) => Promise<CatalogFacts | null>
}

/**
 * An id in its comparable form: lowercase, without a router's or a resource's prefix
 * (`anthropic/`, `models/`, `~`), a Bedrock region and vendor (`us.anthropic.`), a variant
 * tag (`:free`, `:batch`, Bedrock's `:0`), a Vertex version (`@20250514`) or Bedrock's `-v1`,
 * and with `4.5` written `4-5`, as Anthropic writes it.
 */
export const baseModelId = (key: string) =>
  key
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/^~/, "")
    .replace(/^(?:(?:us|eu|apac|global|au|jp)\.)?(?:anthropic|meta|mistral|amazon|cohere|deepseek|openai|google)\./, "")
    .replace(/[:@].*$/, "")
    .replace(/(\d)\.(?=\d)/g, "$1-")
    .replace(/-v\d+$/, "")

/** A date or snapshot tag at the end of an id: `-20250514`, `-2024-08-06`, `-0613`, `-05-06`, `-latest`. */
const SNAPSHOT = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}(?:-\d{2,4})?|\d{4}|latest|exp)$/

const withoutSnapshots = (id: string) => {
  const stems = [id]
  for (let next = id.replace(SNAPSHOT, ""); next !== stems.at(-1); next = next.replace(SNAPSHOT, "")) stems.push(next)
  return stems
}

/**
 * The forms an id is looked up under, most specific first: itself, without its snapshot tags,
 * then without trailing segments down to two (`claude-opus-4-5-thinking` → `claude-opus-4-5`).
 */
export const idCandidates = (key: string): ReadonlyArray<string> => {
  const stems = withoutSnapshots(baseModelId(key))
  const segments = stems.at(-1)!.split("-")
  for (let n = segments.length - 1; n >= 2; n--) stems.push(segments.slice(0, n).join("-"))
  return [...new Set(stems.filter((stem) => stem !== ""))]
}

type Catalog = Readonly<Record<string, Model<Api>>>

/** pi-ai's catalogs consulted by id, first-party providers before routers. */
const piSources: ReadonlyArray<() => Promise<Catalog>> = [
  () => import("@earendil-works/pi-ai/providers/anthropic.models").then((m) => m.ANTHROPIC_MODELS),
  () => import("@earendil-works/pi-ai/providers/openai.models").then((m) => m.OPENAI_MODELS),
  () => import("@earendil-works/pi-ai/providers/google.models").then((m) => m.GOOGLE_MODELS),
  () => import("@earendil-works/pi-ai/providers/deepseek.models").then((m) => m.DEEPSEEK_MODELS),
  () => import("@earendil-works/pi-ai/providers/mistral.models").then((m) => m.MISTRAL_MODELS),
  () => import("@earendil-works/pi-ai/providers/xai.models").then((m) => m.XAI_MODELS),
  () => import("@earendil-works/pi-ai/providers/moonshotai.models").then((m) => m.MOONSHOTAI_MODELS),
  () => import("@earendil-works/pi-ai/providers/zai.models").then((m) => m.ZAI_MODELS),
  () => import("@earendil-works/pi-ai/providers/openrouter.models").then((m) => m.OPENROUTER_MODELS)
]

interface Index {
  /** By `baseModelId`. */
  readonly exact: ReadonlyMap<string, Model<Api>>
  /** By the same without snapshot tags, so `mistral-large` finds `mistral-large-2411`. */
  readonly stems: ReadonlyMap<string, Model<Api>>
}

let piIndex: Promise<Index> | null = null

const loadPiIndex = () =>
  (piIndex ??= Promise.all(piSources.map((load) => load().catch((): Catalog => ({})))).then((catalogs) => {
    const exact = new Map<string, Model<Api>>()
    const stems = new Map<string, Model<Api>>()
    for (const catalog of catalogs) {
      for (const [key, entry] of Object.entries(catalog)) {
        const [base, ...rest] = withoutSnapshots(baseModelId(key))
        if (!exact.has(base!)) exact.set(base!, entry)
        for (const stem of rest) if (!stems.has(stem)) stems.set(stem, entry)
      }
    }
    return { exact, stems }
  }))

/** pi-ai's catalogs, matched by id whatever router or dated name the upstream uses. */
export const piModelCatalog: ModelCatalog = {
  id: "pi-ai",
  label: "pi-ai's catalog",
  lookup: async (key) => {
    const index = await loadPiIndex()
    for (const candidate of idCandidates(key)) {
      const entry = index.exact.get(candidate) ?? index.stems.get(candidate)
      if (entry) return { match: entry.id, context: entry.contextWindow, maxOutput: entry.maxTokens }
    }
    return null
  }
}

/**
 * Current model families by id prefix (as of 2026-10), for ids no catalog lists: the smallest
 * window each family's current models have, so a guess never overfills. Most specific first.
 */
const MODEL_FAMILIES: ReadonlyArray<{
  readonly family: string
  readonly pattern: RegExp
  readonly context: number
}> = [
  { family: "claude", pattern: /^claude-/, context: 200_000 },
  { family: "gpt-5-chat", pattern: /^gpt-5(?:-\d+)?-chat/, context: 128_000 },
  { family: "gpt-5", pattern: /^gpt-[56](?:-|$)/, context: 400_000 },
  { family: "gpt-4.1", pattern: /^gpt-4-1(?:-|$)/, context: 1_047_576 },
  { family: "gpt-4o", pattern: /^(?:chatgpt-)?gpt-4o/, context: 128_000 },
  { family: "o-series", pattern: /^o[134](?:-|$)/, context: 200_000 },
  { family: "gpt-oss", pattern: /^gpt-oss/, context: 131_072 },
  { family: "gemini", pattern: /^gemini-(?:[2-9]|1-5)/, context: 1_048_576 },
  { family: "deepseek", pattern: /^deepseek-/, context: 128_000 },
  { family: "grok-4", pattern: /^grok-4/, context: 256_000 },
  { family: "grok", pattern: /^grok-/, context: 131_072 },
  { family: "mistral", pattern: /^(?:mistral-(?:large|medium)|magistral)/, context: 128_000 },
  { family: "llama-3", pattern: /^(?:meta-)?llama-3-[1-9]/, context: 128_000 },
  { family: "kimi-k2", pattern: /^kimi-k2/, context: 131_072 }
]

/** The maintained family table above, matched on the id's comparable form. */
export const familyCatalog: ModelCatalog = {
  id: "families",
  label: "the built-in model family table",
  lookup: async (key) => {
    const id = baseModelId(key)
    const found = MODEL_FAMILIES.find((entry) => entry.pattern.test(id))
    return found ? { match: found.family, context: found.context } : null
  }
}

export const builtinModelCatalogs: ReadonlyArray<ModelCatalog> = [familyCatalog, piModelCatalog]

/** The first catalog's facts for a model, newest registration first. */
export const lookupCatalogs = async (catalogs: ReadonlyArray<ModelCatalog>, key: string, kind: string) => {
  for (const catalog of [...catalogs].reverse()) {
    const facts = await catalog.lookup(key, kind).catch(() => null)
    if (facts && (facts.context !== undefined || facts.maxOutput !== undefined)) return { catalog, facts }
  }
  return null
}

/**
 * Fills a model's window (and its output limit, when also missing) from the registered catalogs
 * when neither the list nor the kind's own catalog reported it, recording where they came from.
 */
const fillFromCatalogs = async (
  catalogs: ReadonlyArray<ModelCatalog>,
  kind: string,
  model: ListedModel
): Promise<ListedModel> => {
  if (model.upstream.context !== undefined) return model
  const found = await lookupCatalogs(catalogs, model.key, kind)
  if (!found) return model
  const filled: Partial<Pick<ModelUpstream, "context" | "maxOutput">> = {
    ...(found.facts.context !== undefined ? { context: found.facts.context } : {}),
    ...(found.facts.maxOutput !== undefined && model.upstream.maxOutput === undefined
      ? { maxOutput: found.facts.maxOutput }
      : {})
  }
  const catalog: CatalogMatch = {
    catalog: found.catalog.id,
    label: found.catalog.label,
    match: found.facts.match,
    fields: Object.keys(filled)
  }
  return { key: model.key, upstream: { ...model.upstream, ...filled, catalog } }
}

export const withCatalogs = (catalogs: ReadonlyArray<ModelCatalog>, kind: string, listed: ReadonlyArray<ListedModel>) =>
  Effect.forEach(listed, (model) => Effect.promise(() => fillFromCatalogs(catalogs, kind, model)))

/**
 * The prefix a router puts on its model ids (`acme.gpt-5.4-nano`, `acme.o3`), when
 * at least half the listed ids share one: a lowercase segment and a dot before a letter. Vendor
 * and region prefixes (`anthropic.`, `us.`) are already left out by `baseModelId`; detecting one
 * of them changes no match.
 */
export const detectModelIdPrefix = (keys: ReadonlyArray<string>): string | null => {
  const counts = new Map<string, number>()
  for (const key of keys) {
    const prefix = /^([a-z0-9-]+\.)(?=[a-z])/.exec(key)?.[1]
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1])
  return best && best[1] * 2 >= keys.length ? best[0] : null
}

/** A model id without the connection's prefix, for catalog matching; the request keeps the full id. */
export const withoutModelIdPrefix = (key: string, prefix: string | null) =>
  prefix && key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : key
