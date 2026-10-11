// The built-in provider kinds, request transforms and response observers, registered
// through the provider registry exactly as a plugin's would be (spec/PLUGINS.md §3.1).
// Kinds are registered in picker order: Chat Completions first, then Anthropic (owner,
// 2026-10-10).
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { Effect, Layer } from "effect"
import { applyAnthropicBreakpoints } from "./breakpoints.ts"
import { piCatalogs, withCatalog } from "./catalog.ts"
import { modelListers } from "./modelLists.ts"
import { empty, ProviderRegistry, type ProviderKindEntry } from "./registry.ts"
import { builtinCostFormulas, usageObservers } from "./usage.ts"

const completions = openAICompletionsApi()

const kind = (
  entry: Omit<ProviderKindEntry, "listModels" | "catalog" | "acceptsFetch"> & {
    readonly list: keyof typeof modelListers
    readonly acceptsFetch?: boolean
  }
): ProviderKindEntry => {
  const { list, ...rest } = entry
  const catalog = piCatalogs[entry.piProvider]
  const self: ProviderKindEntry = {
    ...rest,
    acceptsFetch: entry.acceptsFetch ?? true,
    ...(catalog ? { catalog } : {}),
    listModels: (request) => Effect.flatMap(modelListers[list](request), (listed) => withCatalog(self, listed))
  }
  return self
}

export const builtinKinds: ReadonlyArray<ProviderKindEntry> = [
  kind({
    id: "openai-chat",
    label: "OpenAI Chat Completions",
    piProvider: "openai",
    api: "openai-completions",
    streams: completions,
    defaultBaseUrl: "https://api.openai.com/v1",
    keyOptional: true,
    list: "openai"
  }),
  kind({
    id: "anthropic",
    label: "Anthropic",
    piProvider: "anthropic",
    api: "anthropic-messages",
    streams: anthropicMessagesApi(),
    defaultBaseUrl: "https://api.anthropic.com",
    keyOptional: false,
    list: "anthropic"
  }),
  kind({
    id: "openai-responses",
    label: "OpenAI Responses",
    piProvider: "openai",
    api: "openai-responses",
    streams: openAIResponsesApi(),
    defaultBaseUrl: "https://api.openai.com/v1",
    keyOptional: false,
    list: "openai"
  }),
  kind({
    id: "openrouter",
    label: "OpenRouter",
    piProvider: "openrouter",
    api: "openai-completions",
    streams: completions,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyOptional: false,
    list: "openai"
  }),
  kind({
    id: "deepseek",
    label: "DeepSeek",
    piProvider: "deepseek",
    api: "openai-completions",
    streams: completions,
    defaultBaseUrl: "https://api.deepseek.com",
    keyOptional: false,
    list: "openai"
  }),
  kind({
    id: "google",
    label: "Google",
    piProvider: "google",
    api: "google-generative-ai",
    streams: googleGenerativeAIApi(),
    // pi-ai's Google adapter rejects a custom fetch, so it can't be routed through a proxy.
    acceptsFetch: false,
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyOptional: false,
    list: "google"
  })
]

/** The registry with every built-in registered for the layer's lifetime. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry
    for (const entry of builtinKinds) yield* registry.kinds.register(entry)
    // Explicit cache breakpoints (PROVIDERS §8), for Anthropic Messages so far.
    yield* registry.transforms.register({
      id: "anthropic-explicit-breakpoints",
      appliesTo: (target) => target.api === "anthropic-messages",
      transform: (payload, request) => {
        if (request.breakpoints.length > 0) applyAnthropicBreakpoints(payload, request.messages, request.breakpoints)
        return payload
      }
    })
    // Raw usage capture for the ledger (PROVIDERS §9.2), one observer per wire API.
    for (const [api, observe] of Object.entries(usageObservers)) {
      yield* registry.observers.register({ id: `usage:${api}`, appliesTo: (target) => target.api === api, observe })
    }
    // Cost formulas (PROVIDERS §9.3): the price table, then the provider's own figure.
    for (const formula of builtinCostFormulas) yield* registry.costs.register(formula)
  })
).pipe(Layer.provideMerge(empty))
