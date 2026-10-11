// Macro expansion depends on where the text came from (DESIGN §5.6):
// - Card- and preset-sourced text expands. Lorebook entries and notes count as card text.
// - Text the user typed doesn't, unless that message's macro mode is "template".
// - Model output never does, except through the opt-in display rule.
// Card text stays unresolved in storage and is expanded against the context at its message's
// position, so `{{user}}` in a greeting follows a persona change until the message is sent.
// Non-deterministic macros are frozen: the result lists the values drawn, and passing them
// back makes a re-expansion identical, which keeps prompts deterministic and cacheable.
import type { MacroMode } from "../chat.ts"
import type { MacroContext } from "./context.ts"
import { evaluateMacros, type FrozenValues, type MacroLookup } from "./engine.ts"

export type TextOrigin =
  | { readonly kind: "card" }
  | { readonly kind: "preset" }
  | { readonly kind: "user"; readonly macroMode: typeof MacroMode.Type }
  | { readonly kind: "model"; readonly displayRule: boolean }

export interface ExpandRequest {
  readonly text: string
  readonly origin: TextOrigin
  readonly registry: MacroLookup
  readonly context: MacroContext
  /** Values from an earlier expansion of this text (the message's `frozen_macros`). */
  readonly frozen?: FrozenValues
  /** The source of new draws, in [0, 1). */
  readonly random: () => number
}

export interface ExpandResult {
  readonly text: string
  /** Every non-deterministic value this expansion used, to store with the message. */
  readonly frozen: FrozenValues
}

const expands = (origin: TextOrigin) => {
  switch (origin.kind) {
    case "card":
    case "preset":
      return true
    case "user":
      return origin.macroMode === "template"
    case "model":
      return origin.displayRule
  }
}

export const expand = (request: ExpandRequest): ExpandResult =>
  expands(request.origin) ? evaluateMacros(request.text, request) : { text: request.text, frozen: {} }
