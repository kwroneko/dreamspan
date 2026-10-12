// Macros are registered by id through a registry (spec/PLUGINS.md §8); the built-ins use
// it like any plugin will. A definition follows ST's MacroRegistry options
// (public/scripts/macros/engine/MacroRegistry.js): positional arguments, an optional list
// tail, strict arity, and delayed argument resolution for control flow.
import { Effect, type Scope } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import type { MacroContext } from "./context.ts"
import type { VariableScope } from "./variables.ts"

interface ArgSpec {
  readonly name: string
  /** Optional arguments must come after the required ones. */
  readonly optional?: boolean
  /** Only a whole number is accepted (ST's MacroValueType.INTEGER). */
  readonly integer?: true
}

export interface MacroCall {
  readonly name: string
  /** The positional arguments, up to the number declared. */
  readonly args: ReadonlyArray<string>
  /** The arguments after the declared ones, for list macros (`{{random::a::b::c}}`). */
  readonly list: ReadonlyArray<string>
  /** Flag symbols as written (`{{!?name}}`); ST parses them but only `#` and `/` do anything. */
  readonly flags: string
  /** Whether the last argument came from a scoped block (`{{name}}…{{/name}}`). */
  readonly isScoped: boolean
  /** Where the macro starts in the text being expanded. */
  readonly offset: number
  readonly context: MacroContext
  /** ST's env.contentHash: a hash of the text being expanded, for `{{pick}}`. */
  readonly contentHash: number
  /** Expands macros in text with the same context and state (for `delayArgResolution`). */
  readonly resolve: (text: string) => string
  /**
   * Expands card-sourced text (a card field) on its own, as ST's baseChatReplace does: card-
   * field macros inside it read as empty. `scope` names the field, for freezing.
   */
  readonly expandTemplate: (text: string, scope: string) => string
  /** The macro registered under a name, in any case. */
  readonly lookup: (name: string) => MacroEntry | undefined
  /** The macros at the top level of a text, as ST's extractMacroInfo reports them. */
  readonly macrosIn: (text: string) => ReadonlyArray<MacroInfo>
  /** A number in [0, 1), from the expansion's random source. */
  readonly random: () => number
  /** True the first time a key is seen in this expansion (for one-shot macros). */
  readonly once: (key: string) => boolean
  /** The chat's (`local`) and global variables. Writes come back as effects. */
  readonly variables: { readonly local: VariableScope; readonly global: VariableScope }
  /**
   * Counts work against the expansion's limit before doing it: characters about to be built,
   * or a die rolled. Past the limit the whole expansion fails.
   */
  readonly charge: (size: number) => void
}

export interface MacroInfo {
  readonly name: string
  readonly closing: boolean
  readonly argCount: number
  readonly start: number
  readonly end: number
}

export interface MacroSpec {
  /** A letter, then letters, digits, "_" or "-"; or "//". Matched case-insensitively. */
  readonly name: string
  readonly aliases?: ReadonlyArray<string>
  readonly args?: ReadonlyArray<ArgSpec>
  /** Accept any number of further arguments after `args`, as a list. */
  readonly list?: true
  /** The handler gets its arguments unexpanded, and expands what it needs with `resolve`. */
  readonly delayArgResolution?: boolean
  /**
   * Non-deterministic: evaluated once, then frozen and reused (DESIGN §5.6). `true` freezes
   * the value it produced; `"clock"` freezes the time it read, and its value is worked out
   * again from that time, with the arguments as they are then.
   */
  readonly volatile?: boolean | "clock"
  /**
   * For `volatile: true`: whether the macro could have produced `value` with these
   * arguments. A frozen value it couldn't have (arguments changed, or a stored value that
   * was never drawn) is drawn again. Without it, any frozen value is taken.
   */
  readonly accepts?: (call: MacroCall, value: string) => boolean
  /** Logical handler work from its arguments, charged for fresh and frozen values alike.
   * Volatile handlers put their work here rather than charging only when drawing. */
  readonly work?: (call: MacroCall) => number
  readonly handler: (call: MacroCall) => string
}

export interface MacroEntry extends MacroSpec {
  /** The lowercased name or alias it's registered under. */
  readonly id: string
  readonly minArgs: number
  readonly maxArgs: number
}

export type MacroRegistry = Registry<MacroEntry>

export const makeMacroRegistry = (): MacroRegistry => makeRegistry<MacroEntry>()

const NAME = /^(?:[a-zA-Z][\w-]*|\/\/)$/

/** Registers a macro under its name and each alias, for the scope's lifetime. */
export const registerMacro = (registry: MacroRegistry, spec: MacroSpec): Effect.Effect<void, never, Scope.Scope> =>
  Effect.suspend(() => {
    const names = [spec.name, ...(spec.aliases ?? [])]
    const bad = names.find((name) => !NAME.test(name))
    if (bad !== undefined) return Effect.die(new Error(`Invalid macro name "${bad}"`))
    const args = spec.args ?? []
    const firstOptional = args.findIndex((arg) => arg.optional)
    if (firstOptional >= 0 && args.slice(firstOptional).some((arg) => !arg.optional))
      return Effect.die(new Error(`Macro "${spec.name}": optional arguments must come last`))
    const minArgs = firstOptional < 0 ? args.length : firstOptional
    return Effect.forEach(names, (name) =>
      registry.register({ ...spec, id: name.toLowerCase(), minArgs, maxArgs: args.length })
    )
  }).pipe(Effect.asVoid)
