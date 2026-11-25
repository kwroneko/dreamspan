// Compatibility shims (DESIGN §9, owner 2026-11-07: "specific models on specific providers can
// have their own compatibility shims"): what one provider refuses or needs for some of its
// models, registered per provider and model pattern in the provider registry's `shims`, and
// replaceable or disableable by id like every other entry. Never global: a shim names its providers
// and the models it matches.
//
// A shim can set capabilities (prefill, thinking levels, tools, vision...), which refreshes and
// added models take over what the list and catalogs report, and can rewrite the final request
// payload (samplers, reasoning parameters, tools, message shape) after the registered transforms.
//
// A shim can also name upstreams behind a router (OpenRouter providers, liveapi2): then it's a
// route rule, stored with the model's upstream and applied only when the model's routing pins one
// of them (`routedUpstream` in the shared resolution, so the assembly applies it at send and the
// model page shows it). Its payload rewrite applies when the request's own routing pins one.
import { type FixedCapability, type ModelUpstream, pinnedRoute, type RouteRule } from "@dreamspan/shared/providers.ts"
import type { RequestTarget } from "./registry.ts"
import type { ProviderError } from "@dreamspan/shared/errors.ts"
import { portableParameters } from "./toolSchemas.ts"

interface ShimRequest {
  readonly target: RequestTarget
}

export interface CompatShim {
  readonly id: string
  /** What it does, in the user's terms (the model page lists the shims a model gets). */
  readonly label: string
  /** The models it's for, in the user's terms: a provider's advanced section lists its shims by them. */
  readonly models: string
  /** The providers it applies to (`openai`, `anthropic-bedrock`, …; providerDefinitions.ts). */
  readonly providers: ReadonlyArray<string>
  /** The wire APIs it applies to; left out, all of the provider's. */
  readonly apis?: ReadonlyArray<string>
  /** Matched on the model's key. */
  readonly model: RegExp
  /** Capabilities the provider imposes for the model, over the list's and catalogs'. */
  readonly capabilities?: Partial<Omit<ModelUpstream, "catalog" | "shims" | "fixed">>
  /** Capabilities a user edit can't change, because the provider refuses anything else. */
  readonly fixed?: ReadonlyArray<FixedCapability>
  /** Rewrites the final payload; returns it (the same object changed in place, or a new one). */
  /** A refusal-specific rewrite: ordinary requests do not use this shim's payload. */
  readonly retryWhen?: (error: ProviderError) => boolean
  readonly payload?: (payload: Record<string, unknown>, request: ShimRequest) => Record<string, unknown>
  /**
   * The router's upstreams it's for (OpenRouter provider slugs, lower case, and their names).
   * Set, it applies only when the model's routing pins one of them.
   */
  readonly upstreams?: RouteRule["upstreams"]
  /** With `upstreams`: what goes wrong there, for a route that isn't pinned ("Prefill fails"). */
  readonly fails?: string
}

/** Where a shim is looked up: the connection's provider, and its wire API where known. */
export interface ShimTarget {
  readonly provider: string
  readonly api?: string
}

const modelMatches = (pattern: RegExp, model: string) =>
  (pattern.global || pattern.sticky ? new RegExp(pattern) : pattern).test(model)

const shimApplies = (shim: CompatShim, target: ShimTarget, model: string) =>
  shim.providers.includes(target.provider) &&
  (shim.apis === undefined || target.api === undefined || shim.apis.includes(target.api)) &&
  modelMatches(shim.model, model)

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The reasoning effort a payload asks for: Responses' `reasoning.effort`, Chat's `reasoning_effort`. */
const effortOf = (payload: Record<string, unknown>) =>
  (object(payload.reasoning)?.effort as string | undefined) ?? (payload.reasoning_effort as string | undefined)

const reasoning = (payload: Record<string, unknown>) => {
  const effort = effortOf(payload)
  return effort !== undefined && effort !== "none"
}

const routeShim = (shim: CompatShim) => shim.upstreams !== undefined

/** Capabilities the shims that apply give a model, and the fields they fix. */
const shimCapabilities = (shims: ReadonlyArray<CompatShim>, target: ShimTarget, model: string) => {
  const applied = shims.filter(
    (shim) => !routeShim(shim) && shimApplies(shim, target, model) && (shim.capabilities || shim.fixed)
  )
  if (applied.length === 0) return null
  const capabilities = Object.assign({}, ...applied.map((shim) => shim.capabilities ?? {})) as ModelUpstream
  const fixed = [...new Set(applied.flatMap((shim) => shim.fixed ?? []))]
  return { capabilities, fixed, shims: applied.map((shim) => ({ id: shim.id, label: shim.label })) }
}

