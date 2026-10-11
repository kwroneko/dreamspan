// Macro test vectors for the differential harness: each text is expanded by ST's engine and
// by ours, and the outputs and variables after it are compared.
//
// A small local list, until the macro engine's own vectors replace or extend it. ST
// evaluates every vector with the fixture character's chat open, so card macros read the
// fixture card. Pages run in UTC.

type VarValue = string | number

export interface MacroContextInput {
  readonly user: string
  readonly char: string
  readonly local: Readonly<Record<string, VarValue>>
  readonly global: Readonly<Record<string, VarValue>>
}

export interface MacroVector {
  readonly text: string
  /** Overrides of the default context. */
  readonly context?: Partial<MacroContextInput>
}

/** The fixed clock both engines see: 2026-01-02 15:04:05 UTC, a Friday. */
export const MACRO_NOW = Date.UTC(2026, 0, 2, 15, 4, 5)
/** Seeds `Math.random` before each vector, which `{{roll}}` draws from. */
export const MACRO_SEED = 1234

/**
 * Mulberry32: the same draws in the page and here. Its source is sent to the page, so the
 * body has no type annotations for Node's type stripping to blank out.
 */
export const seededRandom: (seed: number) => () => number = function (seed) {
  let state = seed >>> 0
  return function () {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const DEFAULT_MACRO_CONTEXT: MacroContextInput = { user: "Tobin", char: "Mira Vance", local: {}, global: {} }

export const MACRO_VECTORS: ReadonlyArray<MacroVector> = [
  { text: "{{user}} greets {{char}}." },
  { text: "{{USER}} and {{Char}}" },
  { text: "<USER> meets <BOT>." },
  { text: "{{user}} and {{char}}", context: { user: "Ada", char: "Bram" } },
  { text: "a{{newline}}b{{space}}c" },
  { text: "line one\n{{trim}}\nline two" },
  { text: "kept{{// a comment}}" },
  { text: "{{noop}}x{{noop}}" },
  { text: "{{reverse::abc}}" },
  { text: "\\{\\{user\\}\\}" },
  { text: "{{unknown::{{user}}}}" },
  { text: "{{getvar::mood}}", context: { local: { mood: "calm" } } },
  { text: "{{setvar::mood::wary}}{{getvar::mood}}" },
  { text: "{{addvar::count::2}}{{getvar::count}}", context: { local: { count: 1 } } },
  { text: "{{incvar::count}} {{decvar::count}}", context: { local: { count: 5 } } },
  { text: "{{getglobalvar::season}}", context: { global: { season: "spring" } } },
  { text: "{{setglobalvar::season::autumn}}{{getglobalvar::season}}" },
  { text: "{{hasvar::mood}}|{{hasvar::nothing}}", context: { local: { mood: "calm" } } },
  { text: "{{if {{getvar::mood}}}}yes{{else}}no{{/if}}", context: { local: { mood: "calm" } } },
  { text: "{{if {{getvar::missing}}}}yes{{else}}no{{/if}}" },
  { text: "{{description}}" },
  { text: "{{personality}} / {{scenario}}" },
  { text: "{{date}} {{time}} {{weekday}}" },
  { text: "{{isodate}} {{isotime}}" },
  { text: "{{roll:d6}} {{roll::2d20}}" }
]
