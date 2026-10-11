// Macros are registered by id through a registry (spec/PLUGINS.md §8); the built-ins use
// it like any plugin will. A definition follows ST's MacroRegistry options
// (public/scripts/macros/engine/MacroRegistry.js): positional arguments, an optional list
// tail, strict arity, and delayed argument resolution for control flow.
import { Effect, type Scope } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import type { MacroContext } from "./context.ts"

export type ArgType = "string" | "integer" | "number" | "boolean"

export interface ArgSpec {
  readonly name: string
  /** Optional arguments must come after the required ones. */
  readonly optional?: boolean
  /** The accepted types; "string" when absent. */
  readonly type?: ArgType | ReadonlyArray<ArgType>
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
  /** Expands macros in text with the same context and state (for `delayArgResolution`). */
  readonly resolve: (text: string) => string
}

export interface MacroSpec {
  /** A letter, then letters, digits, "_" or "-"; or "//". Matched case-insensitively. */
  readonly name: string
  readonly aliases?: ReadonlyArray<string>
  readonly args?: ReadonlyArray<ArgSpec>
  /** Accept more arguments after `args`, as a list. */
  readonly list?: true | { readonly min: number; readonly max?: number }
  /**
   * With strict arguments (the default), a call with the wrong number or types of arguments
   * stays as written. Otherwise the handler runs anyway.
   */
  readonly strictArgs?: boolean
  /** The handler gets its arguments unexpanded, and expands what it needs with `resolve`. */
  readonly delayArgResolution?: boolean
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
