// Macros in displayed text (DESIGN §5.6, ARCHITECTURE §10): a greeting keeps `{{user}}`
// and `{{char}}` unresolved, so it follows the chat's state. Only `expand()` decides what
// expands: a message's stored macro mode and the explicit display-only opt-in.
import type { CardFields } from "@rp/shared/macros/context.ts"
import { expand, type FrozenValues } from "@rp/shared/macros/expand.ts"
import { macroRegistry as registry } from "../../macros.ts"

export { registry }

/** A draw that's the same on every render of the same text, so a re-render doesn't reroll. */
const seeded = (text: string) => {
  let seed = 0
  for (let i = 0; i < text.length; i++) seed = (Math.imul(seed, 31) + text.charCodeAt(i)) | 0
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DisplayNames {
  /** `{{user}}`: who the user plays. */
  readonly user: string
  /** `{{char}}`: the speaker of the text. */
  readonly char: string
}

/**
 * Text as shown, and the values its random and time macros drew: expanded when its origin
 * says so, as written otherwise, or when a limit is hit. `frozen` (a version's
 * `frozenMacros`) makes those macros show what they showed before (DESIGN §5.6).
 */
export const expandForDisplay = (
  text: string,
  macroMode: "template" | "verbatim",
  names: DisplayNames,
  card: CardFields = {},
  frozen: FrozenValues = {},
  displayRule = false
): { readonly text: string; readonly frozen: FrozenValues; readonly issue?: string } => {
  if ((macroMode !== "template" && !displayRule) || (!text.includes("{{") && !text.includes("<")))
    return { text, frozen: {} }
  const result = expand({
    text,
    origin: { kind: "message", macroMode },
    purpose: "display",
    displayRule,
    registry,
    context: { names, card, now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    frozen,
    random: seeded(text)
  })
  return result._tag === "Expanded"
    ? { text: result.text, frozen: result.frozen }
    : { text, frozen: {}, issue: `Display macros skipped: ${result.limit} limit reached.` }
}

/** Text as shown (`expandForDisplay`), without the values drawn. */
export const displayText = (
  text: string,
  macroMode: "template" | "verbatim",
  names: DisplayNames,
  card: CardFields = {},
  frozen: FrozenValues = {}
) => expandForDisplay(text, macroMode, names, card, frozen).text
