// Freezing the random and time macros of text kept as a template (DESIGN §5.6): a greeting
// draws them once, when its chat is made, and keeps the values. Runs on the main thread, as
// assembly will; expand()'s limits bound the work (ARCHITECTURE §10).
import type { CardFields } from "@rp/shared/macros/context.ts"
import { expand, type FrozenValues } from "@rp/shared/macros/expand.ts"
import { registerBuiltinMacros } from "@rp/shared/macros/builtins.ts"
import { makeMacroRegistry } from "@rp/shared/macros/registry.ts"
import { Effect, Scope } from "effect"

const registry = (() => {
  const made = makeMacroRegistry()
  Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(registerBuiltinMacros(made))))
  return made
})()

/**
 * Every value `text`'s volatile macros draw, keeping those in `known` (what the user saw in
 * the preview) and drawing the rest now. Names don't change which values are drawn. Text over
 * a limit has none: it shows as written.
 */
export const freezeTemplate = (text: string, card: CardFields, known: FrozenValues): FrozenValues => {
  const result = expand({
    text,
    origin: { kind: "message", macroMode: "template" },
    purpose: "display",
    registry,
    context: {
      names: { user: "User", char: "Character" },
      card,
      now: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    frozen: known,
    random: Math.random
  })
  return result._tag === "Expanded" ? result.frozen : {}
}
