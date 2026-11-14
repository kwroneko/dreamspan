// How each Claude model family takes thinking on the Anthropic Messages wire (direct, Bedrock,
// Vertex), for models pi-ai's catalog doesn't list: the catalog's own entries already say it, and
// a model's saved settings or the catalog win over these. From Anthropic's model documentation
// (2026-11): Opus 4.7 and later, Sonnet 5 and later, Haiku 5 and later, and every Fable and
// Mythos model take adaptive thinking only. `thinking: {type: "enabled", budget_tokens}` is
// refused there ("`thinking.type.enabled` is not supported for this model. Use
// `thinking.type.adaptive` and `output_config.effort`"), and so are sampling parameters; several
// refuse `{type: "disabled"}` too, newer 5.x models think by default when it is left out. Opus 4.x defaults off. Opus 4.6 and Sonnet 4.6 take both forms, adaptive recommended (budgets deprecated).
// Earlier models (Haiku 4.5, Sonnet and Opus 4.5 and before) take budgets only: nothing here.
//
// The chat's reasoning effort setting (ThinkingLevel) becomes `output_config.effort` through
// `thinkingLevelMap` (pi-ai's adaptive path): minimal → low, low, medium, high, xhigh where the
// family has it (else high), max. None sends disabled where accepted, and omits the field
// on always-on families. Catalog compatibility fields retain precedence.

type Family = "opus" | "sonnet" | "haiku" | "fable" | "mythos"

/** The family and version a model id names: `claude-opus-4-8`, `us.anthropic.claude-sonnet-5-5-v1:0`, `claude-fable-5-2@2026…`. */
const claudeVersion = (key: string) => {
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?/i.exec(key)
  if (!match) return null
  return { family: match[1]!.toLowerCase() as Family, major: Number(match[2]), minor: Number(match[3] ?? 0) }
}

const atLeast = (v: { major: number; minor: number }, major: number, minor: number) =>
  v.major > major || (v.major === major && v.minor >= minor)

/** Adaptive only (budgets refused), adaptive preferred (both taken), or not known to take it. */
export const claudeThinkingForm = (key: string): "adaptive-only" | "adaptive" | null => {
  const v = claudeVersion(key)
  if (!v) {
    if (/claude-mythos-preview/i.test(key)) return "adaptive"
    // Known legacy naming; a new Claude family defaults to the newest request form.
    if (/claude-(?:[123](?:[-.]|$)|instant)/i.test(key)) return null
    return /claude-/i.test(key) ? "adaptive-only" : null
  }
  if (v.family === "fable" || v.family === "mythos") return "adaptive-only"
  if (atLeast(v, 4, 7)) return "adaptive-only"
  if ((v.family === "opus" || v.family === "sonnet") && v.major === 4 && v.minor === 6) return "adaptive"
  return v.major <= 4 && v.minor <= 5 ? null : "adaptive-only"
}

/**
 * The pi-ai model fields for a Claude model on `anthropic-messages`, or null for another API or
 * a model this doesn't know: `compat` to merge under the model's own, and the effort mapping
 * when the model has none.
 */
export const claudeThinkingDefaults = (
  api: string,
  key: string
): {
  readonly compat: Readonly<Record<string, unknown>>
  readonly thinkingLevelMap: Readonly<Record<string, string | null>>
} | null => {
  if (api !== "anthropic-messages") return null
  const form = claudeThinkingForm(key)
  if (!form) return null
  // xhigh came with Opus 4.7; the 4.6 models stop at high, then max.
  const xhigh = form === "adaptive-only"
  const v = claudeVersion(key)
  const canDisable =
    v &&
    ((v.family === "opus" && v.major === 4) ||
      (v.family === "sonnet" && v.major === 5 && v.minor === 0) ||
      (v.family === "sonnet" && v.major === 4))
  return {
    compat:
      form === "adaptive-only"
        ? { forceAdaptiveThinking: true, supportsTemperature: false }
        : { forceAdaptiveThinking: true },
    thinkingLevelMap: {
      ...(!canDisable ? { off: null } : {}),
      minimal: "low",
      xhigh: xhigh ? "xhigh" : "high",
      max: "max"
    }
  }
}
