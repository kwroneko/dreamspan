// Providers (owner, 2026-11-02: "Users should just be able to select something like 'Anthropic
// (AWS)' and know everything is being done according to what that needs, for caching and
// everything else"; 2026-11-07: "Isn't this just a provider and API type? Why wouldn't this be the
// first choice when setting up a new connection?"). A provider is the first choice for a new
// connection. It sets the API types offered (provider kinds), the default address, how the key
// signs requests, the cache layout and the documented cache contract; each is a default the user
// can change in the connection's advanced settings, and a connection stores only the changes.
//
// The definitions are data, registered in the server's provider registry (`providers`) and
// replaceable by id like every entry there. They're shared because the database workers resolve
// a chat's model too (assemblySources.ts), from the built-in definitions.
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
    keyOptional: false,
    auth: [
      { id: "api-key", label: "Bedrock API key", about: "A key made in the Bedrock console." },
      {
        id: "aws-sigv4",
        label: "AWS access key",
        about: "An IAM access key ID and secret access key. Requests are signed with them; the secret is never sent."
      }
    ],
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
    accounting: ["Caching is automatic; cached input is part of the input count."],
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
    defaults: { cacheBreakpoints: "auto", promptCacheKey: false },
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
export const findProvider = (
  providers: ReadonlyArray<ProviderDefinition>,
  id: string | null,
  kind: string,
  baseUrl: string | null = null
): ProviderDefinition | undefined => {
  const named = id === null ? undefined : providers.find((provider) => provider.id === id)
  if (named) return named
  if (kind === "openai-chat" && baseUrl === null) {
    const openai = providers.find((provider) => provider.id === "openai")
    if (openai) return openai
  }
  return providers.find((provider) => provider.defaultFor?.includes(kind))
}

/** The id a connection made without naming a provider gets. */
export const defaultProviderId = (kind: string, baseUrl: string | null) =>
  findProvider(builtinProviders, null, kind, baseUrl)?.id ?? kind

/** The settings in effect: the provider's defaults with the user's changes over them. */
export const resolveProviderSettings = (
  provider: ProviderDefinition | undefined,
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
  provider: Pick<ProviderDefinition, "baseUrl" | "regionUrl">,
  settings: ProviderSettings
): string | null =>
  provider.regionUrl && settings.region ? provider.regionUrl.replace("{region}", settings.region) : provider.baseUrl
