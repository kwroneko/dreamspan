// Freezing the random and time macros of text kept as a template (DESIGN §5.6): a greeting
// draws them once, when its chat is made, and keeps the values. Runs on the main thread, as
// assembly will; expand()'s limits bound the work (ARCHITECTURE §10).
import type { CardFields } from "@dreamspan/shared/macros/context.ts"
import { expand, type FrozenValues } from "@dreamspan/shared/macros/expand.ts"
import { registerBuiltinMacros } from "@dreamspan/shared/macros/builtins.ts"
import { makeMacroRegistry } from "@dreamspan/shared/macros/registry.ts"
import { FrozenMacros } from "@dreamspan/shared/chat.ts"
import { Effect, Schema, Scope } from "effect"

const registry = (() => {
  const made = makeMacroRegistry()
  Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(registerBuiltinMacros(made))))
  return made
})()

/**
 * Every value `text`'s volatile macros draw, keeping those in `known` (what the user saw in
 * the preview) that the macros could have drawn, and drawing the rest now. `names` are the
 * ones the text is shown with, since a value is checked against its arguments (`{{random}}`
 * among names). Text over a limit has none: it shows as written.
 */
export const freezeTemplate = (
  text: string,
  card: CardFields,
  names: { readonly user: string; readonly char: string },
  known: FrozenValues
): FrozenValues | null => {
  const result = expand({
    text,
    origin: { kind: "message", macroMode: "template" },
    purpose: "display",
    registry,
    context: {
      names,
      card,
      now: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    frozen: known,
    random: Math.random
  })
  if (result._tag !== "Expanded" || Object.keys(result.frozen).length === 0) return null
  // An expansion's draws always fit; this only guards the bounds.
  return Schema.is(FrozenMacros)(result.frozen) ? result.frozen : null
}
