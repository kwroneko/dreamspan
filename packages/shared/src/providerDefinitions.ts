// Providers (owner, 2026-11-02: "Users should just be able to select something like 'Anthropic
// (AWS)' and know everything is being done according to what that needs, for caching and
// everything else"; 2026-11-07: "Isn't this just a provider and API type? Why wouldn't this be the
// first choice when setting up a new connection?"). A provider is the first choice for a new
// connection. It sets the API types offered (provider kinds), the default address, how the key
// signs requests, the cache layout and the documented cache contract; each is a default the user
// can change in the connection's advanced settings, and a connection stores only the changes.
//
// The definitions are data, registered in the server's provider registry (`providers`) and
// replaceable by id like every entry there. The database workers also resolve a chat's model
// (assemblySources.ts), using the active definitions sent with each private worker request.
import type { ProviderSettings } from "./providers.ts"

interface Choice {
  readonly id: string
  readonly label: string
  readonly about: string
}

/** A setting the advanced section can show: a provider setting, or the connection's cache lifetime. */
type ProviderSettingName = keyof ProviderSettings | "cacheTtlS"

export interface ProviderDefinition {
  readonly id: string
  readonly label: string
  /** What it is, in the user's terms. */
  readonly about: string
  /** The API types it offers, as provider kinds (`id` is the kind); the first is the default. */
  readonly apis: ReadonlyArray<Choice>
  /** The default address; null when there's none and it must be entered. */
  readonly baseUrl: string | null
  readonly baseUrlExample?: string
  /** The address for a region (`{region}` replaced), for a provider whose address names one. */
  readonly regionUrl?: string
  /** Regions whose address doesn't follow `regionUrl`. */
  readonly regionUrls?: Readonly<Record<string, string>>
  /** How its regions are written: the form's help, an example and the pattern (a regex) one must match. */
  readonly regionFormat?: { readonly about: string; readonly example: string; readonly pattern: string }
  readonly keyOptional: boolean
  /** The ways a key signs requests (`ProviderSettings.auth`); the first is the default. */
  readonly auth: ReadonlyArray<Choice>
  /** The defaults of every setting that applies to it. */
  readonly defaults: ProviderSettings
  /** The settings its connections' advanced section shows, in order. */
  readonly settings: ReadonlyArray<ProviderSettingName>
  /** The provider whose documented cache contract applies (`cachePolicy.ts`); null where none is known. */
  readonly cacheContract: string | null
  /** How long its cache lasts, in the user's terms; null where no lifetime is documented. */
  readonly cacheLifetime: string | null
  /** How it counts and bills tokens, in the user's terms. */
  readonly accounting: ReadonlyArray<string>
  /** Kinds whose connections, made without naming a provider, use this one. */
  readonly defaultFor?: ReadonlyArray<string>
  /** It answers decision questions (spec/AGENTIC.md §7) and writes no replies. */
  readonly decisions?: boolean
}

const apiKey: Choice = { id: "api-key", label: "API key", about: "A key from the provider’s console." }

const cacheSettings: ReadonlyArray<ProviderSettingName> = [
  "cacheBreakpoints",
  "lookback",
  "maxMarkers",
  "minTokens",
  "cacheTtlS"
]

const chatCompletions: Choice = {
  id: "openai-chat",
  label: "Chat Completions",
  about: "The API most servers and gateways speak."
}
const responses: Choice = {
  id: "openai-responses",
  label: "Responses",
  about: "OpenAI’s newer API. It keeps reasoning while tools are used."
}

const awsRegions = {
  about: "The AWS Region your models run in, such as eu-west-1. It sets the address. Empty uses the one shown.",
  example: "eu-west-1",
  pattern: "^[a-z]{2}(?:-[a-z]+)+-\\d+$"
}

/** Bedrock's two kinds of key, the same for every model it serves. */
const bedrockAuth: ReadonlyArray<Choice> = [
  { id: "api-key", label: "Bedrock API key", about: "A key made in the Bedrock console." },
  {
    id: "aws-sigv4",
    label: "AWS access key",
    about: "An IAM access key ID and secret access key. Requests are signed with them; the secret is never sent."
  }
]

/**
 * The built-in providers, in picker order. The first is the form's default selection, and its
 * first API type the default API type: OpenAI Chat Completions (DESIGN §9, owner 2026-10-10).
 */