/**
 * A model's upstream with the shims' capabilities over what the list and catalogs reported, and
 * the shims named, payload-only ones included, so the model page can list them.
 */
export const shimmedUpstream = (
  shims: ReadonlyArray<CompatShim>,
  on: ShimTarget | string,
  key: string,
  upstream: ModelUpstream
): ModelUpstream => {
  const { shims: _shims, fixed: _fixed, routes: _routes, ...base } = upstream
  const target = typeof on === "string" ? { provider: on } : on
  const matching = shims.filter((shim) => shimApplies(shim, target, key))
  const named = matching.filter((shim) => !routeShim(shim))
  const routes = matching.filter(routeShim).map((shim): RouteRule => ({
    id: shim.id,
    label: shim.label,
    upstreams: shim.upstreams!,
    fails: shim.fails ?? shim.label,
    ...(shim.capabilities ? { capabilities: shim.capabilities } : {}),
    ...(shim.fixed ? { fixed: shim.fixed } : {})
  }))
  if (matching.length === 0) return base
  const applied = shimCapabilities(shims, target, key)
  return {
    ...base,
    ...applied?.capabilities,
    ...(applied?.capabilities.thinkingLevels
      ? { thinkingLevels: { ...base.thinkingLevels, ...applied.capabilities.thinkingLevels } }
      : {}),
    ...(named.length > 0 ? { shims: named.map((shim) => ({ id: shim.id, label: shim.label })) } : {}),
    ...(applied && applied.fixed.length > 0 ? { fixed: applied.fixed } : {}),
    ...(routes.length > 0 ? { routes } : {})
  }
}

/** A listed model with the shims applied to its upstream. */
export const withShims = <M extends { readonly key: string; readonly upstream: ModelUpstream }>(
  shims: ReadonlyArray<CompatShim>,
  on: ShimTarget | string,
  model: M
): M => ({ ...model, upstream: shimmedUpstream(shims, on, model.key, model.upstream) })

/** A provider's shims, by the models they're for, for its connections' advanced section. */
export const providerRules = (shims: ReadonlyArray<CompatShim>, provider: string) =>
  shims
    .filter((shim) => shim.providers.includes(provider))
    .map((shim) =>
      shim.upstreams
        ? `${shim.models} through ${shim.upstreams.map((u) => u.name).join(" or ")}: ${shim.label}`
        : `${shim.models}: ${shim.label}`
    )

/** Whether a route rule's upstreams include the one a request's routing (`provider`) pins. */
const pinsRoute = (shim: CompatShim, payload: Record<string, unknown>) => {
  const route = pinnedRoute(object(payload.provider))
  return route !== null && shim.upstreams!.some((u) => u.slug === route)
}

/** The payload rewrites of the shims that apply, in registration order. */
export const applyShims = (
  shims: ReadonlyArray<CompatShim>,
  payload: Record<string, unknown>,
  target: RequestTarget,
  retryError?: ProviderError
): {
  readonly payload: Record<string, unknown>
  readonly applied: ReadonlyArray<string>
  readonly notices: ReadonlyArray<string>
} => {
  const applied: Array<string> = []
  const notices: Array<string> = []
  let current = payload
  for (const shim of shims) {
    const on = { provider: target.provider ?? target.kind, api: target.api }
    if (!shim.payload || !shimApplies(shim, on, target.model ?? "")) continue
    if (shim.retryWhen && (!retryError || !shim.retryWhen(retryError))) continue
    if (routeShim(shim) && !pinsRoute(shim, current)) continue
    const before = effortOf(current)
    current = shim.payload(current, { target })
    const after = effortOf(current)
    if (
      before !== after &&
      after === "none" &&
      typeof before === "string" &&
      /^(?:minimal|low|medium|high|xhigh|max)$/.test(before)
    )
      notices.push(
        `Reasoning effort “${before}” was changed to “none” for this request because this model refuses reasoning with tools. Your saved setting is unchanged.`
      )
    applied.push(shim.id)
  }
  return { payload: current, applied, notices }
}

/** Only explicit, pre-output compatibility refusals can request a single corrected attempt. */
export const hasRetryShim = (shims: ReadonlyArray<CompatShim>, target: RequestTarget, error: ProviderError) =>
  shims.some(
    (s) =>
      !s.upstreams &&
      shimApplies(s, { provider: target.provider ?? target.kind, api: target.api }, target.model ?? "") &&
      s.retryWhen?.(error)
  )

/** Takes Bedrock's `prompt_cache_breakpoint` markers out of a Responses or Chat Completions payload. */
const withoutBreakpoints = (payload: Record<string, unknown>) => {
  for (const items of [payload.input, payload.messages]) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const content = object(item)?.content
      if (!Array.isArray(content)) continue
      for (const block of content) delete object(block)?.prompt_cache_breakpoint
    }
  }
  return payload
}

