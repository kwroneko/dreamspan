// Our macro engine as the ST harness calls it: the seam where the engine plugs in.
//
// Until the macro engine (`packages/shared/src/macros/`) merges, `expandWithOurs` is a
// stub that knows only `{{user}}` and `{{char}}`, so the comparison runs and its
// differences don't fail the run. To plug the engine in, replace the body with a call to
// its expansion, giving it everything in `OurMacroInput`, and set `OUR_ENGINE_IS_STUB` to
// false.
import type { MacroContextInput, MacroOutcome } from "./macroVectors.ts"

export interface OurMacroInput {
  readonly text: string
  readonly context: MacroContextInput
  /** The open character's text fields, macros unexpanded (ST's `{{description}}` and so on). */
  readonly card: {
    readonly description: string
    readonly personality: string
    readonly scenario: string
    readonly first_mes: string
    readonly mes_example: string
    readonly creator_notes: string
  }
  /** Epoch milliseconds, and the time zone ST's page runs in. */
  readonly now: number
  readonly timeZone: string
  /** Seeded as the page's `Math.random` is, for each text. */
  readonly random: () => number
}

/** The engine's name in the report. */
export const OUR_ENGINE = "stub: {{user}} and {{char}} only"
export const OUR_ENGINE_IS_STUB = true

export const expandWithOurs = (input: OurMacroInput): MacroOutcome => ({
  output: input.text.replace(/\{\{(user|char)\}\}/gi, (_, name: string) =>
    name.toLowerCase() === "user" ? input.context.user : input.context.char
  ),
  local: { ...input.context.local },
  global: { ...input.context.global }
})
