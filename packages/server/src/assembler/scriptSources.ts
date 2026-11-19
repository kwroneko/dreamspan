// Where regex scripts come from (ARCHITECTURE §15, "Regex scripts"), and the rewrites that run
// them on text as it's written (§12, "Rewrites"). Both are registries: a plugin adds a list of
// scripts, wraps or replaces one, or disables it, and does the same with a rewrite. ST 1.19
// runs its lists in this order: global, preset, then the character's (engine.js SCRIPT_TYPES),
// which is the built-ins' registration order.
import type { RegexScript } from "@dreamspan/shared/docs/regexScript.ts"
import type { ScriptScope, TextRewrite } from "@dreamspan/shared/regexScripts.ts"
import { Effect } from "effect"
import { type Assembly, AssemblySources, need, type SourceError } from "./pipeline.ts"
import type { CardInput } from "./types.ts"

export interface ScriptSource {
  readonly id: string
  readonly scope: ScriptScope
  /** The scripts that may run in this assembly, in order: none until the user allowed them, where that's asked. */
  readonly scripts: (assembly: Assembly) => Effect.Effect<ReadonlyArray<RegexScript>, SourceError, AssemblySources>
}

/** Rewriting text as it's written: a reply as it finishes, a message as it's sent or edited. */
export interface RewriteOptions {
  /** An edit: ST runs only the scripts marked to run on edits. */
  readonly edit: boolean
  /** Whose text it is: the card writing it (null: none), and who wrote it. */
  readonly speaker: string | null
  readonly writer: "human" | "model"
}

export interface MessageRewrite {
  readonly id: string
  /** Each text after this rewrite, with what changed it; the next rewrite gets these texts. */
  readonly run: (
    assembly: Assembly,
    items: ReadonlyArray<{ readonly text: string; readonly placement: number }>,
    options: RewriteOptions
  ) => ReadonlyArray<TextRewrite>
}

/** The side a text being written is on: its card's, else its writer's. */
export const rewriteSide = (assembly: Assembly, options: RewriteOptions): "user" | "assistant" => {
  const cast = need(assembly, "cast")
  if (cast.personas.some((card) => card.entity === options.speaker)) return "user"
  if (cast.characters.some((card) => card.entity === options.speaker)) return "assistant"
  return options.writer === "human" ? "user" : "assistant"
}

/**
 * The character whose scripts run (ST's `this_chid`): in a prompt, the speaker when the model
 * writes as a character, else the chat's one character; for text being written on the
 * model's side, its card; on the user's side, the chat's one character, as in ST's one-character
 * chats (a group has no current character when the user sends).
 */
const scriptCharacter = (assembly: Assembly): CardInput | null => {
  const cast = need(assembly, "cast")
  const only = cast.characters.length === 1 ? cast.characters[0]! : null
  const rewrite = assembly.request.rewrite
  if (rewrite) {
    if (rewriteSide(assembly, rewrite) === "user") return only
    // A reply recorded without a speaker is the turn's, as the cast stage resolved it.
    return (
      cast.characters.find((card) => card.entity === rewrite.speaker) ??
      (cast.speaker && !cast.personas.includes(cast.speaker) ? cast.speaker : null)
    )
  }
  return cast.speaker && !cast.personas.includes(cast.speaker) ? cast.speaker : only
}

export const builtinScriptSources: ReadonlyArray<ScriptSource> = [
  {
    id: "regex.global",
    scope: "global",
    // The user's own list: it runs without approval, as ST's global scripts do.
    scripts: () =>
      Effect.gen(function* () {
        const sources = yield* AssemblySources
        return sources.globalRegex ? yield* sources.globalRegex : []
      })
  },
  {
    id: "regex.preset",
    scope: "preset",
    scripts: (assembly) => {
      const { doc } = need(assembly, "preset")
      return Effect.succeed(doc.regex_approved ? doc.regex : [])
    }
  },
  {
    id: "regex.character",
    scope: "character",
    scripts: (assembly) => {
      const card = scriptCharacter(assembly)
      return Effect.succeed(card?.doc.regex_approved === true ? (card.doc.regex ?? []) : [])
    }
  }
]

/** The built-in rewrite: the compiled scripts with neither flag (`scripts` stage), as ST runs them. */
export const regexRewrite: MessageRewrite = {
  id: "rewrite.regex",
  run: (assembly, items, options) => assembly.scripts?.rewrite(items, options) ?? items.map(unchanged)
}

export const unchanged = (item: { readonly text: string }): TextRewrite => ({
  text: item.text,
  applied: [],
  failed: []
})