/** The built-in shims, for what the live provider suite found (liveapi, 2026-11-07), and documented limits. */
export const builtinShims: ReadonlyArray<CompatShim> = [
  {
    id: "openrouter-openai-tool-schemas",
    label: "Tool schemas use the form this provider accepts; the app still checks every argument.",
    models: "OpenAI models",
    providers: ["openrouter"],
    apis: ["openai-completions"],
    model: /^openai\//,
    payload: (payload) => {
      if (!Array.isArray(payload.tools)) return payload
      for (const tool of payload.tools) {
        const fn = object(object(tool)?.function)
        const parameters = object(fn?.parameters)
        if (fn && parameters) fn.parameters = portableParameters(parameters)
      }
      return payload
    }
  },
  {
    // https://ai.google.dev/gemini-api/docs/thinking?generate-content=true
    id: "google-gemini-2.5-pro-thinking-on",
    label: "Thinking stays on: this model can’t turn it off.",
    models: "Gemini 2.5 Pro",
    providers: ["google"],
    apis: ["google-generative-ai"],
    model: /^(?:models\/)?gemini-2\.5-pro(?:-|$)/i,
    capabilities: { thinkingLevels: { off: null } },
    payload: (payload) => {
      const thinking = object(object(payload.config)?.thinkingConfig)
      if (thinking?.thinkingBudget === 0) thinking.thinkingBudget = 128
      return payload
    }
  },
  {
    // These models are absent from pi-ai 1.0.3's catalog; never infer their prices.
    id: "google-gemini-4-thinking-levels",
    label: "Thinking stays on, with low, medium or high effort.",
    models: "Gemini 4",
    providers: ["google"],
    apis: ["google-generative-ai"],
    model: /^(?:models\/)?gemini-4-/i,
    capabilities: {
      reasoning: true,
      vision: true,
      thinkingLevels: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }
    },
    fixed: ["reasoning", "thinkingLevels"],
    payload: (payload) => {
      const thinking = object(object(payload.config)?.thinkingConfig)
      // A saved raw override must not send Google's mutually exclusive controls.
      if (thinking?.thinkingLevel !== undefined) delete thinking.thinkingBudget
      else if (thinking?.thinkingBudget === 0) {
        delete thinking.thinkingBudget
        thinking.thinkingLevel = "LOW"
      }
      return payload
    }
  },
  {
    // F7: "`top_p` is deprecated for this model."
    id: "claude-haiku-5-no-top-p",
    label: "Top P isn’t sent: this model refuses it.",
    models: "Claude Haiku 5",
    providers: ["anthropic", "anthropic-bedrock", "anthropic-vertex", "openrouter"],
    // Also as Bedrock (`anthropic.claude-…`) and OpenRouter (`anthropic/claude-…`) name it.
    model: /(?:^|[/.])claude-haiku-5/i,
    payload: (payload) => {
      delete payload.top_p
      return payload
    }
  },
  {
    // F9: "Unsupported parameter: 'top_p' is not supported with this model." with any effort.
    id: "openai-responses-gpt-5.1-5.4-reasoning",
    label: "While it reasons, temperature and top P aren’t sent, and its reasoning summary is asked for.",
    models: "GPT-5.1 to 5.4 on Responses",
    // A compatible server may serve the same models.
    providers: ["openai", "openai-compatible"],
    apis: ["openai-responses"],
    model: /^gpt-5\.[1-4](?:[-.]|$)/i,
    payload: (payload) => {
      if (!reasoning(payload)) return payload
      delete payload.top_p
      delete payload.temperature
      const current = object(payload.reasoning) ?? {}
      payload.reasoning = { ...current, summary: current.summary ?? "auto" }
      return payload
    }
  },
  {
    // F10: "Function tools with reasoning_effort are not supported for gpt-5.4-nano in
    // /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to
    // 'none'." A request with tools (agent tools, a schema prefill) sends effort none there;
    // Responses takes both.
    id: "openai-chat-gpt-5.4-tools-no-effort",
    label: "Requests with tools run without reasoning here. A Responses connection keeps it.",
    models: "GPT-5.4 on Chat Completions",
    providers: ["openai", "openai-compatible"],
    apis: ["openai-completions"],
    model: /^gpt-5\.4(?:[-.]|$)/i,
    payload: (payload) => {
      if (Array.isArray(payload.tools) && payload.tools.length > 0 && reasoning(payload))
        payload.reasoning_effort = "none"
      return payload
    }
  },
  {
    id: "openai-chat-tool-reasoning-refusal",
    label: "If function tools refuse reasoning, retries once without reasoning.",
    models: "Models that refuse reasoning with function tools",
    providers: ["openai", "openai-compatible"],
    apis: ["openai-completions"],
    model: /.*/,
    retryWhen: (e) =>
      e.status === 400 &&
      !e.afterTokens &&
      !/mandatory|cannot be disabled/i.test(e.message) &&
      /Function tools with reasoning_effort are not supported/i.test(e.message) &&
      /reasoning_effort to ['"]none['"]/i.test(e.message),
    payload: (payload) => {
      if (
        Array.isArray(payload.tools) &&
        payload.tools.some((t) => object(t)?.type === "function") &&
        reasoning(payload)
      )
        payload.reasoning_effort = "none"
      return payload
    }
  },
  {
    // F11: "Reasoning is mandatory for this endpoint and cannot be disabled."
    id: "openrouter-gemini-4-argon-reasoning-on",
    label: "Reasoning stays on: this model can’t turn it off.",
    models: "Gemini 4 (all)",
    providers: ["openrouter"],
    model: /^google\/gemini-4-/i,
    capabilities: { thinkingLevels: { off: null } },
    payload: (payload) => {
      // Model settings and user-edited thinking levels can bypass the SDK's off mapping.
      if (payload.reasoning_effort === "none") delete payload.reasoning_effort
      const current = object(payload.reasoning)
      if (current?.effort === "none") {
        const { effort: _effort, ...rest } = current
        if (Object.keys(rest).length > 0) payload.reasoning = rest
        else delete payload.reasoning
      }
      return payload
    }
  },
  {
    // F13: a trailing assistant message is refused ("Provider returned error").
    id: "openrouter-gemini-no-prefill",
    label: "No prefill: this provider refuses one for Gemini. Continue asks the model to go on instead.",
    models: "Gemini",
    providers: ["openrouter"],
    model: /^google\/gemini/i,
    capabilities: { prefill: "none" },
    fixed: ["prefill"]
  },
  {
    // AWS: on bedrock-runtime, explicit prompt caching is "Responses API only" (each GPT model
    // card); Chat Completions caches automatically. Markers there are taken out.
    id: "bedrock-openai-chat-automatic-cache",
    label: "Cache markers aren’t sent: Bedrock caches these requests automatically.",
    models: "Every model on Chat Completions",
    providers: ["openai-bedrock"],
    apis: ["openai-completions"],
    model: /./,
    payload: withoutBreakpoints
  },
  {
    // AWS: "For OpenAI models prior to GPT-5.6 (…), Implicit Prompt Caching is automatic"; explicit
    // breakpoints are documented for GPT-5.6 and later only.
    id: "bedrock-openai-before-5.6-automatic-cache",
    label: "Cache markers aren’t sent: Bedrock caches these models automatically.",
    models: "GPT-5.5 and earlier, and GPT OSS",
    providers: ["openai-bedrock"],
    apis: ["openai-responses"],
    model: /(?:^|[./])gpt-(?:oss-|[1-4](?:[.-]|$)|5(?:\.[0-5])?(?:-|$))/i,
    payload: withoutBreakpoints
  },
  // Route rules (liveapi2, 2026-11-07): the same model on OpenRouter took a prefill on some
  // upstreams and not others. They apply when the model's routing pins the upstream.
  {
    // With reasoning on, the reply came back as reasoning and the text was empty; with it off,
    // a stray `[[...]]` token came first.
    id: "openrouter-deepseek-together-no-prefill",
    label: "No prefill through Together: the reply comes back empty. Continue asks the model to go on instead.",
    models: "DeepSeek",
    providers: ["openrouter"],
    model: /^deepseek\//i,
    upstreams: [{ slug: "together", name: "Together" }],
    fails: "Prefill fails",
    capabilities: { prefill: "none" },
    fixed: ["prefill"]
  },
  {
    // The reply started over, with or without reasoning.
    id: "openrouter-mimo-streamlake-no-prefill",
    label: "No prefill through StreamLake: the reply starts over. Continue asks the model to go on instead.",
    models: "MiMo",
    providers: ["openrouter"],
    model: /^xiaomi\/mimo/i,
    upstreams: [{ slug: "streamlake", name: "StreamLake" }],
    fails: "Prefill fails",
    capabilities: { prefill: "none" },
    fixed: ["prefill"]
  },
  {
    // Went on from the prefill in some runs and started over (often repeating it) in others.
    id: "openrouter-mimo-xiaomi-no-prefill",
    label:
      "No prefill through Xiaomi: the reply often starts over instead of going on. Continue asks the model to go on instead.",
    models: "MiMo",
    providers: ["openrouter"],
    model: /^xiaomi\/mimo/i,
    upstreams: [{ slug: "xiaomi", name: "Xiaomi" }],
    fails: "Prefill is unreliable",
    capabilities: { prefill: "none" },
    fixed: ["prefill"]
  }
]
