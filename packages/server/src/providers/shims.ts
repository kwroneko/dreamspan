// Compatibility shims (DESIGN §9, owner 2026-11-07: "specific models on specific providers can
// have their own compatibility shims"): what one provider kind refuses or needs for some of its
// models, registered per kind and model pattern in the provider registry's `shims`, and
// replaceable or disableable by id like every other entry. Never global: a shim names its kinds
// and the models it matches.
//
// A shim can set capabilities (prefill, thinking levels, tools, vision...), which refreshes and
// added models take over what the list and catalogs report, and can rewrite the final request
// payload (samplers, reasoning parameters, tools, message shape) after the registered transforms.
import type { FixedCapability, ModelUpstream } from "@rp/shared/providers.ts"
import type { RequestTarget } from "./registry.ts"

interface ShimRequest {
  readonly target: RequestTarget
}

export interface CompatShim {
  readonly id: string
  /** What it does, in the user's terms (the model page lists the shims a model gets). */
  readonly label: string
  /** The provider kinds it applies to (`openai-chat`, `openrouter`, …). */
  readonly kinds: ReadonlyArray<string>
  /** Matched on the model's key; patterns allow a router prefix (`acme.`, `vendor/`). */
  readonly model: RegExp
  /** Capabilities the provider imposes for the model, over the list's and catalogs'. */
  readonly capabilities?: Partial<Omit<ModelUpstream, "catalog" | "shims" | "fixed">>
  /** Capabilities a user edit can't change, because the provider refuses anything else. */
  readonly fixed?: ReadonlyArray<FixedCapability>
  /** Rewrites the final payload; returns it (the same object changed in place, or a new one). */
  readonly payload?: (payload: Record<string, unknown>, request: ShimRequest) => Record<string, unknown>
}

const shimApplies = (shim: CompatShim, kind: string, model: string) =>
  shim.kinds.includes(kind) && shim.model.test(model)

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The reasoning effort a payload asks for: Responses' `reasoning.effort`, Chat's `reasoning_effort`. */
const effortOf = (payload: Record<string, unknown>) =>
  (object(payload.reasoning)?.effort as string | undefined) ?? (payload.reasoning_effort as string | undefined)

const reasoning = (payload: Record<string, unknown>) => {
  const effort = effortOf(payload)
  return effort !== undefined && effort !== "none"
}

/** Capabilities the shims that apply give a model, and the fields they fix. */
const shimCapabilities = (shims: ReadonlyArray<CompatShim>, kind: string, model: string) => {
  const applied = shims.filter((shim) => shimApplies(shim, kind, model) && (shim.capabilities || shim.fixed))
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
  kind: string,
  key: string,
  upstream: ModelUpstream
): ModelUpstream => {
  const { shims: _shims, fixed: _fixed, ...base } = upstream
  const named = shims.filter((shim) => shimApplies(shim, kind, key))
  if (named.length === 0) return base
  const applied = shimCapabilities(shims, kind, key)
  return {
    ...base,
    ...applied?.capabilities,
    ...(applied?.capabilities.thinkingLevels
      ? { thinkingLevels: { ...base.thinkingLevels, ...applied.capabilities.thinkingLevels } }
      : {}),
    shims: named.map((shim) => ({ id: shim.id, label: shim.label })),
    ...(applied && applied.fixed.length > 0 ? { fixed: applied.fixed } : {})
  }
}

/** A listed model with the shims applied to its upstream. */
export const withShims = <M extends { readonly key: string; readonly upstream: ModelUpstream }>(
  shims: ReadonlyArray<CompatShim>,
  kind: string,
  model: M
): M => ({ ...model, upstream: shimmedUpstream(shims, kind, model.key, model.upstream) })

/** The payload rewrites of the shims that apply, in registration order. */
export const applyShims = (
  shims: ReadonlyArray<CompatShim>,
  payload: Record<string, unknown>,
  target: RequestTarget
): { readonly payload: Record<string, unknown>; readonly applied: ReadonlyArray<string> } => {
  const applied: Array<string> = []
  let current = payload
  for (const shim of shims) {
    if (!shim.payload || !shimApplies(shim, target.kind, target.model ?? "")) continue
    current = shim.payload(current, { target })
    applied.push(shim.id)
  }
  return { payload: current, applied }
}

/** The built-in shims, for what the live provider suite found (liveapi, 2026-11-07). */
export const builtinShims: ReadonlyArray<CompatShim> = [
  {
    // F7: "`top_p` is deprecated for this model."
    id: "claude-haiku-5-no-top-p",
    label: "Top P isn’t sent: this model refuses it.",
    kinds: ["anthropic", "openrouter"],
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
    kinds: ["openai-responses"],
    model: /(?:^|[/.])gpt-5\.[1-4](?:[-.]|$)/i,
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
    kinds: ["openai-chat"],
    model: /(?:^|[/.])gpt-5\.4(?:[-.]|$)/i,
    payload: (payload) => {
      if (Array.isArray(payload.tools) && payload.tools.length > 0 && reasoning(payload))
        payload.reasoning_effort = "none"
      return payload
    }
  },
  {
    // F11: "Reasoning is mandatory for this endpoint and cannot be disabled."
    id: "openrouter-gemini-4-argon-reasoning-on",
    label: "Reasoning stays on: this model can’t turn it off.",
    kinds: ["openrouter"],
    model: /^google\/gemini-4-argon/i,
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
    kinds: ["openrouter"],
    model: /^google\/gemini/i,
    capabilities: { prefill: "none" },
    fixed: ["prefill"]
  }
]
