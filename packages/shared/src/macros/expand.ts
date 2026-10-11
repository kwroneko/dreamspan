// Macro expansion depends on where the text came from (DESIGN §5.6):
// - Card- and preset-sourced text expands. Lorebook entries and notes count as card text.
// - Text the user typed doesn't, unless that message's macro mode is "template".
// - Model output never does, except through the opt-in display rule, which changes only
//   what's shown: its variable writes are dropped.
// Card text stays unresolved in storage and is expanded against the context at its message's
// position, so `{{user}}` in a greeting follows a persona change until the message is sent.
// Non-deterministic macros are frozen: the result lists the values drawn, and passing them
// back makes a re-expansion identical, which keeps prompts deterministic and cacheable.
// Variable writes aren't performed: they come back as effects, in order.
// A text that hits a limit (MacroLimits) fails as a whole: nothing partial comes back.
import type { MacroMode } from "../chat.ts"
import type { MacroContext } from "./context.ts"
import { evaluateMacros, type FrozenValues, type MacroLimit, type MacroLimits, type MacroLookup } from "./engine.ts"
import type { VariableEffect } from "./variables.ts"

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
  readonly limits?: Partial<MacroLimits>
}

export interface Expanded {
  readonly _tag: "Expanded"
  readonly text: string
  /** Every non-deterministic value this expansion used, to store with the message. */
  readonly frozen: FrozenValues
  /**
   * Variable writes in order, for the caller to record as state events: chat variables as
   * `var.set`, with `value: null` for a deletion.
   */
  readonly effects: ReadonlyArray<VariableEffect>
  /** The variables after this text, for the next text expanded at the same position. */
  readonly variables: {
    readonly local: Readonly<Record<string, unknown>>
    readonly global: Readonly<Record<string, unknown>>
  }
}

export interface LimitExceeded {
  readonly _tag: "LimitExceeded"
  readonly limit: MacroLimit
}

export type ExpandResult = Expanded | LimitExceeded

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

export const expand = (request: ExpandRequest): ExpandResult => {
  const { local = {}, global = {} } = request.context.variables ?? {}
  const unchanged = { variables: { local, global }, effects: [] }
  if (!expands(request.origin)) return { _tag: "Expanded", text: request.text, frozen: {}, ...unchanged }
  const result = evaluateMacros(request.text, request)
  if (typeof result === "string") return { _tag: "LimitExceeded", limit: result }
  return { _tag: "Expanded", ...result, ...(request.origin.kind === "model" ? unchanged : {}) }
}
