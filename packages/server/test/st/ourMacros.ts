// Our macro engine as the ST harness calls it (`@rp/shared/macros/`, ARCHITECTURE §10), with
// the context ST's page has: the vector's names and variables, the fixture card and chat,
// ST's settings, the fixed clock.
import { registerBuiltinMacros } from "@rp/shared/macros/builtins.ts"
import type { CardFields, ChatMessage } from "@rp/shared/macros/context.ts"
import { expand } from "@rp/shared/macros/expand.ts"
import { makeMacroRegistry } from "@rp/shared/macros/registry.ts"
import { Effect, Scope } from "effect"
import type { MacroContextInput, MacroOutcome } from "./macroVectors.ts"

/** What ST's page holds besides the vector's own context. */
interface StEnvironment {
  readonly card: CardFields
  readonly messages: ReadonlyArray<ChatMessage>
  readonly model: string
  readonly maxContextTokens: number
  readonly maxResponseTokens: number
}

interface OurMacroInput {
  readonly text: string
  readonly context: MacroContextInput
  readonly environment: StEnvironment
  /** Epoch milliseconds, and the time zone ST's page runs in. */
  readonly now: number
  readonly timeZone: string
  /** Seeded as the page's `Math.random` is, for each text. */
  readonly random: () => number
}

/** The engine's name in the report. */
export const OUR_ENGINE = "@rp/shared/macros expand(), built-in macros"
export const OUR_ENGINE_IS_STUB = false

// The built-ins stay registered for the whole run: the scope is never closed.
const registry = makeMacroRegistry()
Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(registerBuiltinMacros(registry))))

/** Card text expands as ST expands a preset prompt; a limit reached is reported as the output. */
export const expandWithOurs = (input: OurMacroInput): MacroOutcome => {
  const { environment, context } = input
  const result = expand({
    text: input.text,
    origin: { kind: "preset" },
    purpose: "assembly",
    registry,
    context: {
      names: { user: context.user, char: context.char },
      variables: { local: context.local, global: context.global },
      card: environment.card,
      messages: environment.messages,
      now: input.now,
      timeZone: input.timeZone,
      model: environment.model,
      input: "",
      maxContextTokens: environment.maxContextTokens,
      maxResponseTokens: environment.maxResponseTokens,
      isMobile: false
    },
    random: input.random
  })
  if (result._tag === "LimitExceeded") return { output: `(limit: ${result.limit})`, local: {}, global: {} }
  return { output: result.text, local: { ...result.variables.local }, global: { ...result.variables.global } }
}
