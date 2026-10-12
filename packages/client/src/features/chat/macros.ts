// Macros in displayed text (DESIGN §5.6, ARCHITECTURE §10): a greeting keeps `{{user}}`
// and `{{char}}` unresolved, so it follows the chat's state. Only `expand()` decides what
// expands: a message's stored macro mode, never this code.
import { registerBuiltinMacros } from "@rp/shared/macros/builtins.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import { expand } from "@rp/shared/macros/expand.ts"
import { makeMacroRegistry } from "@rp/shared/macros/registry.ts"
import { Effect, Scope } from "effect"

/** The built-in macros, registered once for the page's lifetime. */
const registry = (() => {
  const made = makeMacroRegistry()
  Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(registerBuiltinMacros(made))))
  return made
})()

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

/** Text as shown: expanded when its origin says so, as written otherwise, or when a limit is hit. */
export const displayText = (
  text: string,
  macroMode: "template" | "verbatim",
  names: DisplayNames,
  card: CardFields = {}
) => {
  if (macroMode !== "template" || (!text.includes("{{") && !text.includes("<"))) return text
  const result = expand({
    text,
    origin: { kind: "message", macroMode },
    purpose: "display",
    registry,
    context: { names, card, now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    random: seeded(text)
  })
  return result._tag === "Expanded" ? result.text : text
}
