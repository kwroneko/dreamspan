// A message's start as a list row shows it (the shell's rows, the chats page, branch lists).
// The stored start is the message as written. A template message (a greeting) shows its macros
// replaced, as the chat shows it: `{{user}}` is the persona the fork plays, `{{char}}` the
// message's speaker, by the names the cards have now. Pure, so a reader worker can run it.
import { expand } from "@rp/shared/macros/expand.ts"
import { registerBuiltinMacros } from "@rp/shared/macros/builtins.ts"
import { makeMacroRegistry } from "@rp/shared/macros/registry.ts"
import { Effect, Scope } from "effect"

/** Who a template preview's names follow, by card id; null: nobody (`User`, `Character`). */
export interface PreviewMacro {
  readonly speaker: string | null
  readonly user: string | null
}

/** A card's name as prompts and the chat use it: its model name, else its name. */
export type PreviewNames = (id: string) => string | undefined

const registry = (() => {
  const made = makeMacroRegistry()
  Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(registerBuiltinMacros(made))))
  return made
})()

/** A draw that's the same each time for the same text. */
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

/**
 * The preview as shown. Text of a verbatim message (`macro` null), or without a macro, is
 * returned as written. The stored start is cut at 160 characters, so a macro cut in two is
 * dropped with the rest of the line it started rather than shown half-written. A limit
 * reached leaves the text as written, as the chat does.
 */
export const previewText = (text: string, macro: PreviewMacro | null, names: PreviewNames): string => {
  if (macro === null || !text.includes("{{")) return text
  const complete = text.replace(/\{\{[^}]*$/, "")
  const result = expand({
    text: complete,
    origin: { kind: "message", macroMode: "template" },
    purpose: "display",
    registry,
    context: {
      names: {
        user: (macro.user !== null && names(macro.user)) || "User",
        char: (macro.speaker !== null && names(macro.speaker)) || "Character"
      },
      card: {},
      now: Date.now(),
      timeZone: "UTC"
    },
    frozen: {},
    random: seeded(text)
  })
  return result._tag === "Expanded" ? result.text : text
}