export const builtinProviders: ReadonlyArray<ProviderDefinition> = [
  {
    id: "openai",
    label: "OpenAI",
    about: "GPT models through OpenAI’s own API.",
    apis: [chatCompletions, responses],
    baseUrl: "https://api.openai.com/v1",
    keyOptional: false,
    auth: [{ ...apiKey, about: "A key from the OpenAI platform." }],
    // Caching is automatic; OpenAI routes cache reads by prompt_cache_key (liveapi F8).
    defaults: { cacheBreakpoints: "auto", promptCacheKey: true },
    settings: ["promptCacheKey", "minTokens", "cacheTtlS"],
    cacheContract: "openai",
    cacheLifetime: "5 minutes, or 30 minutes for GPT-5.5 and later",
    accounting: [
      "Cached input is part of the input count, billed at the cached price.",
      "Caching is automatic and best effort, so the estimate counts only what the last request read."
    ],
    defaultFor: ["openai-responses"]
  },
  {
    id: "anthropic",
    label: "Anthropic",
    about: "Claude through Anthropic’s own API.",
    apis: [{ id: "anthropic", label: "Messages", about: "Anthropic’s Messages API." }],
    baseUrl: "https://api.anthropic.com",
    keyOptional: false,
    auth: [{ ...apiKey, about: "A key from the Claude Console." }],
    // Anthropic reads a cached start up to about 20 blocks before a marker, so the default
    // placement's moving endpoint still reads the previous request's prefix (DESIGN §5.5).
    defaults: { cacheBreakpoints: "auto", lookback: true, maxMarkers: 4 },
    settings: cacheSettings,
    cacheContract: "anthropic",
    cacheLifetime: "5 minutes, or 1 hour with long retention",
    accounting: [
      "Cache reads and writes are counted apart from other input.",
      "Cache writes cost 1.25 times the input price, or twice it for the 1-hour cache."
    ],
    defaultFor: ["anthropic"]
  },
  {
    id: "anthropic-bedrock",
    label: "Anthropic (AWS Bedrock)",
    about: "Claude through Amazon Bedrock, in your AWS account.",
    apis: [
      {
        id: "anthropic-bedrock",
        label: "Messages on Bedrock",
        about: "Anthropic’s Messages API, as Bedrock serves it."
      }
    ],
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    regionUrl: "https://bedrock-runtime.{region}.amazonaws.com",
    regionFormat: awsRegions,
    keyOptional: false,
    auth: bedrockAuth,
    // Bedrock reads a cached prefix only at a marker position the previous request also marked
    // (no lookback; measured in reference-harness), so markers go at each reusable section and the
    // previous request's history marker is repeated.
    defaults: { auth: "api-key", cacheBreakpoints: "explicit", lookback: false, maxMarkers: 4 },
    settings: ["region", ...cacheSettings],
    cacheContract: "amazon-bedrock",
    cacheLifetime: "5 minutes, or 1 hour with long retention where the model offers it",
    accounting: [
      "Counted as Anthropic counts: cache reads and writes apart from other input.",
      "Prices are Bedrock’s for the model ID; regional IDs can cost more than global ones."
    ],
    defaultFor: ["anthropic-bedrock"]
  },
  {
    // Claude on Google Cloud's Vertex AI (vertex.ts): Anthropic's Messages API at the model's
    // rawPredict address, signed in with a service account. Google: caching "behaves as described
    // in the Anthropic documentation", so Anthropic's layout and lookback apply; 1-hour TTL except
    // on Claude 3.x. Source: Google's Claude prompt caching page and Anthropic's Vertex page.
    id: "anthropic-vertex",
    label: "Anthropic (Google Vertex)",
    about: "Claude through Google Cloud’s Vertex AI, in your Google Cloud project.",
    apis: [
      {
        id: "anthropic-vertex",
        label: "Messages on Vertex AI",
        about: "Anthropic’s Messages API, as Vertex AI serves it."
      }
    ],
    baseUrl: "https://aiplatform.googleapis.com",
    regionUrl: "https://{region}-aiplatform.googleapis.com",
    regionUrls: {
      global: "https://aiplatform.googleapis.com",
      us: "https://aiplatform.us.rep.googleapis.com",
      eu: "https://aiplatform.eu.rep.googleapis.com"
    },
    regionFormat: {
      about:
        "Where Google Cloud runs your requests: global (any region, the lowest price), us or eu (within that area), or one region such as us-east5. Newer models need global, us or eu. Empty uses global.",
      example: "us-east5",
      pattern: "^(?:global|us|eu|[a-z]+-[a-z]+\\d+)$"
    },
    keyOptional: false,
    auth: [
      {
        id: "gcp-service-account",
        label: "Service account key",
        about:
          "A service account’s JSON key file, with the Vertex AI User role. It signs a short-lived sign-in with Google; the key itself is never sent."
      }
    ],
    defaults: {
      auth: "gcp-service-account",
      region: "global",
      cacheBreakpoints: "auto",
      lookback: true,
      maxMarkers: 4
    },
    settings: ["region", "project", ...cacheSettings],
    cacheContract: "google-vertex",
    cacheLifetime: "5 minutes, or 1 hour with long retention",
    accounting: [
      "Counted as Anthropic counts: cache reads and writes apart from other input.",
      "Cache writes cost 1.25 times the input price, or twice it for the 1-hour cache; reads a tenth of it.",
      "Prices are Google’s. A us, eu or single region costs about 10% more than global for newer models."
    ],
    defaultFor: ["anthropic-vertex"]
  },
  {
    // OpenAI's models on Bedrock (bedrockOpenAI.ts): its runtime's OpenAI-compatible APIs, with
    // Bedrock's keys and its own cache. GPT-5.6 and later cache at `prompt_cache_breakpoint`
    // markers on the Responses API, read only at a position an earlier request also marked (a
    // request "reads the cache only if it starts with an entire earlier request"), so markers go
    // at each section and the previous history marker is repeated, as for Claude on Bedrock; the
    // automatic marker on the latest message takes one of the four writes. Earlier models, and
    // Chat Completions, cache automatically only (shims.ts). Source: AWS's prompt caching guide.
    id: "openai-bedrock",
    label: "OpenAI (AWS Bedrock)",
    about: "GPT models through Amazon Bedrock, in your AWS account.",
    apis: [
      {
        id: "openai-responses-bedrock",
        label: "Responses",
        about: "OpenAI’s Responses API, as Bedrock serves it. Only this one keeps cache markers."
      },
      {
        id: "openai-chat-bedrock",
        label: "Chat Completions",
        about: "OpenAI’s Chat Completions API, as Bedrock serves it. Its caching is automatic only."
      }
    ],
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
    regionUrl: "https://bedrock-runtime.{region}.amazonaws.com/openai/v1",
    regionFormat: awsRegions,
    keyOptional: false,
    auth: bedrockAuth,
    defaults: {
      auth: "api-key",
      cacheBreakpoints: "explicit",
      cacheMarker: "prompt_cache_breakpoint",
      lookback: false,
      maxMarkers: 4,
      // AWS's example sends one key across requests so they reach the same cache.
      promptCacheKey: true
    },
    settings: ["region", "cacheBreakpoints", "lookback", "maxMarkers", "minTokens", "promptCacheKey", "cacheTtlS"],
    cacheContract: "amazon-bedrock",
    cacheLifetime: "At least 30 minutes for GPT-5.6 and later; not documented for earlier models",
    accounting: [
      "Cached input is part of the input count. Cache reads are billed at the cached price.",
      "For GPT-5.6 and later, cache writes cost 1.25 times the input price. Earlier models charge nothing for writes.",
      "Model IDs name an inference profile, such as us. or global.; global ones cost less."
    ],
    defaultFor: ["openai-responses-bedrock", "openai-chat-bedrock"]
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    about: "Many providers’ models through one key.",
    apis: [{ ...chatCompletions, id: "openrouter" }],
    baseUrl: "https://openrouter.ai/api/v1",
    keyOptional: false,
    auth: [{ ...apiKey, about: "A key from OpenRouter." }],
    defaults: { cacheBreakpoints: "auto" },
    settings: ["cacheBreakpoints", "minTokens", "cacheTtlS"],
    cacheContract: "openrouter",
    cacheLifetime: "Depends on who serves the model: 5 minutes for Claude, 3 to 5 for Gemini",
    accounting: [
      "Costs are OpenRouter’s own figures for each request.",
      "For Gemini, OpenRouter reports the same tokens as both written and read."
    ],
    defaultFor: ["openrouter"]
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    about: "DeepSeek’s own API.",
    apis: [{ ...chatCompletions, id: "deepseek" }],
    baseUrl: "https://api.deepseek.com",
    keyOptional: false,
    auth: [{ ...apiKey, about: "A key from the DeepSeek platform." }],
    defaults: { cacheBreakpoints: "auto" },
    settings: ["cacheTtlS"],
    cacheContract: "deepseek",
    cacheLifetime: null,
    accounting: ["Caching is automatic; cache hits and misses are reported apart."],
    defaultFor: ["deepseek"]
  },
  {
    id: "google",
    label: "Google AI Studio",
    about: "Gemini through Google’s Gemini API.",
    apis: [{ id: "google", label: "Gemini API", about: "Google’s Gemini API." }],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyOptional: false,
    auth: [{ ...apiKey, about: "A key from Google AI Studio." }],
    defaults: { cacheBreakpoints: "auto" },
    settings: ["cacheTtlS"],
    cacheContract: "google",
    cacheLifetime: null,
    accounting: [
      "Caching is automatic; cache reads are counted apart from other input.",
      "Cache lifetime is unknown. This app doesn’t create saved caches."
    ],
    defaultFor: ["google"]
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible (custom)",
    about: "Any server that speaks OpenAI’s API: a local server, a gateway or another provider.",
    apis: [chatCompletions, responses],
    baseUrl: null,
    baseUrlExample: "http://localhost:8000/v1",
    keyOptional: true,
    auth: [{ ...apiKey, about: "The server’s key, if it takes one." }],
    defaults: { cacheBreakpoints: "auto", promptCacheKey: true },
    settings: ["promptCacheKey", "minTokens", "cacheTtlS"],
    // OpenAI's documented contract covers only OpenAI's own models (cachePolicy.ts), as served by
    // a router in front of OpenAI; a local server's models have none.
    cacheContract: "openai",
    cacheLifetime: null,
    accounting: ["Counted as the server reports usage; without a report, estimated from the text."],
    defaultFor: ["openai-chat"]
  },
  {
    id: "system-one",
    label: "Decision model (System-One)",
    about: "A model that answers decision questions, such as who speaks next. It writes no replies.",
    apis: [{ id: "system-one", label: "Decisions", about: "The System-One decision API." }],
    baseUrl: "https://openrouter.ai/api/alpha/decisions",
    keyOptional: true,
    auth: [{ ...apiKey, about: "The endpoint’s key; a self-hosted server may take none." }],
    defaults: {},
    settings: [],
    cacheContract: null,
    cacheLifetime: null,
    accounting: [],
    defaultFor: ["system-one"],
    decisions: true
  }
]

