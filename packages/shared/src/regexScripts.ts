// Where regex scripts come from and what they did to a text (ARCHITECTURE §9, §15). ST 1.19
// runs three lists, in this order: the account's global scripts, the preset's, then the
// character's ("scoped") scripts (extensions/regex/engine.js, SCRIPT_TYPES).
import { Schema } from "effect"
import { RegexScript } from "./docs/regexScript.ts"

export const ScriptScope = Schema.Literals(["global", "preset", "character"])
export type ScriptScope = typeof ScriptScope.Type

/** A script as the user knows it: its list, id and name. */
export const ScriptRef = Schema.Struct({ scope: ScriptScope, id: Schema.String, name: Schema.String })
export type ScriptRef = typeof ScriptRef.Type

/** A script that ran out of time or output, or threw, and was skipped: the text kept its earlier form. */
export const ScriptFailure = Schema.Struct({ script: ScriptRef, reason: Schema.String })
export type ScriptFailure = typeof ScriptFailure.Type

/**
 * What the scripts did to a version's text when it was written (a reply as it finished, a
 * message as it was sent or edited). `raw`/`rawReasoning`: the text before they changed it is
 * kept on the version (`RawVersionText`), never sent anywhere.
 */
export const VersionRewrite = Schema.Struct({
  applied: Schema.Array(ScriptRef),
  failed: Schema.Array(ScriptFailure),
  raw: Schema.Boolean,
  rawReasoning: Schema.Boolean
})
export type VersionRewrite = typeof VersionRewrite.Type

/** One text through the scripts: what it became, which scripts changed it, which were skipped. */
export const TextRewrite = Schema.Struct({
  text: Schema.String,
  applied: Schema.Array(ScriptRef),
  failed: Schema.Array(ScriptFailure)
})
export type TextRewrite = typeof TextRewrite.Type

/** What the server stores with a version it rewrote: the record, and the text before. */
export const StoredRewrite = Schema.Struct({
  applied: Schema.Array(ScriptRef),
  failed: Schema.Array(ScriptFailure),
  raw: Schema.NullOr(Schema.String),
  rawReasoning: Schema.NullOr(Schema.String)
})
export type StoredRewrite = typeof StoredRewrite.Type

/** At most this many global scripts. */
export const MAX_GLOBAL_SCRIPTS = 100

/** The global list: ids unique, as the editors address scripts by id, and at most MAX_GLOBAL_SCRIPTS. */
export const GlobalScripts = Schema.Array(RegexScript).check(
  Schema.isMaxLength(MAX_GLOBAL_SCRIPTS),
  Schema.makeFilter((scripts: ReadonlyArray<RegexScript>) =>
    new Set(scripts.map((script) => script.id)).size === scripts.length ? undefined : "two scripts have the same id"
  )
)

/** The account's global scripts and their revision, which a write must name. */
export const GlobalRegex = Schema.Struct({ scripts: GlobalScripts, revision: Schema.Int })
export type GlobalRegex = typeof GlobalRegex.Type