/**
 * The provider a connection uses: its own, or, for a connection made without naming one, the
 * provider that's the default for its kind. OpenAI Chat Completions with no address of its own
 * is OpenAI (an ST import of ST's OpenAI source); with one, a compatible server.
 */
export const findProvider = <A extends ProviderResolution>(
  providers: ReadonlyArray<A>,
  id: string | null,
  kind: string,
  baseUrl: string | null = null
): A | undefined => {
  const named = id === null ? undefined : providers.find((provider) => provider.id === id)
  if (named) return named
  if (kind === "openai-chat" && baseUrl === null) {
    const openai = providers.find((provider) => provider.id === "openai")
    if (openai) return openai
  }
  return providers.find((provider) => provider.defaultFor?.includes(kind))
}

/** Recognize OpenRouter on a custom Responses connection without retaining the address. */
export const isOpenRouterEndpoint = (baseUrl: string | null | undefined) =>
  baseUrl != null && URL.canParse(baseUrl) && new URL(baseUrl).hostname === "openrouter.ai"

/** The data needed to resolve a stored connection, including in a database worker. */
export type ProviderResolution = Pick<ProviderDefinition, "id" | "defaults" | "cacheContract" | "defaultFor">

/** The id a connection made without naming a provider gets. */
export const defaultProviderId = (kind: string, baseUrl: string | null) =>
  findProvider(builtinProviders, null, kind, baseUrl)?.id ?? kind

/** The settings in effect: the provider's defaults with the user's changes over them. */
export const resolveProviderSettings = (
  provider: Pick<ProviderDefinition, "defaults"> | undefined,
  changes: ProviderSettings
): ProviderSettings => ({ ...provider?.defaults, ...changes })

/** The changes that differ from the provider's defaults: what a connection stores. */
export const providerChanges = (
  provider: Pick<ProviderDefinition, "defaults"> | undefined,
  settings: ProviderSettings
): ProviderSettings => {
  const changes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings))
    if (value !== undefined && provider?.defaults[key as keyof ProviderSettings] !== value) changes[key] = value
  return changes as ProviderSettings
}

/** The region an AWS address names (`bedrock-runtime.eu-west-1.amazonaws.com`), or null. */
export const awsRegionOf = (url: string): string | null => {
  try {
    const host = new URL(url).hostname
    return /(?:^|\.)bedrock-runtime(?:-fips)?\.([a-z]{2}(?:-[a-z]+)+-\d+)\.amazonaws\.com$/.exec(host)?.[1] ?? null
  } catch {
    return null
  }
}

/** A provider's default address: its region's, where it has regions and one is set; null when none. */
export const providerBaseUrl = (
  provider: Pick<ProviderDefinition, "baseUrl" | "regionUrl"> &
    Partial<Pick<ProviderDefinition, "defaults" | "regionUrls">>,
  settings: ProviderSettings
): string | null => {
  const region = settings.region ?? provider.defaults?.region
  if (!provider.regionUrl || !region) return provider.baseUrl
  return provider.regionUrls?.[region] ?? provider.regionUrl.replace("{region}", region)
}
